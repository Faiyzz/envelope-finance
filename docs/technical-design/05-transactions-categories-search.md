# TD-05 — Transactions, Categories & Search

**URD coverage:** §11.3 (quick expense), §11.5–11.7 (list, detail/edit, search), §14 (categories, FR-CAT-01…06), §15 (FR-TXN-01…13), §4.5 (soft delete/restore/purge), income & splits, undo, duplicate guard, tests 4–14, 52 (shared with TD-01).
**Depends on:** TD-00, TD-01 (schema, verifier, mutation ops), TD-04 (envelope rules). **Used by:** TD-07 (generates tx), TD-08, TD-09, TD-10 (UI shell).

Types owned here: `income` (+splits), `expense`, `adjustment` (note edit/delete only — created by TD-08), `opening_balance` (TD-03). Loans/repayments are created only via TD-06. Allocation/transfer/held money: TD-04 (this document owns their *list/detail/delete/restore* behaviours too).

---

## 1. Common validation pipeline (`domain/transactions/validate.ts`, pure)

Input DTO → `NormalizedTx` or `ValidationError`. Steps in order (first error per field):

1. **Amount** (FR-TXN-02): `PositivePaisaStr` (client already parsed with `parseMoney`; server re-validates the paisa integer range).
2. **Date** (FR-TXN-03): `assertDateAllowed(date, today)` (TD-01 §3). Time default rule included.
3. **Note** (FR-TXN-08): `cleanText`, ≤ 500, emoji allowed, control chars stripped, **not** whitespace-collapsed.
4. **Referenced entities** exist for this user & are *active* (FR-TXN-05) — exception on edit: unchanged archived refs allowed.
5. **Category** (FR-CAT-06): expense→expense category, income→income category; missing → resolve to the system "Uncategorized" of that kind (server default; the *quick UI* still asks but offers "Skip").
6. Type-specific rules (below).
7. **Insufficient-funds pre-check** (expense, allocation, transfer, deallocation, withdrawal): compute the source balance **at the transaction's timeline position** (`balanceAt(envelope, sortKey)`; simple `SUM(delta) … WHERE sort_key < new_key`), reject with `InsufficientFunds` → message "Home has only 2,000 PKR available." plus `actions`: `[{kind:'add_money', envelopeId}, {kind:'borrow', envelopeId, shortfall}]` when envelope is `mine` (FR-TXN-04). This is only for friendliness; the **verifier (TD-01 §6) remains the authority** and also catches later-dated effects of a backdated insert.

Field errors are keyed by DTO field names (FR-TXN-01).

## 2. Create actions

```ts
createExpense({ idempotencyKey, amount, envelopeId, categoryId?, note?, date?, time?, confirmDuplicate?: boolean })
createIncome({ idempotencyKey, amount, categoryId?, note?, date?, time?, splits?: Array<{ envelopeId, amount }> })
```
`createExpense` extras:
- **Duplicate guard (FR-TXN-09):** within the txn, if a non-deleted expense with identical `(amount, envelope, category, occurred_on)` was **created** < 2 min ago and `confirmDuplicate !== true` → `DUPLICATE_SUSPECTED` (soft error, no write): "Looks like a duplicate — add anyway?" The UI re-submits with a *new* `idempotencyKey` and `confirmDuplicate:true`. (Same idempotency key retries are handled silently by TD-01 §7.)
- Expense from an `other` envelope is allowed (FR-TXN-13); response includes `onBehalfOf: ownerName`.
- Result: `{ transaction: TxView, balances: { envelope: Paisa, total: Paisa, unallocated: Paisa } }` so the optimistic UI can reconcile with server truth.

`createIncome` rules (FR-TXN-06):
- `splits[]`: each amount > 0, **no duplicate envelope**, each envelope active (any owner type? **`mine` only** — income is the user's; splitting into an Others' envelope is rejected: "Income can't be split into money held for Ahmed"), `Σ splits ≤ amount`.
- Remainder → Unallocated, returned in the response and displayed live in the form as "Unallocated: X".
- Category defaults to system "Uncategorized (income)".
- Verifier touches split envelopes + Unallocated.

