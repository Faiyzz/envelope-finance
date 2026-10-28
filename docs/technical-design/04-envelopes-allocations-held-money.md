# TD-04 — Envelopes, Allocation Flows & Held Money

**URD coverage:** §8 (FR-ENV-01…10, FR-ALLOC-01…05), "Held for Others" flows (§4.2 `external_*`, FR-TXN-11/12/13, test 19–20), savings envelopes (§5), Quick actions "Record/Return Held Money" (§11.3), envelope detail (§11.4).
**Depends on:** TD-00, TD-01 (schema, verifier), TD-06 (loan chips). **Used by:** TD-05, TD-07, TD-09, TD-10.

---

## 1. Concepts recap
- Envelope `owner_type`: `mine` (counts in Your Money) or `other` (Held for Others, named person). `kind`: `standard` | `savings` (presentation only + optional goal).
- Balances always derived (`envelope_balances`, TD-01 §5.1). Envelope rows contain **no** balance column.
- Types operated here: `allocation`, `deallocation`, `transfer`, `external_deposit`, `external_withdrawal` (+ archive flows that create `deallocation`/`external_withdrawal`).

## 2. Data
Table `envelopes` is defined in TD-01 §4 (incl. `goal_amount_paisa`, partial unique active-name index, owner-name check, immutable owner type trigger). Additional read model:

```sql
CREATE VIEW envelope_stats AS      -- per envelope; used by cards/detail (all "mine"/"other" filtering done by caller)
SELECT e.user_id, e.id AS envelope_id,
  eb.balance_paisa,
  (SELECT count(*) FROM transactions t WHERE t.user_id=e.user_id AND t.deleted_at IS NULL
      AND (t.envelope_id = e.id OR t.counterpart_envelope_id = e.id)) AS tx_count
FROM envelopes e JOIN envelope_balances eb ON eb.envelope_id = e.id;
```
Loan figures (`borrowed_paisa`, `loaned_out_paisa`) come from `loan_state` (TD-06 §2) joined in the read function.

**"This month" (FR-ENV-09)** for envelope E in month M (user-local `occurred_on`):
- `added` = Σ of ledger postings to E where `tx_type IN ('allocation','income' [splits],'external_deposit','transfer' [dest], 'loan' [dest], 'adjustment'>0)`; the loan/transfer components are returned as separate fields so the UI can show "Loans" on its own line (FR-LOAN-35). `loan_repayment` received (lender side) goes to `repaidIn`.
- `spent` = Σ `expense`; `returned` = Σ `external_withdrawal` (shown as "returned", not spent).
Single query grouping `ledger_effects` by `tx_type` and sign for `envelope_id = E AND occurred_on BETWEEN :m1 AND :m2`.

## 3. Envelope commands

All are `defineAction`s (TD-00 §6). Input schemas are `.strict()`.

