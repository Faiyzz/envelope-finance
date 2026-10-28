# TD-07 — Recurring Transactions & Committees (Kameti)

**URD coverage:** §10 (FR-REC-01…13 — *recurring* series), FR-COM-01…04, FR-PWA-style lazy generation, tests 29–35.
**Depends on:** TD-00 (cron, `defineAction`), TD-01 (verifier, postings), TD-05 (tx pipeline), TD-06 (borrow). **Used by:** TD-10 (dashboard attention + upcoming), TD-04 (archive hook).

> ID note: the URD reuses `FR-REC-*` for both recurring and reconciliation. This set uses `FR-REC-*` for recurring and **`FR-RCN-*`** for reconciliation (TD-08).

---

## 1. Concepts
- **Rule** = a schedule + a template (expense from an envelope, or income with a split template).
- **Occurrence** = one *slot* of a rule on a `due_date`. Slots are numbered `slot_index = 0,1,2…` and each ends in exactly one of `generated` (a real transaction exists), `needs_attention` (funds missing), `skipped`.
- Real transactions are created **only** when due (`due_date ≤ today`); manual future dating stays forbidden (D4). Future slots are *projections* (never stored) for the Upcoming list.

## 2. Schema (migration `0008_recurring.sql`)
```sql
CREATE TYPE frequency_type AS ENUM ('weekly','monthly','yearly','custom_days');

CREATE TABLE recurring_rules (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  type TEXT NOT NULL CHECK (type IN ('expense','income')),
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa BETWEEN 1 AND 99999999999),
  envelope_id UUID,                                        -- expense target
  category_id UUID NOT NULL,
  split_template JSONB,                                    -- income: [{ "envelopeId": "...", "amountPaisa": "5000000" }]
  frequency frequency_type NOT NULL,
  interval_n INTEGER NOT NULL DEFAULT 1 CHECK (interval_n BETWEEN 1 AND 366),
  anchor_day SMALLINT CHECK (anchor_day BETWEEN 1 AND 31),  -- monthly/yearly: day-of-month; default start_date's day
  start_date DATE NOT NULL,
  end_date DATE,
  max_occurrences INTEGER CHECK (max_occurrences IS NULL OR max_occurrences > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','ended')),
  pause_reason TEXT CHECK (pause_reason IN ('user','envelope_archived')),
  is_committee BOOLEAN NOT NULL DEFAULT FALSE,
  next_slot_index INTEGER NOT NULL DEFAULT 0,              -- next slot the generator will materialise
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, envelope_id) REFERENCES envelopes (user_id, id),
  FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id),
  CHECK ((type = 'expense') = (envelope_id IS NOT NULL)),
  CHECK (type = 'income' OR split_template IS NULL),
  CHECK (NOT is_committee OR (type = 'expense' AND max_occurrences IS NOT NULL))
);
CREATE INDEX ix_rule_user_status ON recurring_rules (user_id, status);

CREATE TABLE recurring_occurrences (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL,
  slot_index INTEGER NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generated','skipped','needs_attention')),
  transaction_id UUID,
  note TEXT CHECK (char_length(note) <= 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, rule_id) REFERENCES recurring_rules (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions (user_id, id) ON DELETE SET NULL,
  UNIQUE (rule_id, due_date),                              -- a due date can never be generated twice (URD §5)
  UNIQUE (rule_id, slot_index),
  CHECK (status <> 'generated' OR transaction_id IS NOT NULL)   -- 'skipped' may retain the pointer to a deleted tx so restore can re-link (§4)
);
ALTER TABLE transactions ADD CONSTRAINT fk_tx_recurring
  FOREIGN KEY (user_id, recurring_id) REFERENCES recurring_rules (user_id, id) ON DELETE SET NULL (recurring_id);
```
(`ON DELETE SET NULL (col)` needs PostgreSQL ≥ 15, our minimum. Rules are never hard-deleted by the app, only `ended`; the clause only matters for account deletion/import-replace.)