Other-type creation endpoints live in TD-04 (`allocate`, `transfer`, …) and TD-06; all share `insertTx`.

## 3. Edit (`updateTransaction`)

```ts
updateTransaction({ id, version, patch: TypeSpecificPatch })
```
**Editable matrix (resolves URD gap; D10 forbids type change):**

| Type | Editable fields | Notes |
|---|---|---|
| `expense` | amount, envelope, category, date, time, note | envelope change validates *both* timelines (touch old ∪ new) |
| `income` | amount, category, date, time, note, splits | amount or splits change re-validates all affected envelopes (FR-TXN-07) |
| `allocation`/`deallocation` | amount, envelope, date, time, note | |
| `transfer` | amount, from, to, date, time, note | still `mine`→`mine` |
| `external_deposit`/`external_withdrawal` | amount, envelope (other only), date, time, note | |
| `opening_balance` | amount, date, time | TD-03 §2 |
| `adjustment` | **note only** | amount/target fixed; deleting allowed (TD-08 §7) |
| `loan`, `loan_repayment` | **none here** | route to Loans UI (FR-LOAN-33): action returns `RULE_VIOLATION{code:'USE_LOANS_UI', loanId}`; the transaction detail shows "Open loan" |

Process (`withUserWrite`): `SELECT … FOR UPDATE` by `(user_id,id)`; version check → `CONFLICT`; ensure not deleted; apply the **same validation pipeline** to the merged result; `UPDATE`; replace splits; `touch(old ∪ new)`; verify; audit; `ledger_revision++`. Changing `type` → `VALIDATION{type}` "To change the type, delete this and add a new one."

## 4. Delete, undo, restore

- `deleteTransaction({ id, version? })` → soft delete (TD-01 §8). Before confirming, the UI calls `previewDelete(id)` → `{ impact: [{ label:'Home balance', delta:+250000 }, { label:'Total', delta:+250000 }], wouldViolate?: ViolationMessage }` computed by *dry-run*: apply the delete in a transaction, run the verifier, **roll back** (`ctx.dryRun()`), so the confirm sheet states the impact (§11.6) or the blocking reason up front.
- Loan-linked rows cannot be deleted here (`USE_LOANS_UI`).
- Opening-balance rule (TD-03 §2) enforced.
- **Undo toast (6 s):** after create (and after delete) the toast offers *Undo*: create-undo = `deleteTransaction`; delete-undo = `restoreTransaction`. Because another write may have intervened within 6 s, Undo can legitimately fail the verifier — the toast then shows the plain-language reason instead of silently failing (resolves an unstated URD case). Undo of create uses `previewDelete` semantics; nothing special server-side.
- `restoreTransaction({ id })`: only within 30 d; re-runs creation-time referential checks (archived envelope/category → `RULE_VIOLATION` with "Unarchive Home first", except categories which may stay archived) and the verifier.
- Bulk delete/recategorise (SHOULD, Tier 3): `bulkUpdate({ ids ≤ 100, action })` runs all changes in one txn and one verification pass; all-or-nothing.

## 5. Transaction detail view
Fields: type label + icon, amount (signed per effect on selected envelope), envelope(s), category, note, occurred date/time, created/updated, version, linked items: loan (link), recurring rule (link + "Generated" badge), split breakdown, reconciliation adjustment (link), "On behalf of Ahmed" badge. Actions: Edit, Delete (impact sheet), **Add again** (pre-fills quick-add with the same fields, date=today, new idempotency key).

## 6. Listing & filtering (FR-PERF-03, §11.5)

