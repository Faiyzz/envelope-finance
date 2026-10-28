# TD-09 — Analytics

**URD coverage:** §13 (definitions 13.1, ranges 13.2, sections 13.3), INV-6, FR-LOAN-35, FR-TXN-13, tests 41–43. *(TD v1.0 had no analytics design at all.)*
**Depends on:** TD-01 (`transactions`, `ledger_effects`), TD-04/05/06 (what is excluded), TD-00 (cache tags). **Used by:** TD-10 (route `/analytics`, category tap-through to transactions).

---

## 1. Definitions (strict — implement INV-6)

| Measure | Rule |
|---|---|
| **Spending** | `type='expense'`, `deleted_at IS NULL`, `occurred_on` in range, **envelope owner = mine** (default). Toggle `includeHeld=true` also includes expenses from `other` envelopes. |
| **Income** | `type='income'` only (split or not; full amount) |
| **Excluded from both** | `opening_balance`, `allocation`, `deallocation`, `transfer`, `loan`, `loan_repayment`, `external_deposit`, `external_withdrawal`, `adjustment` |
| **Adjustments note** | Σ signed `adjustment` in range, shown on a separate "Adjustments" line only if ≠ 0 or any exist |
| **Net** | Income − Spending (adjustments **not** included) |
| Dates | `occurred_on` is already the user's local calendar date → month grouping is `date_trunc('month', occurred_on)`; a transaction at 23:59 PKT on the 31st belongs to that month by construction (test 42). Timezone changes do not re-bucket stored dates. |

All aggregation is in SQL on `transactions` (+ joins to `envelopes`/`categories`); no row-level processing in app code. Money returns as strings (paisa).

## 2. Ranges (§13.2)

```ts
type RangeKey = 'this_month' | 'prev_month' | 'last_3' | 'last_6' | 'last_12' | { custom: { from: LocalDate; to: LocalDate } };
resolveRange(key, today: LocalDate): { from: LocalDate; to: LocalDate; months: LocalDate[] /* first-of-month list */; label }
previousPeriod(range): { from; to }      // same length, immediately preceding (for "vs previous")
```
- `this_month`: first-of-month … `today`. `prev_month`: previous calendar month. `last_N`: N calendar months ending with the current month (current month partial), i.e. `from = first day of (current − (N−1)) months`.
- Custom: validated `from ≤ to ≤ today`, span ≤ 5 years (`VALIDATION`). Default `this_month`; selection persisted in `sessionStorage` (per session, §13.2).
- Previous period for month-based ranges = the same number of whole months immediately before; for `this_month` (partial) compare to the **same elapsed days of the previous month** (apples to apples) — documented decision; custom = equal-length preceding window.

Pure functions in `domain/analytics/ranges.ts` with exhaustive tests (year boundary, leap Feb, `this_month` on the 1st, custom across Dec→Jan).

## 3. Queries (all parameterised, all `user_id`-scoped)

Shared CTE `base`:
```sql
WITH base AS (
  SELECT t.id, t.type, t.amount_paisa, t.occurred_on, t.category_id, t.envelope_id, e.owner_type
  FROM transactions t LEFT JOIN envelopes e ON e.id = t.envelope_id AND e.user_id = t.user_id
  WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.occurred_on BETWEEN $2 AND $3
)
```
Spend filter: `type='expense' AND ($4::bool OR owner_type='mine')`.

1. **Summary cards** — spent / income / net / adjustments for the range and for `previousPeriod` in one round trip (`UNION ALL` of two windows). `% change = (cur − prev) / prev` computed in app with BigInt→ratio using integer math to basis points (`bps = (cur-prev)*10000n / prev`), rendered as one decimal; **hidden ("—") when prev = 0** (§13.3). Spent/Income deltas get semantic copy ("down 12%" — down in spending is neutral/positive, not red; no colour-only meaning).
2. **Monthly series** — `generate_series(first_month, last_month, '1 month')` LEFT JOIN aggregated monthly sums so **zero months appear as 0**; returns `{month, spent, income}`. Ranges crossing year boundaries sort chronologically.
3. **By category** — `SELECT category_id, SUM(amount) … GROUP BY category_id ORDER BY 2 DESC`; join names (rename-safe via ID; archived categories included with an "archived" flag). App groups: top 7 + **Other** (sum of the rest). Percentages via largest-remainder (§4). Tapping a category → `/transactions?types=expense&categoryIds=…&from=…&to=…` (and `&includeHeld`) — the filter set exactly reproduces the slice (a test asserts the transaction-list total equals the chart slice).
4. **By envelope** — same shape grouped by `envelope_id` (spend only); includes archived envelopes; percentages summing to exactly 100 (§4).
5. **Top expenses** — top 5 by amount (`ORDER BY amount_paisa DESC, occurred_on DESC, id`), with envelope + category + date.
6. **Daily spending** (SHOULD) — current/selected month: `generate_series` of days LEFT JOIN daily sums; rendered as bars + heat strip; week boundaries per `users.week_start`.
7. **Adjustments line** — `SUM(amount)` and count of `adjustment` in range; displayed under the summary as "Includes N adjustments totalling −1,000 (not counted above)".

