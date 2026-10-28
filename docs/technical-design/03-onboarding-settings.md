# TD-03 — Onboarding & Settings

**URD coverage:** §7 (FR-ONB-01…03), §16 (Settings), FR-ONB opening-balance edit, time-zone rules (§4.4/§16), "Recently deleted" screen (§4.5), hide-balances (§11.2).
**Depends on:** TD-00, TD-01, TD-02 (accounts/sessions UI), TD-04 (envelope/allocation commands), TD-05 (restore). **Used by:** TD-10 (shell), TD-11 (Data page).

---

## 1. Onboarding

### 1.1 Gate
`users.onboarding_completed_at IS NULL` ⇒ authenticated routes redirect to `/onboarding` (middleware cannot see this; the `(app)` layout does a server-side check using `requireUser().user.onboardingCompletedAt`). The flag is set by **either** completing the wizard **or** "Set up later". A user who skipped and still has no opening balance sees the dashboard empty state *"Set your opening balance"* (TD-10 §4.7), computed from `NOT EXISTS opening_balance transaction`, not from the flag.

### 1.2 Wizard (client state, single commit — FR-ONB-03)
Wizard keeps all state client-side (Zustand store persisted to `sessionStorage` so a refresh does not lose it) and commits **once** at the end with `completeOnboarding`; abandoning midway therefore leaves *no* partial data.

Steps:
1. **Welcome** — one-sentence explanation + illustration.
2. **Opening balance** — "Enter your actual bank balance now". Amount input uses the shared `<MoneyInput>` (TD-10 §6.2); value ≥ 0 (0 allowed, TD-D4). Date defaults to today, hidden under "Advanced".
3. **Envelopes** — suggestion chips (Home, Personal, Savings, Emergency) + "Custom" + "Money held for someone" toggle ("This money belongs to someone else" → owner name required, FR-ONB-02). Per envelope: name, icon, kind, amount to allocate from Unallocated.
4. **Summary** — live `Total / Allocated / Unallocated`. Validation: Σ allocations ≤ opening balance (Save disabled with "You've assigned 5,000 more than your balance"); duplicate names rejected case-insensitively.
5. **Finish** → dashboard. "Set up later" is available on steps 1–4 (calls `skipOnboarding`).

### 1.3 Actions
```ts
completeOnboarding(input: {
  idempotencyKey: UUID;
  openingBalance: PositivePaisaStr | '0';
  openingDate?: LocalDate;                       // default today
  envelopes: Array<{ name; icon?; color?; kind: 'standard'|'savings'; ownerType: 'mine'|'other';
                     ownerName?: string; allocate: PaisaStr /* ≥0 */ }>;
}): ActionResult<{ envelopeIds: string[] }>
skipOnboarding(): ActionResult<void>             // sets onboarding_completed_at only
```
`completeOnboarding` (one `withUserWrite`):
1. Reject if the user already has an `opening_balance` tx → `RULE_VIOLATION` ("You've already set your opening balance — edit it in Settings → Finance") — this makes a double submit harmless (plus idempotency).
2. Insert `opening_balance` (note: "Opening balance").
3. For each envelope in order: create envelope (TD-04 §3.1 rules), and if `allocate > 0` insert an **`allocation`** transaction (also for `owner_type='other'` — FR-ONB-02: the money was already in the opening balance, so it is *not* an `external_deposit`). `occurred_on` = opening date, `occurred_at` = `00:00:00` for the opening balance and `00:00:01…` incrementing for allocations so canonical order is deterministic and Unallocated never dips negative.
4. Verify timeline; set `onboarding_completed_at = now()`.

### 1.4 Edge cases
- Opening balance 0 with envelopes allocating > 0 → blocked by Σ rule.
- Reaching `/onboarding` after completion → redirect to `/`.
- Skip then later opening the same wizard from the empty-state CTA: wizard opens at step 2 and uses the same `completeOnboarding` (flag already set; step 1 of the action rejects only if an opening balance exists).

## 2. Opening balance management (FR-ONB-01)

`setOpeningBalance({ amount, date?, version? })`:
- No opening balance yet → insert (same rules as above).
- Exists → **edit** (`version` required, optimistic concurrency). Amount may increase freely; **decrease and date changes are validated by the full timeline verifier** (TD-01 §6) — error names the first violating date/envelope.
- Date may not be moved later than the earliest other transaction's timestamp (the verifier catches this naturally: Unallocated would go negative earlier).
- Delete is refused while other non-deleted transactions exist: `RULE_VIOLATION`"You can't delete your opening balance while you have other transactions. Edit the amount instead." If it is the only transaction, delete is allowed.
Location: Settings → Finance (primary) and the transaction detail screen of that row.

## 3. Settings

