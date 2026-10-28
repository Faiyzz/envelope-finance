# TD-10 — App Shell, Dashboard & Quick-Add

**URD coverage:** §11.1 (global UX), §11.2 (dashboard), §11.3 (quick actions + quick expense), §11.4/11.6 UI composition, accessibility/i18n/animation rules, FR-PERF-02 (optimistic UI), §24 "ten success questions".
**Depends on:** TD-00 … TD-09 (this is the composition layer). **Used by:** TD-12 (PWA shell), TD-13 (E2E).

---

## 1. Route map

| Route | Purpose | Doc |
|---|---|---|
| `/` | Dashboard | §4 |
| `/envelopes`, `/envelopes/[id]` | list, detail | TD-04 |
| `/transactions`, `/transactions/[id]` | Activity (global list), detail/edit | TD-05 |
| `/loans`, `/loans/[id]` | | TD-06 |
| `/recurring`, `/recurring/[id]` | | TD-07 |
| `/reconciliation` | | TD-08 |
| `/analytics` | | TD-09 |
| `/search` (also ⌘K dialog) | | TD-05 §8 |
| `/settings/*` | | TD-03 |
| `/onboarding`, `/login`, `/register`, … | public / gated | TD-02/03 |
| `/offline` | read-only offline viewer | TD-12 |
| `/api/health`, `/api/cron/daily`, `/api/export/*`, `/api/import` | non-UI | TD-00/11 |

Route groups: `(public)` (login/register), `(app)` (authenticated; layout does `requireUser`, onboarding gate, RecurringSync, providers). Every `(app)` page streams with `<Suspense>` skeletons.

## 2. Layout & navigation (§11.1)
- **Mobile (< 1024 px):** bottom nav `Home · Envelopes · ＋ · Activity · More`; ＋ opens the Quick-Actions sheet; More lists Analytics, Recurring, Reconciliation, Loans, Settings. Active tab uses icon + label + `aria-current="page"`.
- **Desktop (≥ 1024 px):** left sidebar: Dashboard, Envelopes, Transactions, Analytics, Recurring, Reconciliation, Loans, Settings; ＋ becomes a primary button in the header next to search (⌘K) and the hide-balances eye.
- Safe-area insets: `padding-bottom: max(env(safe-area-inset-bottom), 0.5rem)` on bottom nav; `viewport-fit=cover`.
- Touch targets ≥ 44×44 px (Tailwind `min-h-11 min-w-11`); inputs 16 px+; `inputmode="decimal"` on money inputs.
- Breakpoints: default (≥320), `md` 768, `lg` 1024. Verified at 320 px width and 200 % text zoom (test 50).

## 3. Design system essentials
- Tokens as CSS variables (`--bg`, `--surface`, `--text`, `--muted`, `--accent`, `--success`, `--warning`, `--danger`, categorical palette `--c1..c8`) defined for light, dark, and `prefers-contrast: more`. Radius 16–24 px cards, shadows subtle (none in dark; use border). Spacing scale 4/8/12/16/24/32/48.
- Typography: Inter (self-hosted via `next/font/local`), `font-variant-numeric: tabular-nums` for all money (`.money` class). Large numerals for balances.
- `<Money value={paisa} sign="auto|always" />` is the **only** component that renders amounts: right-aligned in lists, expense "−", additions "+", true minus U+2212, negatives get icon + text cue (never colour alone), respects `hideBalances` (renders `••••` with `aria-label="Amount hidden"`), and exposes `aria-label="2,500 rupees"` for screen readers.
- Status components never rely on colour: `<StatusChip icon text tone>`.
- Motion: Framer Motion with a central `useMotion()` that returns zero-duration variants when `prefers-reduced-motion`. Number count transition ~400 ms (skipped when reduced-motion or hide-balances); card update pulse; success check; sheet slide.
- Messages: `messages/en.ts` only (TD-00 §4.4); no physical left/right classes.

## 4. Dashboard (§11.2)

### 4.1 Data (single read function, one round trip)
`getDashboard(userId, today)` — RSC, `unstable_cache` is **not** used for the balance data (must be fresh); relies on tag revalidation after writes and a fast query:
```ts
interface DashboardData {
  total: Paisa; yourMoney: Paisa; heldForOthers: Paisa; unallocated: Paisa;      // ledger_totals (TD-01)
  reconStatus: ReconStatus;                                                       // TD-08 §5
  attention: AttentionItem[];                                                     // §4.4
  envelopes: EnvelopeCard[];                                                      // TD-04 §6 (active only)
  upcoming: UpcomingItem[];                                                       // TD-07 §6 (top 5)
  recent: TxRow[];                                                                // last 5
  setup: { hasOpeningBalance: boolean; hasEnvelopes: boolean };
}
```
Implemented as 6 parallel queries on **one pooled connection inside a single read-only txn** (consistent snapshot, avoids torn totals) via `Promise.all` over the same `tx`. Target p95 < 300 ms (FR-PERF-01).