**Derived counts (replaces the URD's stored `occurrences_generated`, so it can't drift):**
`counted(rule) = COUNT(*) FROM recurring_occurrences WHERE rule_id=… AND status IN ('generated','needs_attention')` — i.e. everything except `skipped` consumes the committee/`max_occurrences` budget; skipped slots **do not**, so the schedule extends by one (FR-REC-08, test 33).

## 3. Pure recurrence engine (`domain/recurrence`) — replaces TD v1.0's engine

All functions are pure, operate on `LocalDate`, take `today` as a parameter, and use **index-based** date computation (never "previous + step"), eliminating month-overflow and drift bugs.

```ts
interface RuleSchedule { frequency; intervalN; anchorDay?: number; startDate: LocalDate; endDate?: LocalDate; }

dueDateForSlot(rule: RuleSchedule, k: number): LocalDate
  // weekly:      start + 7*interval*k days
  // custom_days: start + interval*k days
  // monthly:     month = startMonth + interval*k;  day = min(anchorDay ?? start.day, daysInMonth(y, m))   // FR-REC-02 clamp, keeps anchor
  // yearly:      year  = startYear + interval*k;   month = start.month; day = min(anchorDay ?? start.day, daysInMonth)  // Feb 29 → Feb 28 (FR-REC-13)

slotsDue(rule, fromSlot: number, today: LocalDate, budgetRemaining: number | null, cap = 24): Slot[]
  // slots k >= fromSlot with dueDate <= today and (endDate undefined or dueDate <= endDate); stops after `cap` and when budget is 0

previewNext(rule, fromDate, n = 3): LocalDate[]        // for the create form (FR-REC-01), counts from first slot with dueDate >= fromDate
nextDueDate(rule, nextSlotIndex): LocalDate | null      // null when budget exhausted/endDate passed
```
Properties tested: monthly anchor 31 across a leap and non-leap year yields `31 Jan, 29/28 Feb, 31 Mar, 30 Apr, …, 31 Jan` (never skips a month, never drifts to 28th permanently); yearly Feb 29 → Feb 28 in non-leap years and back to Feb 29 in leap years; `dueDateForSlot` is strictly increasing; idempotent `slotsDue`.

## 4. Rule actions

| Action | Notes |
|---|---|
| `createRule` | Input per FR-REC-01. Validates envelope active & type-consistent; income template envelopes active & `mine`, Σ template ≤ amount; category kind matches. **Preview of next 3 occurrences** returned by `previewRule` (no write) before saving. `startDate` may be past: `catchUp: 'backfill' | 'from_next'` (FR-REC-03). `from_next` sets `next_slot_index` to the first slot with `dueDate > today`; `backfill` leaves 0 and generation (§6) creates missed slots, each validated. Committee shortcut `createCommittee({ name, monthlyAmount, months, startDate, envelopeId, categoryId? })` = rule with `is_committee`, `max_occurrences=months`, `categoryId` optional, defaulting to the system "Uncategorized" expense category |
| `updateRule` | Affects **future** occurrences only (FR-REC-09, FR-COM-04); existing transactions untouched; `version` check. Changing `frequency/start/anchor` after slots exist is rejected unless the rule has no generated/needs_attention slots (otherwise "End this rule and create a new one") — keeps `dueDateForSlot` stable. Amount/name/envelope/category/template/end/max are editable (max cannot go below `counted`). |
| `pauseRule` | `status='paused'`, `pause_reason='user'`. No generation while paused. |
| `resumeRule({ backfill })` | `backfill:true` generates missed slots (cap 24 / run, repeat on later runs); `false` advances `next_slot_index` to the first slot with `dueDate > today` (those skipped-over slots are **not** recorded). |
| `endRule` | `status='ended'` (FR-REC-09): stops generation, history preserved; rule is never hard-deleted. |
| `skipOccurrence({ occurrenceId })` | Allowed for `needs_attention` (and for the *next upcoming* slot — materialises it as `skipped` in advance). Sets `skipped`; frees budget (committee extends by one slot). |
| `retryOccurrence({ occurrenceId })` | For `needs_attention`: re-attempts creation **using current rule values**; success → `generated`. Used after "Add money" / "Borrow". |

