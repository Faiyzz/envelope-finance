# TD-08 — Reconciliation

**URD coverage:** §12 (page, FR-RCN-R01…R09, adjustment FR-RCN-08, FR-RCN-10 badge, dashboard status states 12.4), INV-7, tests 36–40.
**Depends on:** TD-01 (`ledger_revision`, totals, verifier), TD-05 (adjustment tx), TD-10 (status chip). **Used by:** TD-10, TD-11.

> ID note: URD §12 uses `FR-REC-08/10` which collide with the recurring series. Here they are **FR-RCN-08** (optional adjustment) and **FR-RCN-10** (changed-since badge).

---

## 1. Principles
- Reconciliation **never changes balances** (INV-7). Saving a check writes only a snapshot row.
- The only way to alter balances after a mismatch is the separate, explicit **Adjustment** (§6), an `adjustment` transaction created in the same action but only when the user opts in.
- *Expected* is always computed on the server at the moment of the check; any client-sent expected value is ignored (FR-RCN-R01).

## 2. Schema (migration `0009_reconciliation.sql`)
```sql
CREATE TABLE reconciliations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_on DATE NOT NULL,                         -- user-local date at check time (hash window upper bound)
  expected_paisa BIGINT NOT NULL,
  actual_paisa BIGINT NOT NULL CHECK (actual_paisa >= 0),            -- FR-RCN-R04
  difference_paisa BIGINT NOT NULL,
  note TEXT CHECK (char_length(note) <= 500),
  adjustment_transaction_id UUID,
  tx_count_at_check INTEGER NOT NULL,
  ledger_revision BIGINT NOT NULL,                  -- users.ledger_revision at the time (TD-D5)
  ledger_hash TEXT NOT NULL,                        -- §3
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, adjustment_transaction_id) REFERENCES transactions (user_id, id) ON DELETE SET NULL (adjustment_transaction_id),
  CONSTRAINT rec_diff CHECK (difference_paisa = actual_paisa - expected_paisa)
);
CREATE INDEX ix_rec_user_checked ON reconciliations (user_id, checked_at DESC) WHERE deleted_at IS NULL;
```
Records are immutable except `note` and soft-delete (FR-RCN-R05): a trigger rejects UPDATE of any other column.

## 3. Snapshot hash & revision (defines the TD v1.0 gap)

Two complementary markers:

1. **`ledger_revision`** (monotonic counter incremented by *every* ledger-affecting write; TD-01 §7). Question answered: *"Has anything changed since the check?"* (dashboard states).
2. **`ledger_hash`** over the transactions dated **on or before the check date** — question answered: *"Did records dated before this check change?"* (FR-RCN-10 badge), so backdated edits flag old checks but ordinary new entries dated later do not.

```sql
-- hash for user U over window ≤ :checked_on  (re-computable at any time)
SELECT md5(COALESCE(string_agg(t.id::text || ':' || t.version, ',' ORDER BY t.occurred_on, t.occurred_at, t.created_at, t.id), ''))
FROM transactions t
WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.occurred_on <= $2;
```
`version` bumps on every update (TD-01 trigger); soft delete/restore changes membership; splits edits bump the parent version (the action always `UPDATE`s the parent when replacing splits). Also stored: `tx_count_at_check` (cheap UI hint "since this check: 3 changes" computed as `count(audit_log WHERE entity='transaction' AND at > checked_at)`).

## 4. Actions