### 4.2 Layout (top to bottom)
1. **Total Balance** (large, count-up animation) + reconciliation chip.
2. Three tiles **Your Money · Held for Others · Unallocated**. Tap: Your Money → envelopes (mine); Held → envelopes (others); Unallocated → "Assign money" sheet (TD-04 allocate, pre-filled to the full unallocated amount; disabled with explanation when 0).
3. **Attention strip** (only when needed; each item dismissible where noted).
4. **Envelope cards**: Mine first, then a "Held for others" subheader. 2-column grid on mobile (horizontal scroll alternative setting not needed), 3–4 columns on desktop. Card tap → detail. Loan chips on card.
5. **Upcoming** recurring (next 5 within 30 days).
6. **Recent activity** (5 rows + "See all").
- Pull-to-refresh on mobile (custom: touch-drag at scroll-top → `router.refresh()`; disabled when offline).
- Hide-balances eye toggle (header) — TD-03 §3.2.

### 4.3 Reconciliation chip
States and copy from TD-08 §5; tapping opens `/reconciliation`.

### 4.4 Attention strip rules
In priority order, max 3 shown + "N more":
1. Recurring `needs_attention` occurrences (card per item with the four actions, TD-07 §5.3).
2. Integrity check failed on last run (TD-01 §10) → "We found something odd in your records — review".
3. Reconciliation not verified for > 14 days (D: soft nudge) → "You haven't checked with your bank in 18 days" [Verify now] [Dismiss]; dismissal stored in `localStorage` for 7 days.
4. Rules auto-paused (`envelope_archived`) → "Netflix is paused — pick another envelope".
5. New app version available (from SW) is shown as a toast, not here.

### 4.5 Empty / loading / error
- No envelopes: illustration + "Create your first envelope" CTA; Unallocated tile still shows money.
- No opening balance (skipped onboarding): "Set your opening balance" CTA (TD-03 §2).
- Skeletons for each section (shape-matching); error boundary per section with Retry (a failing "Upcoming" must not blank the dashboard).

### 4.6 "Ten V1 success questions"
URD §24 requires the dashboard to answer the ten questions from the original spec §60, which is **not included in the supplied URD** (see GAP_ANALYSIS U-02). Until the owner supplies it, the design commits to these ten (each answerable on the dashboard or one tap away) — replace if the owner's list differs:

1. How much money do I have in the bank (expected)? — Total
2. How much of it is truly mine? — Your Money
3. How much am I holding for other people? — Held for Others
4. How much is not assigned to anything? — Unallocated
5. How much is left in each envelope? — Envelope cards
6. Does my record match my bank? — Reconciliation chip
7. What did I spend recently? — Recent activity (+ Analytics one tap)
8. Which envelopes owe/are owed money? — Loan chips (+ Loans one tap)
9. What bills are coming and are any unfunded? — Upcoming + attention strip
10. Where is my money going this month? — Analytics (one tap), plus envelope "This month" on detail

## 5. Quick-Add (＋) (§11.3)

### 5.1 Quick-actions sheet
Grid of: Add Expense · Add Income · Add Money to Envelope · Move Between Envelopes · Create Loan · Repay Loan · Create Envelope · Add Recurring · Record Held Money · Return Held Money. Fixed order as listed (Expense first); no usage-based reordering in V1, to avoid extra state. Each opens the corresponding form in a bottom sheet (mobile) / dialog (desktop). Forms are routable (`/?add=expense`) so deep links and the PWA shortcut (`/?add=expense`) work.

