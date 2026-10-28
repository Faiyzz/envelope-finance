# TD-06 — Internal Loans

**URD coverage:** §9 (FR-LOAN-01…35), FR-LED-03 (Own funds), FR-TXN-04 / FR-LOAN-06 borrow-on-shortfall flow, tests 21–28, INV-5, INV-6.
**Depends on:** TD-01 (verifier §6.3, postings), TD-04 (envelope rules), TD-05 (pipeline, pending-expense resume). **Used by:** TD-07 (needs-attention → borrow), TD-09 (exclusion), TD-10.

---

## 1. Model

A loan is a *named relationship* + two kinds of ledger rows. **No money amount, date, remaining or status is stored on the `loans` row** (TD-D2) — they are derived, so they can never disagree with the ledger (FR-LOAN-33, INV-4).

- `loan` transaction: `envelope_id` = **lender**, `counterpart_envelope_id` = **borrower**, `loan_id`. Lender −A, borrower +A, Total unchanged (INV-5).
- `loan_repayment` transaction: `envelope_id` = **borrower** (payer), `counterpart_envelope_id` = **lender**, same `loan_id`. Borrower −A, lender +A.
- Both envelopes are `mine` (FR-LOAN-02): app check + DB trigger `tx_check_refs`.

### 1.1 Schema (migration `0007_loans.sql`)
```sql
CREATE TABLE loans (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lender_envelope_id UUID NOT NULL,
  borrower_envelope_id UUID NOT NULL,
  note TEXT CHECK (char_length(note) <= 500),
  deleted_at TIMESTAMPTZ,                                   -- soft delete with its loan tx (restorable 30 d)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, lender_envelope_id)   REFERENCES envelopes (user_id, id),
  FOREIGN KEY (user_id, borrower_envelope_id) REFERENCES envelopes (user_id, id),
  CHECK (lender_envelope_id <> borrower_envelope_id)
);
ALTER TABLE transactions
  ADD CONSTRAINT fk_tx_loan FOREIGN KEY (user_id, loan_id) REFERENCES loans (user_id, id)
  DEFERRABLE INITIALLY DEFERRED;                            -- loan row & loan tx are inserted in one txn
-- exactly one live 'loan' tx per loan:
CREATE UNIQUE INDEX uq_loan_one_origin ON transactions (loan_id) WHERE type = 'loan' AND deleted_at IS NULL;
-- the tx envelopes must match the loan row: enforced in tx_check_refs extension (lender/borrower orientation)
```
Trigger extension (in `tx_check_refs`): for `loan`: `(envelope_id, counterpart) = (lender, borrower)`; for `loan_repayment`: `(envelope_id, counterpart) = (borrower, lender)` of the referenced loan.

### 1.2 `loan_state` view (derived truth)
```sql
CREATE VIEW loan_state AS
SELECT l.user_id, l.id AS loan_id, l.lender_envelope_id, l.borrower_envelope_id, l.note,
       o.id AS origin_tx_id, o.amount_paisa AS original_paisa, o.occurred_on AS loan_date,
       COALESCE(r.repaid, 0)::bigint AS repaid_paisa,
       (o.amount_paisa - COALESCE(r.repaid, 0))::bigint AS remaining_paisa,
       CASE WHEN o.amount_paisa - COALESCE(r.repaid, 0) = 0 THEN 'paid' ELSE 'active' END AS status,
       r.last_repaid_on AS paid_on                -- meaningful when status = 'paid'
FROM loans l
JOIN transactions o ON o.loan_id = l.id AND o.type = 'loan' AND o.deleted_at IS NULL
LEFT JOIN LATERAL (SELECT SUM(amount_paisa) AS repaid, MAX(occurred_on) AS last_repaid_on
                   FROM transactions x WHERE x.loan_id = l.id AND x.type = 'loan_repayment' AND x.deleted_at IS NULL) r ON TRUE
WHERE l.deleted_at IS NULL;

CREATE VIEW envelope_loan_totals AS
SELECT user_id, borrower_envelope_id AS envelope_id, SUM(remaining_paisa) AS borrowed_paisa, 0::bigint AS loaned_out_paisa
  FROM loan_state WHERE status='active' GROUP BY 1,2
UNION ALL
SELECT user_id, lender_envelope_id, 0, SUM(remaining_paisa) FROM loan_state WHERE status='active' GROUP BY 1,2;
-- consumers SUM() again by (user_id, envelope_id)
```
`Borrowed(env)`, `LoanedOut(env)` per URD §4.3 come from here. `paid_at` of the URD is `paid_on` (date of the settling repayment).