Indexes: `ix_tx_user_time`, `ix_tx_type`, `ix_tx_cat` (TD-01) are sufficient; add a covering partial index if needed after measuring:
`CREATE INDEX ix_tx_analytics ON transactions (user_id, occurred_on) INCLUDE (type, amount_paisa, category_id, envelope_id) WHERE deleted_at IS NULL AND type IN ('expense','income');`

Performance (FR/§13.3): < 300 ms at 50k transactions (benchmark in CI integration test with generated data).

## 4. Percentages that sum to exactly 100 (`domain/analytics/percent.ts`)
Largest-remainder method on integer basis points to one decimal? URD: "displayed % add to exactly 100". Use whole percents:
```ts
largestRemainder(values: Paisa[]): number[]   // returns integers summing to 100 (or all 0 when total = 0)
```
Algorithm: `exact_i = values_i * 100 / total` computed as BigInt quotient + remainder; floor each; distribute the remaining `100 − Σfloor` points to the largest remainders (ties → larger value, then lower index). Property test: for any non-negative vector with positive sum the result sums to 100 and each result is within 1 of the exact share.

## 5. Caching & invalidation
`unstable_cache(fn, ['analytics', userId, rangeKey, includeHeld], { tags: [`u:${userId}:analytics`], revalidate: 3600 })`. Every ledger-affecting action's `revalidate` list includes the user's analytics tag (TD-00 §6 — done centrally in `defineAction` for any action flagged `bumpsLedger`). Cache never shared across users (key contains `userId`). The `integrity.check`/purge jobs don't need invalidation.

## 6. UI (`/analytics`)
- Range selector (chips + custom date picker, 44 px targets), "Include money held for others" toggle (off by default), summary cards (Spent, Income, Net, vs previous), monthly bar/line chart (Recharts), category donut + ranked list, envelope shares, top 5, daily bars, adjustments note.
- **Accessibility:** every chart has an adjacent "View as table" toggle rendering the same data (`<table>` with captions); colour palette passes AA and is colour-blind safe (Okabe–Ito based) **plus** per-series patterns/labels; tooltips on tap; `aria-label` summarising each chart ("Spending by category: Groceries 32%, …").
- Empty state "No spending in this period" with link to add an expense; skeleton while loading; error state with Retry.
- Readable at 375 px: labels abbreviated, long category names truncated with full name in table view; donut legend becomes the list below.
- Dark-mode palettes defined as CSS variables.

## 6.1 Chart data contract
```ts
interface AnalyticsResponse {
  range: { from; to; label };
  summary: { spent; income; net; adjustments: {total; count}; prev: { spent; income; net }; changePct: { spent: number|null; income: number|null } };
  monthly: Array<{ month: LocalDate; spent: PaisaStr; income: PaisaStr }>;
  byCategory: Array<{ categoryId: string|null; name; archived: boolean; amount: PaisaStr; pct: number; isOther?: boolean }>;
  byEnvelope: Array<{ envelopeId; name; icon; archived: boolean; amount: PaisaStr; pct: number }>;
  topExpenses: Array<{ txId; amount; envelopeName; categoryName; date; note? }>;
  daily?: Array<{ date: LocalDate; spent: PaisaStr }>;
  includeHeld: boolean;
}
```

## 7. Tests owned (URD §21 41–43)
41 (only income/expense counted: fixture includes every other type; adjustments appear only on their own line), 42 (percent sum exactly 100 for adversarial vectors; zero months present; year-crossing ranges; 23:59 PKT on the 31st stays in its month; `this_month` previous-period alignment), 43 (renamed/archived category still appears; Others' envelope expenses excluded unless toggled; toggle changes totals deterministically), plus: category-slice ↔ transaction-list equality, cache invalidation after a write (value changes immediately), performance benchmark, empty range, custom range > 5 years rejected, `from > to` rejected.

## 8. Acceptance
Reference scenario step 9: spending equals only the recorded expenses (not the loan, repayment or Ahmed's withdrawal), income equals 150,000, adjustments line absent; shares add to 100; the table alternative shows identical numbers to the chart.