Deleting a generated transaction (any UI) leaves its occurrence `skipped` with note "Transaction deleted" (FR-REC-09); restoring the transaction re-links it (`generated`) if the occurrence still points to it (`transaction_id` is retained for this reason, so `CHECK` above is relaxed: `generated ⇒ transaction_id NOT NULL`, others may keep it). Implementation: occurrence status is **recomputed** by a small repo function `syncOccurrenceStatus(txId)` called from `softDeleteTx`/`restoreTx` when `recurring_id IS NOT NULL`.

## 5. Generation algorithm (FR-REC-04…07, 11)

`generateForUser(userId, today)` — idempotent, order-correct, all inside one `withUserWrite`:

1. Load active rules where `due(next_slot_index) ≤ today` (cheap: `ix_rule_user_status` + computed due date in app).
2. For each rule collect `slotsDue(rule, next_slot_index, today, budgetRemaining, cap=24)` → candidate `(rule, k, dueDate)`. If a rule has more than 24 pending slots, process 24 and log `warn` (FR-REC-07); the remainder is processed next run.
3. **Sort all candidates globally** by `(dueDate, type: income first, rule.created_at, k)` so a recurring income that precedes an expense on the same day funds it, and cross-rule order matches canonical ledger order.
4. For each candidate:
   a. `INSERT INTO recurring_occurrences … ON CONFLICT (rule_id, due_date) DO NOTHING RETURNING` — if conflict, someone else (cron + lazy trigger racing — impossible under the user lock, but defence in depth) already did it → skip.
   b. Build the transaction:
      - **expense:** `type='expense'`, envelope, category, `occurred_on=dueDate`, **`occurred_at='12:00:00'`**, `is_generated=true`, `recurring_id`.
      - **income:** `type='income'`, splits = template ∩ *active* envelopes; shares of archived/missing envelopes fall to Unallocated and the occurrence `note` records it ("Savings share went to Unallocated — envelope archived", FR-REC-11); `occurred_at='00:01:00'` (TD-D6).
   c. **Fund check via a savepoint:** `SAVEPOINT s; insert; verify(touched)`; on `TimelineViolation`/insufficient funds → `ROLLBACK TO s`, set occurrence `needs_attention` (FR-REC-06), note "Personal has only 600" (structured `details` in `note` JSON is avoided; the dashboard recomputes the numbers live). On success → `RELEASE s`, occurrence `generated`.
   d. Envelope archived / category archived: archived envelope ⇒ rule should already be auto-paused (§7); if encountered, mark `needs_attention` with note. Archived category does not block (flag only, FR-REC-10).
5. Advance `next_slot_index` past all processed slots. If `counted ≥ max_occurrences` and no `needs_attention` remain unresolved → `status='completed'` for committee/limited rules (FR-COM-02); if `endDate` passed with nothing pending → `ended`.
6. `ledger_revision++` if any `generated`. Revalidate tags.

**Important property:** a `needs_attention` slot **does not block later slots** — catch-up continues (e.g. 3 months missed: slot 1 fails for funds, slots 2–3 are still evaluated; any that pass are generated; each failure stays visible).

### 5.1 Triggers
- **Cron** (TD-00 §7): `recurring.generate` for every user with due rules (iterate users with `EXISTS(due rule)`; each user in its own `withUserWrite`).
- **Lazy (§5.2)**: on app open.
- **After funding actions** (allocate/income/loan/transfer): not automatic; the user presses "Record anyway after funding" (`retryOccurrence`) per URD.