## 2. Pure domain (`domain/loans`)

```ts
remaining(original: Paisa, repayments: Paisa[]): Paisa
allocateRepayAll(loans: {id, loanDate, remaining}[], borrowerBalance: Paisa): Array<{ loanId; amount: Paisa }>  // oldest first, stops when money or loans run out
ownFunds(balance: Paisa, borrowed: Paisa): Paisa            // may be negative; NOT clamped
validateLoanInput(...)                                      // lender ≠ borrower, amount>0, dates
```
`ownFunds` may be negative (FR-LED-03/D12). `domain/money.sub` must not throw on negatives (TD v1.0 `subMoney` did).

## 3. Actions

### 3.1 `createLoan` (FR-LOAN-01…05)
```ts
{ idempotencyKey, lenderEnvelopeId, borrowerEnvelopeId, amount, date?, note?, resume?: ResumeToken }
```
Within `withUserWrite`:
1. Both envelopes active & `mine`, distinct (FR-LOAN-02/03) — messages: "Money held for Ahmed can't be lent out.", "Pick two different envelopes."
2. Date ≤ today, ≥ 2000-01-01.
3. Insert `loans` row, insert `loan` tx (`loan_id`), `touch(lender, borrower, loan)`.
4. Verifier: lender balance at that point ≥ 0 after the loan (INV-2) → else `InsufficientFunds` with message "Personal has only 3,000. Add money to Personal first." and `actions:[add_money(lender)]` (FR-LOAN-03). Loan verifier (§6.3 TD-01).
5. Response: `{ loan: LoanView, effects: [{envelope:'Personal', before, after}, {envelope:'Home', …}], totalUnchanged: true }` → confirmation text "Personal 45,000 (−5,000), Home 5,000 (+5,000). Total unchanged." (FR-LOAN-04). Server computes the effect lines.
6. Multiple concurrent loans between the same pair, including opposite directions, are independent rows; **no netting** (FR-LOAN-05; D3).

### 3.2 `repayLoan` (FR-LOAN-10, 11, 13, 14)
```ts
{ idempotencyKey, loanId, amount, date? }
```
Checks (friendly pre-checks; verifier authoritative):
- amount > 0; `amount ≤ remaining` (overpayment rejected, never becomes a reverse loan — FR-LOAN-13): "Only 2,000 is still owed on this loan."
- `amount ≤ borrower balance at that point` → `InsufficientFunds`: "Home has only 1,500 to repay with." (+`add_money(borrower)`).
- `date ≥ loan_date` and `≤ today` (FR-LOAN-14).
Insert `loan_repayment`; status/`paid_on` derive automatically. When the repayment settles the loan, the response includes `settled:true` (UI plays a success state, FR-LOAN-10).

### 3.3 `repayAll` (FR-LOAN-12)
`{ idempotencyKey, borrowerEnvelopeId, lenderEnvelopeId, date? }`: load active loans for that ordered pair sorted by `(loan_date, created)`; `allocateRepayAll(loans, borrowerBalance)`; insert one repayment per loan with a positive allocation (partial for the last one if money runs out); single verification. Returns the per-loan breakdown. If balance is 0 → `InsufficientFunds`.

### 3.4 Edit (FR-LOAN-30)
`updateLoan({ loanId, version, note?, date?, amount?, lenderEnvelopeId?, borrowerEnvelopeId? })` — `version` = the origin tx's `version`:
- `note` freely (updates `loans.note`).
- `date`, `amount` update the origin tx; verifier covers: date after an existing repayment ⇒ loan verifier violation ("A repayment on 8 Oct comes before this date"); `amount` below repaid ⇒ violation ("5,000 has already been repaid, so the loan can't be less than that"); lender balance timeline re-verified.
- Changing lender/borrower: allowed only when the loan has no repayments (else `RULE_VIOLATION`), re-validates ownership/active rules.

### 3.5 Delete / restore (FR-LOAN-31, 32)
- `deleteLoan(loanId)`: allowed only when **no live repayments**; otherwise `RULE_VIOLATION`: "This loan has 2 repayments. Delete those first." (the verifier would also block it). Soft-deletes the `loans` row **and** its origin tx together; both restorable for 30 d via `restoreLoan` (restores both, then verifies).
- `deleteRepayment(txId)`: soft delete; loan reopens automatically (`status` derived); verifier ensures no violation.
- Dry-run preview is available for both (TD-05 §4).