### 3.1 `createEnvelope` (FR-ENV-01)
```ts
{ idempotencyKey; name: 1..60; description?: ≤300; icon?: emoji; color?: ColorToken;
  ownerType: 'mine'|'other'; ownerName?: 1..60 (required iff other);
  kind: 'standard'|'savings'; goalAmount?: PositivePaisaStr (savings only);
  initialFunding?: { amount: PositivePaisaStr;
                     source: 'unallocated' | 'new_money' }   // 'new_money' only for ownerType 'other'
  date?: LocalDate }
```
Rules:
1. Active-name uniqueness is checked case-insensitively on trimmed names (unique index is the backstop; map `23505` on `uq_env_active_name` → `VALIDATION{name}`: "You already have an envelope called “Home”.").
2. Soft cap: `count(active) ≥ 200` → create allowed but result includes `warnings:['SOFT_CAP']` (UI shows banner, FR-ENV-10).
3. Funding:
   - `source:'unallocated'` → insert `allocation` (amount ≤ Unallocated at that timeline point, verified by the verifier; pre-check gives the friendly message of §4.1).
   - `source:'new_money'` (Others' only) → insert `external_deposit` (Total increases). The UI asks the mandatory question *"Is this money already in your bank balance?"* → Yes ⇒ `unallocated`, No ⇒ `new_money`.
   - `ownerType:'mine'` + `new_money` → `VALIDATION`.
4. `kind='savings'`: `goalAmount` optional; for non-savings `goalAmount` must be absent.
5. `sort_order` = max+1 within its owner group.
6. Icon default `💼`; emoji validated as single grapheme.

### 3.2 `updateEnvelope` (FR-ENV-02)
Editable: `name`, `description`, `icon`, `color`, `ownerName` (only when `other`), `kind`, `goalAmount`. `ownerType` is **never** editable via this action (rejected with `RULE_VIOLATION`: "To change whose money this is, archive it and create a new envelope."; trigger is the backstop once transactions exist; before the first transaction an envelope may be re-typed — `changeEnvelopeOwnerType` is an explicit separate action available only when `tx_count = 0`). Optimistic concurrency via `updatedAt`.

### 3.3 Archive / unarchive (FR-ENV-04…06)
```ts
archiveEnvelope({ id, updatedAt, resolution?: 'to_unallocated' | 'return_to_owner' | 'give_to_me' }): ActionResult<Envelope>
unarchiveEnvelope({ id, updatedAt }): ActionResult<Envelope>
```
Algorithm in one write txn:
1. Load envelope `FOR UPDATE`. If already archived → idempotent no-op success.
2. If it has active loans (lender or borrower, TD-06 `loan_state.status='active'`) → `RULE_VIOLATION` with `details.loanIds` and suggested action "Settle loans first" (links) — **FR-ENV-05, FR-LOAN-34**.
3. Balance `b`:
   - `b = 0` → set archived.
   - `b > 0` and `resolution` absent → return `RULE_VIOLATION{code:'NEEDS_RESOLUTION', balance, ownerType}` so the UI opens the sheet.
   - `mine` + `to_unallocated` → insert `deallocation(b)` dated *today*, then archive.
   - `other` + `return_to_owner` → insert `external_withdrawal(b)` ("Returned to Ahmed"), then archive.
   - `other` + `give_to_me` ("the money is now mine") → insert `deallocation(b)` then archive; the UI first shows a confirm step with a warning ("This turns Ahmed's 4,000 into your unallocated money.").
   - `b < 0` is impossible (INV-2).
4. Pause dependent recurring rules (TD-07 §7: rules referencing this envelope → `paused`, `pause_reason='envelope_archived'`).
5. Set `status='archived'`, `archived_at=now()`, **`sort_order` unchanged**. Verifier (touching this envelope + Unallocated).
Unarchive: if another *active* envelope has the same lower-cased name → `VALIDATION{name}` with the instruction to rename first (the sheet offers an inline rename and retries atomically with `{ id, rename }`). Does not auto-resume recurring rules (they show a banner with "Resume").

Archived envelopes: excluded from dashboard, quick-add pickers, loan pickers, income-split pickers (read functions take `includeArchived` default false); included in history, filters, analytics, export.

### 3.4 `deleteEnvelope` (FR-ENV-08)
Allowed only if **no row of any kind references it**, including soft-deleted transactions (TD-D7), splits, loans, recurring rules/templates (`split_template_json` is scanned) and audit-independent. Implement as a single `NOT EXISTS …` guard + `DELETE`; otherwise `RULE_VIOLATION`: "Home has history, so it can't be deleted. You can archive it instead." Deleting never touches balances (an unreferenced envelope has none).

### 3.5 `reorderEnvelopes` (FR-ENV-07)
`{ owner: 'mine'|'other', orderedIds: UUID[] }` — must be exactly the set of active envelopes of that group (else `VALIDATION`); assigns `sort_order = index` in one `UPDATE … FROM unnest(...)`. UI: drag handle (pointer events, long-press on touch) **and** explicit "Move up/down" buttons for accessibility (keyboard: arrow keys on the focused handle with live announcement "Moved Home to position 2 of 4").

## 4. Allocation, deallocation, transfer (FR-ALLOC-01…05)

Common inputs: `{ idempotencyKey, amount: PositivePaisaStr, date?: LocalDate, time?, note? }`.

| Action | Extra input | Checks (pre-check for messages; the verifier is authoritative) |
|---|---|---|
| `allocate` | `toEnvelopeId` (active; `mine` **or** `other`, FR-ALLOC-02) | amount ≤ Unallocated at that timeline point |
| `deallocate` | `fromEnvelopeId` (active) | amount ≤ envelope balance at that point |
| `transfer` | `fromEnvelopeId`, `toEnvelopeId` | both `mine`, active, different; amount ≤ source balance |

### 4.1 Messages (plain language, actionable)
- allocate: "Only 20,000 is unallocated. Record income first or move money from another envelope." (+ SuggestedAction `record_income`, `transfer_from…`).
- transfer from other-owned: "Money held for Ahmed can't be moved into your own envelopes. Return it to Ahmed, or move it to Unallocated if it's now yours." (FR-ALLOC-04 decision; blocked also by DB trigger `tx_check_refs`).
- deallocate/transfer short: "Home has only 2,000 PKR available."

### 4.2 Interaction with loans (FR-ALLOC-03/05)
Balances are what they are; loans do not restrict deallocation or transfer and are never forgiven by moving money (only repayment/deletion changes a loan). Own funds can go negative (informational note, TD-06 §5).

## 5. Held money (external deposit/withdrawal)

Quick actions "Record Held Money" and "Return Held Money" (also available from an Others' envelope detail).

- `recordHeldMoney({ envelopeId (other, active), amount, date, note })` → `external_deposit`: Total +A, envelope +A. Not income (INV-6). UI help: "Ahmed gave you 20,000 to hold. Your total goes up, but it isn't your income."
- `returnHeldMoney({ envelopeId (other, active), amount, date, note })` → `external_withdrawal`: Total −A, envelope −A; amount ≤ envelope balance else: "Ahmed's envelope has only 15,000. You can't return 20,000." (FR-TXN-12). Not spending.
- Deleting an `external_deposit` whose money has since been spent/returned is rejected by the verifier (FR-TXN-11) with the standard timeline message.
- Spending from an Others' envelope is an ordinary expense (TD-05) with badge **"On behalf of Ahmed"** and is excluded from the user's analytics by default (TD-09, FR-TXN-13).
- Others' envelopes cannot lend/borrow, transfer to/from `mine` envelopes (TD-01 trigger + action checks, test 20). Allocation to them from Unallocated is allowed.

## 6. Read models

```ts
getEnvelopeList(userId, { includeArchived?: boolean, owner?: 'mine'|'other' }): EnvelopeCard[]
getEnvelopeDetail(userId, id, { month?: LocalDate }): EnvelopeDetail
```
```ts
interface EnvelopeCard {
  id; name; icon; color; ownerType; ownerName?; kind; status;
  balance: Paisa; txCount: number;
  borrowed: Paisa; loanedOut: Paisa;           // from loan_state, 0 if none
  ownFunds: Paisa;                              // balance - borrowed (may be negative, FR-LED-03)
  loanChips: Array<{ direction:'borrowed'|'loaned'; counterpartName: string; amount: Paisa }>;
  goal?: { amount: Paisa; progress: number /*0..1 clamp*/ };   // savings only
}
interface EnvelopeDetail extends EnvelopeCard {
  month: { spent: Paisa; added: Paisa; returned: Paisa; loansIn: Paisa; loansOut: Paisa; repaid: Paisa };
  borrowedLoans: LoanRow[]; loanedLoans: LoanRow[];   // TD-06
}
```
Order: `mine` by `sort_order`, then `other` by `sort_order` (FR-ENV-07).

### 6.1 Own-funds note (FR-LED-03)
`ownFunds < 0` → neutral note (not red, info icon + text): "Home holds 2,000 but owes 5,000 to Personal." generated by `messages.ownFundsNote({ balance, borrowedByLender[] })`.

## 7. UI specification

**Envelopes page** (`/envelopes`): segmented list "Mine" / "Held for others", then "Archived" (collapsed section). Card: icon, name, big balance, owner badge ("Not yours — held for Ahmed", with person icon, not colour alone), tx count, loan chips ("Borrowed 5,000 from Personal", "Loaned out 5,000 to Home"), savings progress bar + `aria-valuenow`. FAB opens Create Envelope sheet.

**Create/Edit sheet:** fields per §3.1; owner-type segmented control (disabled with explanation once transactions exist); "Is this money already in your bank balance?" shown only for Others' + initial funding; live preview of resulting Unallocated; validation inline; keyboard-safe (inputs ≥16 px).

**Archive sheet:** states from §3.3 (zero balance → single confirm; balance>0 → options; active loans → list of loans with "Open loan" links and primary "Settle loans first").

**Envelope detail** (`/envelopes/[id]`): header, balance, Own funds / Borrowed / Loaned-out rows (only when non-zero), "This month: spent X · added Y" (+ separate "Loans" and "Returned" lines when non-zero), action row (Add expense · Add money · Move · Edit · Archive; *Add money* label becomes "Record held money" on Others' envelopes and *Move* is hidden for them), filters (All / Income-adds / Expenses / Loans / Repayments + date, month, category), grouped list (Today/Yesterday/date headers), "Load more" (page 30, cursor — TD-05 §6).

## 8. Edge cases (explicit)
- Rename to a name used by an *archived* envelope: allowed. Unarchive then conflicts → rename prompt.
- Archiving the only envelope: allowed; dashboard shows empty state with "Create your first envelope" (Unallocated retains the money).
- Concurrent archive + expense on two devices: serialised by the lock; the later action sees the new state (`NOT_FOUND`-like "This envelope is archived").
- Hard-deleting an envelope created seconds ago by mistake works only if nothing references it (Undo toast on create uses this path).
- Emoji ZWJ sequences accepted as one grapheme; skin-tone modifiers OK.
- Same name differing by trailing space/case → conflict (index uses `lower(btrim(name))`).

## 9. Tests owned (URD §21)
15 (name uniqueness incl. archived exception), 16 (owner type lock), 17 (archive flows, loan block, pickers, unarchive clash), 18 (hard delete rules incl. soft-deleted reference), 19 (external deposit/withdrawal effects on Total/Held/YourMoney/analytics), 20 (others' envelope cannot lend/borrow/transfer — both app and DB trigger), 5 (allocation boundary), plus transfer/deallocation boundary tests, reorder consistency, savings goal progress rendering, emoji validation.

## 10. Acceptance
Reference scenario step 1 (four envelopes from opening balance), step 6 (add 20,000 to Home from Unallocated), step 8 (Ahmed's `external_withdrawal` then archive → disappears from dashboard, appears under Archived and in history) pass as written in URD §22.