Routes under `/settings`: `account`, `finance`, `appearance`, `categories`, `envelopes`, `recurring`, `data`, `security`, `about`. Mobile: Settings is a list page → sub-pages (back button). Desktop: master/detail.

| Page | Contents | Backing spec |
|---|---|---|
| **Account** | name, email (password required), password change, log out, log out all, delete account | TD-02 §3 |
| **Finance** | Currency (PKR read-only); opening balance edit (§2); **time zone**; number grouping (`western` default, `lakh` option); week start (Mon default; Sun/Sat allowed) | §3.1 |
| **Appearance** | theme (system/light/dark); "Hide balances by default" | §3.2 |
| **Categories** | list/create/rename/archive/merge | TD-05 §9 |
| **Envelopes** | list, reorder (up/down controls + drag), archive/unarchive, archived list | TD-04 |
| **Recurring** | manage rules, needs-attention list | TD-07 |
| **Data** | Export JSON/CSV, Import JSON, Recently deleted, Run integrity check | TD-11, §4, TD-01 §10 |
| **Security** | active sessions list + revoke; app-lock "coming later" | TD-02 |
| **About** | version/build (`NEXT_PUBLIC_APP_VERSION`), PWA install help, links to licences | TD-12 |

### 3.1 Preferences actions
```ts
updatePreferences(input: Partial<{ theme; numberGrouping; weekStart; hideBalancesDefault; timezone }>): ActionResult<UserPrefs>
```
- `timezone` validated against `Intl.supportedValuesOf('timeZone')`. **Changing it never rewrites stored `occurred_on` dates** (D: stored dates are not shifted). The UI shows a one-time warning: "Only new entries will use the new time zone. Existing dates stay as recorded." Because "today" is derived from the zone, a user moving west may legitimately be unable to enter a date that is "tomorrow" in their old zone; this is correct behaviour.
- `numberGrouping` affects `formatMoney` only; stored as user pref and passed via `UserCtx` to a `FormatProvider` (RSC + client).
- `weekStart` affects only week-based UI (daily spending chart week labels, calendar pickers); analytics ranges are calendar months.
- Optimistic concurrency: `users.updated_at`; last-write-wins is acceptable for preferences (documented).

### 3.2 Theme and hide-balances
- Theme: `next-themes` with `attribute="class"`, stored in `users.theme` and mirrored in a non-httpOnly cookie `theme` read by the root layout to avoid a flash (SSR sets `class` before paint).
- Hide-balances toggle (header eye icon): per-device, persisted in `localStorage` **and** a `hide_balances` cookie (so the server renders masked values on first paint — no leak flash). Initial value = `users.hide_balances_default`. When on, `<Money>` renders `••••` and sets `aria-label="Amount hidden"`. Masking is purely presentational; data is still in the RSC payload (documented — it protects against shoulder-surfing, not malicious scripts).

## 4. "Recently deleted" (URD §4.5)

Settings → Data → Recently deleted:
- List: transactions with `deleted_at > now() − 30d`, newest-deleted first, cursor pagination (page 30). Each row: type icon, amount, envelope, note, original date, "Deleted 3 days ago · restorable for 27 days".
- Action `restoreTransaction(id)` (TD-05 §7). On `TimelineViolation` the row shows the plain-language reason (e.g. "Can't restore: it would leave Home at −2,000 on 12 Oct. Restore the salary first.").
- Loan-related rows restore through the Loans module (TD-06 §7) — the button there says "Restore loan".
- "Empty trash" is **not** provided (purge is automatic at 30 d).

## 5. Data page behaviours
- Export/Import: TD-11.
- **Run integrity check** button → `runIntegrityCheck()` (TD-01 §10) → results card (✔ all passed / ⚠ n findings with plain-language list). Never offers "fix".

## 6. Tests owned
- Onboarding: happy path numbers; Σ allocation > opening rejected; others' envelope created via `allocation` not `external_deposit` (Total unchanged, `Held for Others` = amount); skip → empty state; double submit idempotent; abandon leaves zero rows; refresh keeps wizard state.
- Opening balance: reduce below allocated → rejected with violating date; delete refused when other tx exist; edit with stale version → `CONFLICT`.
- Settings: timezone change leaves old dates intact; grouping `lakh` formats `200000` → `2,00,000` and parse still accepts both; hide-balances SSR renders masked first paint (Playwright with cookie).
- Recently deleted: 31-day-old row absent; restore re-validates.

## 7. Acceptance
A fresh seeded user completes onboarding with 200,000 / Home 50,000 / Personal 80,000 / Savings 30,000 / Ahmed(other) 20,000 and the dashboard shows Total 200,000, Unallocated 20,000, Your Money 180,000, Held 20,000 (URD §22 step 1). Killing the browser between steps 3 and 4 leaves the database untouched.