### 6.1 API
```ts
listTransactions(userId, q: {
  cursor?: string; limit?: number /*default 30, max 100*/;
  text?: string;                       // ≥2 chars, matched against note, category name, envelope name, owner name
  envelopeIds?: UUID[]; categoryIds?: UUID[]; types?: TxType[];
  from?: LocalDate; to?: LocalDate; amountMin?: PaisaStr; amountMax?: PaisaStr;
  ownerName?: string; recurring?: 'yes'|'no'|'generated'; loanRelated?: boolean;
  sort?: 'newest'|'oldest'|'highest'|'lowest';
}): { items: TxRow[]; nextCursor?: string; totals: { count: number; net: Paisa; spent: Paisa; income: Paisa } }
```
- **Keyset pagination**: cursor = base64url JSON of the last row's sort tuple (`[on, at, createdAt, id]` for date sorts; `[amount, on, at, createdAt, id]` for amount sorts), compared with row-value comparison `(occurred_on, occurred_at, created_at, id) < ($1,$2,$3,$4)` for `newest`. Opaque to the client; invalid cursor → `VALIDATION`.
- `envelopeIds` matches `envelope_id OR counterpart_envelope_id OR split envelope` (an income split appears in each envelope's history). 
- `types` filter includes the synthetic group `loan-related` = {loan, loan_repayment}.
- **Totals bar** (`23 transactions · −38,000`): computed by a separate aggregate over the *same filter* (not the page). "Net" uses the signed effect on **Total** (income +, expense −, external ± shown separately) — define: `net = Σ TOTAL postings` for matched transactions; this equals "−38,000" for a pure-expense filter. Allocation/transfer/loan rows contribute 0 to net by definition.
- Row signage in lists: expenses/withdrawals "−", income/deposits/allocations-in "+", transfers/loans show "→" with both names; in an envelope-scoped list, sign is the delta *for that envelope* (so a transfer reads −X in the source and +X in the destination).
- Performance: the partial index `ix_tx_user_time` serves default; filters add `ix_tx_env`, `ix_tx_cat`, `ix_tx_type`. Text search uses trigram (§8). Target p95 < 300 ms at 50k rows.

### 6.2 Grouping (UI)
Headers computed in user's timezone: Today / Yesterday / `Mon, 5 Oct`. Time shown only for same-day items ≥ 2.

## 7. Soft delete housekeeping
`deleted.purge` (TD-00 §7): `DELETE FROM transactions WHERE deleted_at < now() - interval '30 days'` per user inside `withUserWrite` (splits cascade; `recurring_occurrences.transaction_id`, `reconciliations.adjustment_transaction_id` set null; `audit_log` rows remain). Purge increments `ledger_revision` only if affected rows had been counted in any hash window (they weren't — deleted rows are excluded from hashes — so **no bump needed**).
Recently deleted listing & restore UI: TD-03 §4.

## 8. Global search (§11.7)

```ts
globalSearch(userId, q: string): {
  envelopes: EnvelopeHit[]; transactions: TxHit[]; loans: LoanHit[]; recurring: RuleHit[]; counts: { …totalBeforeCap }
}
```
- Normalise: `trim`, min length 2, max 80; **escape** `\`, `%`, `_` for `ILIKE ... ESCAPE '\'`; pass as bind parameter (never string-concat). A pure numeric query (`/^\d+(\.\d{1,2})?$/` after removing commas) additionally matches `amount_paisa = parseMoney(q)` (exact, FR 11.7 "2500").
- Each group capped at 50 with "See all" deep-linking to the module list with the same `text` filter.
- Group queries (all `user_id`-scoped, soft-deleted excluded):
  - Envelopes: `name ILIKE`, `description`, `owner_name`.
  - Transactions: `note ILIKE` (GIN trigram) OR category name OR envelope name OR owner name OR amount. **Query "Ahmed"** returns Ahmed's envelope, *every* transaction where `envelope_id` or `counterpart_envelope_id` is that envelope (its deposits/withdrawals/expenses/allocations), and loans involving it (loans join), by matching `owner_name` through the envelope join.
  - Loans: `note ILIKE` or either party's name.
  - Recurring: `name ILIKE`.
- Ranking: exact name match first, then prefix, then similarity (`pg_trgm similarity()`), then recency.
- Indexes: GIN trigram on `envelopes.name`, `envelopes.owner_name`, `categories.name`, `loans.note`, `recurring_rules.name`, `transactions.note` (the latter in TD-01). Migration `0006_search_indexes.sql`.
- UI: header search icon; ⌘K / Ctrl+K on desktop opens command-palette dialog; debounce 250 ms; recent searches in `localStorage` (clearable); results grouped; keyboard navigation; empty state "No matches for “…”".

## 9. Categories (§14)

### 9.1 Seeding (FR-CAT-01) — `seedDefaultCategories(tx, userId)` (called by register/seed/import-replace-empty)
| Kind | Group | Names |
|---|---|---|
| expense | home | Electricity, Gas, Water, Internet, Rent, Groceries, Household, Maintenance, Daily Items, Eggs, Vegetables, Other (Home) |
| expense | personal | Food, Fuel, Shopping, Entertainment, Transport, Health, Other (Personal) |
| expense | — | **Uncategorized** (`is_system`) |
| income | other | Salary, Business, Gift, Committee payout, Other income |
| income | — | **Uncategorized** (`is_system`) |
`sort_order` follows the listed order. Names are unique per kind (so an expense "Other (Home)" and income "Other income" don't clash).

### 9.2 Actions
`createCategory({kind, name 1..40, group?})`, `renameCategory({id, name, updatedAt})` (not for `is_system`), `archiveCategory`/`unarchiveCategory` (not system), `deleteCategory` (only unreferenced **incl. soft-deleted tx, rules**), `mergeCategories({ fromId, intoId })` (SHOULD, FR-CAT-05): same kind, neither system-as-source; in one txn `UPDATE transactions SET category_id=into WHERE category_id=from` (+ recurring rules) → archive `from`; touches no balances, increments `ledger_revision` (transaction versions bump so reconciliation hashes change — harmless but correct).
Archived categories: hidden from pickers for new items; remain on old ones; **editing an old transaction keeps its archived category** unless the user changes it (FR-TXN-05).

### 9.3 Picker ordering (FR-CAT-02)
Given the chosen envelope: (1) *recent* categories used with that envelope (last 5 distinct), (2) group heuristic: name contains `home|house` (case-insensitive) → Home group first, else Personal group first, (3) the rest alphabetical, (4) "Uncategorized" last; a search box filters client-side. Last-used category per envelope is **derived from the DB** (`SELECT category_id FROM transactions WHERE envelope_id=$1 AND type='expense' ORDER BY created_at DESC LIMIT 1`) so defaults follow the user across devices.

## 10. Messages (examples, in `messages/en.ts`)
`err.insufficient: "{envelope} has only {available} available."`, `err.future: "You can't record a transaction in the future. Use a recurring transaction for upcoming payments."`, `err.archivedEnvelope: "{envelope} is archived. Unarchive it to add transactions."`, `err.duplicate: "Looks like a duplicate — add anyway?"`, `err.useLoansUi: "Loans are edited from the Loans screen."`.

## 11. Tests owned (URD §21)
1–3 (via TD-01), 4–14 (balance/timeline/concurrency/idempotency/versioning/soft-delete), 41-related list filters, 52 (midnight/TZ date), plus: split rules (sum=amount, 0 splits, >amount, duplicate env, archived env, other-owned env rejected), edit matrix (each field), envelope change validates both timelines, income edit that would orphan later spending rejected, duplicate-guard window, undo-failure message, restore re-validation, cursor pagination stability (insert during paging), search escaping (`%`, `_`, `\`, quotes, 10k-char input), "Ahmed" search completeness, category merge, archived category on old transaction.

## 12. Acceptance
Reference scenario steps 2–6 and 9-inputs pass (expense, salary split, rejected 5,000 electricity at Home=0, etc.); quick expense persists in one round trip and returns authoritative balances; every list endpoint is cursor-paginated and totals match an independent SQL sum in tests.