### 3.6 Loan-linked transactions in generic UI (FR-LOAN-33)
Generic edit/delete of `loan`/`loan_repayment` returns `RULE_VIOLATION{USE_LOANS_UI}`; detail screen shows "Open loan".

## 4. Borrow-on-shortfall flow (FR-LOAN-06, URD test 28)

Trigger: any action returning `INSUFFICIENT_FUNDS` for a `mine` envelope includes `actions:[{kind:'borrow', borrowerEnvelopeId, shortfall}]`.

Client protocol (`lib/pending-intent.ts`):
1. The failed form (expense *or* a recurring needs-attention item) is saved as a **PendingIntent** `{ id, kind, payload (incl. original idempotencyKey), returnTo }` in `sessionStorage` (survives navigation/refresh within the tab).
2. Navigate to **Create loan** with the loan form pre-filled: borrower = short envelope, amount = shortfall (user may increase), lender picker excludes ineligible envelopes and shows each lender's balance, those with balance < shortfall disabled with reason.
3. After `createLoan` succeeds, route back to `returnTo` with `?resume=<intentId>`; the original form is **restored with all original values** and is re-submitted automatically when the user confirms (one tap "Save expense") — using the original idempotency key so a double-return can't duplicate.
4. If the pending expense now fails for another reason (e.g. user changed amount), normal error handling shows.
For recurring needs-attention items, "Borrow from another envelope" creates the loan then calls `retryOccurrence(occurrenceId)` (TD-07 §5).

## 5. Display rules

- **Own funds** (FR-LED-03): `ownFunds = balance − borrowed`. If `< 0`: neutral informational note (info icon, no red): "Home holds 2,000 but owes 5,000 to Personal." When several lenders: "…owes 5,000 to Personal and 1,000 to Savings."
- Dashboard chips (FR-LOAN-22): borrower "Owes 5,000", lender "Owed 5,000" (aggregate). Envelope detail sections "Borrowed" / "Loaned out" (FR-LOAN-21) list loans with remaining, progress, and a **Repay** button on the borrower side only.
- **Loans screen** (`/loans`, FR-LOAN-20): tabs Active / Paid; rows "Personal → Home", original, repaid, remaining, date, progress bar (`role=progressbar`), tap → loan detail with the repayment timeline (FR-LOAN-15). Paid loans remain in both envelopes' histories.
- Loan transactions appear in lists with a loan chip; excluded from spending/income analytics (INV-6/FR-LOAN-35) and shown in envelope "This month" under a separate "Loans" line.

## 6. Read models
```ts
listLoans(userId, { status: 'active'|'paid', envelopeId? }): LoanRow[]       // from loan_state, newest first
getLoan(userId, id): { loan: LoanRow; repayments: RepaymentRow[]; originTx: TxView }
```
`LoanRow = { id, lender:{id,name,icon}, borrower:{…}, original, repaid, remaining, status, loanDate, paidOn?, note }`.

## 7. Edge cases (explicit)
- Borrower spends the borrowed money → own funds negative; repayment limited by actual balance (test 24).
- Archived envelope with active loans blocked (TD-04 §3.3); a *paid* loan does not block archive.
- Loan dated before lender had the funds → verifier rejects with the first violating date.
- Delete the lender's funding income after a loan exists → verifier (envelope balance) rejects; message names the loan outflow as culprit.
- Deleting then restoring a loan after a repayment was *also* deleted/restored: restore order enforced by the loan verifier (repayment restore fails until the loan is restored: "Restore the loan first").
- Zero-amount, same envelope, other-owned envelope: rejected at Zod/DB.
- Import (TD-11): `loans` without exactly one origin tx or with orphan repayments is rejected.

## 8. Tests owned (URD §21)
21 (boundaries, same envelope, archived party), 22 (Total unchanged; chips), 23 (partial, full→Paid, overpay, repay>balance, before loan date), 24 (own funds negative note, repay limited), 25 (delete repayment reopens; delete loan with repayments blocked; amount below repaid blocked), 26 (opposite-direction independence), 27 (analytics exclusion), 28 (shortfall → borrow → resume → saved once, with original values), plus: repayAll allocation order & partial last, DB trigger rejects mismatched envelopes, concurrent repayments cannot exceed remaining.

## 9. Acceptance
Reference scenario step 5 (loan Personal→Home 5,000, expense 5,000 succeeds, Own funds −5,000 note) and step 6 (repay 5,000 → loan Paid, Personal restored) pass; deleting any single ledger row involved in a loan either succeeds with consistent derived state or fails with a named reason — never leaves `loan_state` inconsistent (property test).