### 5.2 Quick expense (≤ 4 taps typical; speed is top priority)
Single screen, keypad-first:
1. **Amount** — autofocus numeric (`inputmode="decimal"`); live parse via `evaluateAmountExpression` (TD-01 §2.2) showing the evaluated total under the field ("1,550 PKR"); invalid input shows inline hint, no `eval`.
2. **Envelope** — horizontally scrollable chips (balance under each name). Default = **last-used envelope** (most recent non-deleted expense's envelope, derived server-side in the sheet's loader, falling back to first Mine envelope). Zero-balance envelopes shown but flagged "0 left". If amount > balance the chip shows an inline warning and the save path offers *Add money / Borrow* (TD-04/06).
3. **Category** — defaults to the last-used category for that envelope (TD-05 §9.3); recent first; search box.
4. **Note & date (optional, collapsed)** — date chips Today / Yesterday / Pick (date picker); note textarea (≤500, counter).
5. **Save** (primary, 56 px) → optimistic UI → haptic (`navigator.vibrate(10)` when available) → check animation → toast **"Saved −1,550 from Home · Undo"** (6 s). **Save & add another** keeps the sheet open, retains envelope/category/date, clears amount/note.
Tap count with defaults: type amount (keypad) → Save = 2 taps; changing envelope = +1; changing category = +2 (open + choose).

### 5.3 Optimistic updates with rollback (FR-PERF-02)
`useOptimistic` over the dashboard/envelope/transactions view state:
1. On submit, apply the predicted effect via the same pure ledger-effects mirror (`domain/ledger/effects.ts`) to the *visible* balances and prepend the row (marked pending, reduced opacity).
2. Server action returns authoritative `balances` (TD-05 §2). On success the pending row is replaced and balances reconciled.
3. On `ok:false` → rollback to previous state, keep the form populated, show the plain-language error with its `actions` (Add money / Borrow). `TIMELINE_VIOLATION` shown as inline alert.
4. Idempotency key generated per submit attempt (`crypto.randomUUID()`), reused on retry of the *same* attempt.
5. `revalidateTag` after success refreshes any other open views.

### 5.4 Pending-intent resume
Shared with TD-06 §4: when the user takes "Borrow from another envelope" the form state is persisted and restored on return.

### 5.5 Other forms
Each form is a thin client component over its Zod schema (`@hookform/resolvers/zod`): Income (amount, category, optional splits editor with live "Unallocated: X" line and remaining-to-assign), Allocate/Move/Create Loan/Repay/Create Envelope/Recurring/Held money — each shows the **balance of every selectable envelope** and disables Save with an explanation instead of failing after submit where the condition is known client-side (server remains authoritative).

## 6. Shared components
### 6.1 Sheets & dialogs
Radix Dialog/Drawer: focus trap, `Esc`/back-swipe closes, returns focus to the trigger, `aria-modal`, scroll lock, keyboard-aware (visualViewport) so the Save button stays visible above the iOS keyboard.
### 6.2 `<MoneyInput>`
Controlled text input; formats with grouping on blur only (never while typing, to avoid cursor jumps); accepts Arabic-Indic digits; exposes `onChange(parsed: ParseResult)`; paste handling strips currency text ("PKR 2,500"); supports calculator mode (`allowExpression`).
### 6.3 Toasts
`sonner`-style queue, `role="status"` / `aria-live="polite"`; Undo button focusable; auto-dismiss 6 s pause-on-hover/focus; stacking limit 3.
### 6.4 Live announcements
`<LiveRegion>` announces balance changes after writes: "Home is now 47,500 rupees" (not on hide-balances).
### 6.5 Skeleton / Empty / Error primitives with consistent props (`title`, `body`, `cta`, `onRetry`).

## 7. Accessibility checklist (WCAG 2.1 AA)
Semantic landmarks (`header`, `nav`, `main`), skip link, labelled inputs, error text associated with `aria-describedby`, visible focus ring, contrast ≥ 4.5:1 text / 3:1 UI (checked in CI with axe on key pages in light+dark), no colour-only meaning, reduced-motion support, screen-reader labels on money and status, drag alternatives (TD-04 §3.5), focus management in sheets, 200 % zoom, 320 px reflow. Test 50.

## 8. i18n readiness
All strings in `messages/en.ts`; ICU-style plural helper for "1 change / 3 changes"; dates formatted via `Intl.DateTimeFormat` with the user locale `en-PK` (but grouping of money is ours); logical CSS; no concatenated sentences (full templates).

## 9. Tests owned (URD §21 49–51 partly, plus UI)
51 (quick expense ≤ 4 taps with defaults; Undo restores correctly), 50 (a11y matrix), optimistic rollback (forced server error), pending-intent resume, quick-add keyboard/paste/calculator (`1200+350` → 1,550; garbage rejected), hide-balances SSR, nav at 320/768/1024, last-used defaults cross-device (derived from DB), dashboard sections isolate failures.

## 10. Acceptance
Fresh onboarded user logs a Groceries expense in ≤ 2 taps after typing the amount; dashboard, envelope detail, activity list and analytics all show the new numbers on the next render with no manual refresh; failing the server call restores the previous numbers and keeps the user's input.