### 5.2 Lazy trigger (FR-REC-04b)
`<RecurringSync />` (client component in the `(app)` layout) calls `syncRecurring()` once per session start and whenever the tab becomes visible after ≥ 1 h (`visibilitychange`). The action is cheap when nothing is due (single indexed query), returns `{ generated: n, needsAttention: m }`, and the client calls `router.refresh()` + shows a toast ("2 recurring transactions were added"). Never runs offline.

### 5.3 Needs-attention actions (FR-REC-06)
Dashboard card: "Spotify 1,099 due 1 Nov — Personal has only 600." Buttons:
1. **Add money** → allocate sheet pre-filled with the shortfall, `returnTo` retry.
2. **Borrow from another envelope** → TD-06 §4 flow with `retryOccurrence` as the resume step.
3. **Skip this time** → `skipOccurrence`.
4. **Record anyway after funding** → `retryOccurrence` (re-runs the check; if still short, shows the shortfall).

## 6. Upcoming list (FR-REC-12)
Read model `getUpcoming(userId, today)` merges: (a) `needs_attention` occurrences ("Overdue (needs attention)"), (b) projected next slot of each active rule within 30 days; sorts by date; top 5. Labels: `Today`, `Tomorrow`, `In N days`. Paused rules excluded; ended/completed excluded.

## 7. Hooks from other modules
- **Archive envelope** (TD-04 §3.3): all `active` rules whose `envelope_id` = E or whose `split_template` contains E: expense rules → `paused/envelope_archived`; income rules keep running (share falls to Unallocated); the rules list shows the reason with a "Pick another envelope" action.
- **Archive category:** rule continues, shows "category archived — choose another" (FR-REC-10).
- **Unarchive envelope:** rules paused for `envelope_archived` show "Resume" banner (no auto-resume).
- **Delete/restore tx:** `syncOccurrenceStatus` (§4).

## 8. Committee (kameti) (FR-COM-01…04)
- Created through `createCommittee`; shown in a dedicated "Committees" section of Recurring with detail: paid count `generated` slots, remaining = `max − counted` (+ pending needs-attention counted separately), total paid = Σ generated amounts, total remaining = remaining × current amount, projected end date = `dueDateForSlot(rule, max + skippedCount − 1)` (skips extend the schedule), progress bar.
- Last occurrence generated ⇒ `completed` automatically.
- Lump-sum payout: user records normal income with category **Committee payout** (D8). UI help text on the committee page and on income form when that category is selected.
- Amount change affects future slots only (`updateRule`).

## 9. UI
- `/recurring` (More → Recurring; Settings → Recurring): tabs Active / Paused / Ended; list rows show name, amount, schedule text ("Monthly on the 31st (shortened in short months)"), next due, status chips.
- Create/edit sheet with live **next 3 dates** preview; frequency chips; anchor-day hint when 29–31; end options (never / on date / after N); "Make this a committee" toggle.
- Rule detail: next dates, generated history (links to transactions with "Generated" badge), needs-attention items, actions (Pause/Resume/Skip/End).
- Everything has loading/empty/error states; reduced-motion safe.

## 10. Tests owned (URD §21 29–35)
29 (clamp across a year incl. leap Feb; yearly Feb 29), 30 (idempotent: run twice and concurrently under lock), 31 (3 months unopened → 3 slots with correct dates; failures → needs_attention; later slots still processed), 32 (insufficient funds → needs_attention, no negative; fund then retry), 33 (pause/resume with/without backfill; skip extends committee; completes after N), 34 (edit affects future only; end keeps history; archived envelope pauses), 35 (income template with one archived envelope); plus cross-rule ordering (income precedes same-day expense), 24-slot cap, cron + lazy race, month-end/timezone (`today` pinned by `Clock`), skipped-then-deleted tx statuses.

## 11. Acceptance
A monthly committee of 12 on the 31st pays on correct dates for a year, can skip one month (13th slot appended), completes after the 12th generated payment, and never makes any envelope negative; killing the cron for 40 days and opening the app generates every missed slot exactly once.