```ts
previewReconciliation({ actual: PaisaStr }): { expected, actual, difference, status: 'match'|'more'|'less',
                                               warnings: ('LARGE_MISMATCH')[], hints: Hint[] }          // no write ("Just checking", FR-RCN-R03)
saveReconciliation({ idempotencyKey, actual, note?, adjustment?: AdjustmentRequest }): ActionResult<ReconRow>
updateReconciliationNote({ id, note }) ; deleteReconciliation({ id })   // soft delete
```
`saveReconciliation` (one `withUserWrite`):
1. `actual ≥ 0` else `VALIDATION{actual}`: "Negative balances aren't supported in V1." (FR-RCN-R04).
2. `expected` = `ledger_totals.total_paisa` (server). `difference = actual − expected`. `today` = user-local.
3. Compute `ledger_hash(checked_on = today)`, read `users.ledger_revision`, `tx_count`.
4. Insert snapshot row. **If no `adjustment` requested → done; no balance changes** (assert in a test by comparing `ledger_totals` before/after).
5. If `adjustment` is present → create it per §6 in the same transaction and link `adjustment_transaction_id`. `expected_paisa`/`difference_paisa` keep the **pre-adjustment** values (what the user observed). `ledger_revision` and `ledger_hash` are computed **after** the adjustment (step 3 is re-run), because the check declares the post-adjustment ledger to match the bank; otherwise the chip would wrongly read "changes since" right after the user reconciled. Current expected then equals `actual` → status ✓ Reconciled.
6. Response includes the new status (§5) for immediate chip refresh.

## 5. Status state machine (dashboard chip, §12.4 + gap resolution)

Pure function `reconciliationStatus(input): Status` in `domain/reconciliation`:

```ts
input = { latest?: { checkedAt, checkedOn, actual, difference, ledgerRevision }, currentExpected: Paisa, currentRevision: bigint, changeCountSince: number, now }
```
| # | Condition (evaluated top-down) | Status | Copy |
|---|---|---|---|
| 1 | no latest | `never_verified` | "Verify with your bank" (neutral) |
| 2 | `currentExpected == latest.actual` | `reconciled` | revision equal → "✓ Reconciled · Verified today 14:05"; revision different → "✓ Reconciled · based on your check of Oct 6" (state 5 of URD) |
| 3 | `latest.difference == 0` (matched then) and revision differs (so expected ≠ actual now) | `changes_since` | "3 changes since you last verified (Oct 4)" — amber/neutral, **not** a mismatch |
| 4 | `latest.difference ≠ 0` and revision equal | `mismatch` | "⚠ 1,250 PKR mismatch" (icon + text; not colour alone) |
| 5 | `latest.difference ≠ 0`, revision differs, `currentExpected ≠ latest.actual` | `changes_since_still_off` | "Records changed since your check. Still 500 off from your bank figure of 98,000." (resolves a case the URD left open) |

Status is computed on every dashboard load from `(latest check, ledger_totals, users.ledger_revision, audit count)`. Tested exhaustively as a truth table (URD 36–37).

## 6. Optional adjustment (FR-RCN-08)

`AdjustmentRequest = { target: 'unallocated' | { envelopeId }, note: string (1..500, mandatory), confirmation: true }`.
- Never default-selected in the UI. Appears only if `difference ≠ 0` and the user checks **"Fix difference with an adjustment"**; UI requires choosing the target (default Unallocated), writing a note, and ticking/typing the explicit confirmation: "I understand this adds a correction of −1,000 to my records."
- Server: `amount = difference` (signed; `actual − expected`). Insert `adjustment` tx (`envelope_id = envelopeId | NULL`, `note`, date=today, time=now); `touch(target)`; **verifier**: a negative adjustment that would push the target negative at any point → `RULE_VIOLATION`/`TimelineViolation` with message "That would leave Home below zero. Choose a funded target (Unallocated has 20,000)." (never silently adjusts another account).
- Effects: TOTAL ±X; target ±X (envelope, or Unallocated derived). The adjustment is displayed everywhere with a distinct **Adjustment** badge, excluded from spending/income analytics but reported on a separate "Adjustments" line (TD-09).
- Adjustments to an *Others'* envelope are allowed only if the user explicitly picks it (warning text: "This changes money you hold for Ahmed"); not offered by default.
- Deleting the adjustment later is allowed through the normal delete path (validated); the reconciliation row remains with `adjustment_transaction_id` pointing at a deleted tx → UI label "Adjustment removed".

## 7. Hints (read-only helpers)

Computed server-side in `previewReconciliation` (so they also work for "Just checking") from the **recent window** = last 20 transactions or all since the last matching check, whichever is larger, capped at 100 (§12.1):

| Hint | Rule | FR |
|---|---|---|
| Large mismatch | `|diff| > 10% of expected` **or** `> 50,000 PKR` ⇒ warning "Double-check you entered the bank balance correctly" (non-blocking) | R07 |
| Possible duplicate | two non-deleted txs with same `(type, amount, envelope, category)` and dates within ±1 day; highlight both | R09 |
| Missing-amount | a recent tx whose amount equals `|diff|` ("Is this one counted twice / missing?") — wording depends on sign: if actual < expected the tx might be *double-counted* or a bank-only fee; if actual > expected it might be *missing* | R09 |
| Transposition (SHOULD, Tier 3) | `|diff| % 9 == 0` and exists a plausible digit transposition among recent amounts (`a` vs `b`, `|a−b| == |diff|`, same digits multiset). Optional, low-prominence hint | R08 |
| Possible causes (static copy) | list below | §12.1 |

**Possible-causes copy** (the URD references "spec §27", which is not in the provided documents; this is the proposed content, owner-editable in `messages/en.ts`): "A bank fee or charge you haven't recorded", "A transaction recorded twice or with the wrong amount", "A deposit that hasn't been recorded", "A cash withdrawal or ATM fee", "An automatic payment (bill, subscription, committee) not entered", "A typo in an amount (digits swapped or a missing zero)", "A pending transaction your bank hasn't posted yet", "The bank balance you typed is not the current one".

## 8. History & "Records changed since this check" (FR-RCN-R05, FR-RCN-10)

`getReconciliationHistory(userId, { cursor })` returns rows `{ id, checkedAt, expected, actual, difference, statusIcon, note, adjustment?, changedSince: boolean }` where `changedSince = (recompute ledger_hash(checked_on) ≠ stored ledger_hash)`; the hash is computed in one SQL per row batch (window by each row's `checked_on`; bounded at 20 rows/page, acceptable). Badge text: "Records changed since this check" — the stored expected value is **never** updated. Table columns: Date, Expected, Actual, Difference, status icon (✓ / ⚠ with text), note (editable).

## 9. UI (`/reconciliation`)
Top → bottom: **Current expected balance** (large) → **Actual bank balance** input (`inputmode="decimal"`, 16 px, uses `<MoneyInput>`) → live **Difference** line with sign and plain words (`0` → "✓ Everything reconciles"; `+1,000` → "Bank has 1,000 MORE than your records"; `−1,000` → "Bank has 1,000 LESS than your records") → optional note → buttons **Save check** and **Just checking** (preview only) → (if mismatch) "Possible causes" and the adjustment disclosure (collapsed, off by default) → **Recent transactions** list with inline edit access and hint highlights → **History** table. Large-mismatch warning inline. Entire page keyboard/screen-reader usable; difference announced via `aria-live="polite"`.

## 10. Tests owned (URD §21 36–40)
36 (match → Reconciled; add tx after → Changes since, not mismatch), 37 (signed wording; fixing records flips status via state #2), 38 (save doesn't alter `ledger_totals`; adjustment requires note + confirmation; lands in chosen target; excluded from analytics; negative-result target rejected), 39 (backdated edit flags `changedSince`, stored snapshot unchanged; later-dated entries do not), 40 (negative actual rejected; large-mismatch warning thresholds exactly at 10%/50,000), truth table for §5, hash determinism, hints (duplicate window ±1 day, missing-amount), adjustment-then-status = Reconciled, deleted adjustment label.

## 11. Acceptance
Reference scenario step 7: with expected X, entering X → ✓ Reconciled; entering X−1,000 → Mismatch −1,000 with causes listed and **no** balance change (asserted by diffing `ledger_totals`, `envelope_balances`, and row counts).
