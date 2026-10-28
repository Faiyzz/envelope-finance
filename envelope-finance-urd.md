# Envelope Finance App — User Requirements Document (URD) v1.0

**Audience:** An AI coding agent (or developer) who will implement the app end to end.
**Product:** Mobile-first PWA for virtual-envelope money management over ONE real bank balance (PKR).
**Status:** Implementation-ready. Where the original idea document was ambiguous or contradictory, this URD makes an explicit decision, marked **[DECISION]**. If a decision conflicts with the owner's intent, the owner can change it, but the implementer must not silently deviate.

---

## 0. How to use this document (instructions to the implementing AI)

1. Read the whole document before writing code. Section 4 (Ledger Model) is the heart of the system. Everything else depends on it.
2. Requirement IDs (e.g. `FR-LOAN-07`) are stable. Reference them in code comments, tests and commit messages.
3. "MUST" = mandatory. "SHOULD" = strongly recommended. "MAY" = optional.
4. Build in the phases in Section 20. Do not start a phase until the previous phase's acceptance tests pass.
5. Never use floating point for money. Never store balances as authoritative columns. Never silently adjust numbers to make reconciliation match.
6. Every database read/write MUST be scoped by `user_id`. A user must never be able to read or mutate another user's data, even by guessing IDs.
7. When something is not specified, choose the simplest behaviour that preserves the Core Invariants (Section 3), and list the choice in a `DECISIONS.md` file in the repo.

---

## 1. Product summary

The user has one real bank account. The app divides that money *virtually* into **envelopes** (purposes or people) plus an **Unallocated** pool. The app calculates an **Expected Total Balance** from its own ledger; the user manually types their **Actual Bank Balance**; the app compares the two and never auto-corrects.

Key concepts:

| Concept | Meaning |
|---|---|
| Total Balance | Expected total money in the bank according to the ledger |
| Envelope | A named virtual pot, owned by the user ("Mine") or by someone else ("Held for others") |
| Unallocated | Part of the total not assigned to any envelope |
| Your Money | Unallocated + all "Mine" envelopes |
| Held for Others | Sum of all "Someone else's" envelopes |
| Internal Loan | Temporary move of money from one of my envelopes to another, tracked until repaid |
| Reconciliation | Manual comparison of Expected vs Actual bank balance, recorded as history |

**Out of scope for V1:** bank APIs, auto-import, multiple currencies, investments/crypto/stocks, credit cards, tax, forecasting, shared/family accounts, collaborative envelopes, a physical-cash account, budget-limit alerts ("you overspent").

---

## 2. Users and context

- Primary user: one individual in Pakistan using a phone (iOS Safari / Android Chrome), sometimes desktop.
- Single currency: PKR. Locale `en-PK`. Timezone default `Asia/Karachi` (UTC+5, no DST).
- Typical session: 10–30 seconds to log an expense. Speed of the quick-add flow is a top priority.
- Many users will be non-technical: error messages MUST be plain-language and say what to do next.

---

## 3. Core invariants (MUST hold at all times, enforced in code AND database where possible)

- **INV-1** `Expected Total = Σ(all envelope balances, including archived) + Unallocated`. This is true *by construction* because Unallocated is derived (Section 4.3).
- **INV-2** No active envelope balance is ever < 0.
- **INV-3** Unallocated is never < 0.
- **INV-4** Balances are derived from the transaction ledger. No stored balance column is authoritative. (A cache is allowed but must be rebuildable and verified by an integrity check; see FR-INT-03.)
- **INV-5** Loans, allocations, deallocations and transfers never change Expected Total.
- **INV-6** Only `income` and `expense` transactions appear in income/spending analytics (plus the explicit exceptions in Section 13).
- **INV-7** Reconciliation never changes balances. Only an explicit, separate, user-confirmed Adjustment can (FR-REC-08).
- **INV-8** Every record belongs to exactly one user; cross-user references are impossible (composite FKs or checks).
- **INV-9** Money is an integer number of **paisa** (1 PKR = 100 paisa), stored as `BIGINT`. Never `float`/`double`/JS `number` arithmetic on fractional values.
- **INV-10** At every point in time (ordering by `occurred_on`, `occurred_at`, `created_at`, `id`), the invariants INV-2 and INV-3 hold. Backdated inserts and edits are validated against the whole timeline (Section 4.6).

---

## 4. Ledger model

### 4.1 Money representation

- **[DECISION]** Store amounts in paisa as `BIGINT`. UI shows whole rupees by default ("2,500 PKR") and shows decimals only when nonzero ("2,500.50 PKR"). Input accepts up to 2 decimals. Parse input as a string → integer paisa with a decimal-safe parser (no `parseFloat`).
- Maximum single amount: 999,999,999.99 PKR. Amount MUST be > 0 for every transaction type except `adjustment`, which may be negative (non-zero).
- Display formatting: `Intl.NumberFormat('en-PK')`-style western grouping (200,000) per the idea doc. **MAY** add a setting for lakh grouping (2,00,000) later.
- Negative numbers display with a true minus sign and a colour/shape cue (not colour alone).

### 4.2 Transaction types and their effects

All effects are in terms of `Total` (expected bank total), `Unallocated (U)`, and envelope balances.

| Type | Meaning | Total | Unallocated | Envelope(s) | Counts as |
|---|---|---|---|---|---|
| `opening_balance` | Starting bank balance at onboarding (one per user, editable) | +A | +A | – | none |
| `income` | New external money (salary etc.), optionally split into envelopes | +X | +(X − Σsplits) | each split envelope +split | **Income** |
| `external_deposit` | Another person gives money to hold | +X | – | their envelope +X | none (not income) |
| `expense` | Money spent from an envelope | −X | – | envelope −X | **Spending** |
| `external_withdrawal` | Other person takes their money back | −X | – | their envelope −X | none (not spending) |
| `allocation` | Unallocated → envelope | 0 | −X | envelope +X | none |
| `deallocation` | Envelope → Unallocated | 0 | +X | envelope −X | none |
| `transfer` | Mine envelope → Mine envelope, no loan record | 0 | – | from −X, to +X | none |
| `loan` | Lender → borrower, creates a Loan record | 0 | – | lender −X, borrower +X | none |
| `loan_repayment` | Borrower → lender against a Loan | 0 | – | borrower −X, lender +X | none |
| `adjustment` | Explicit correction after a mismatch | ±X | depends on target | target envelope or U | **Adjustment** (shown separately) |

**[DECISION]** `deallocation` and `transfer` are added to the original idea doc because users must be able to take money back out of an envelope without spending it. Without them the only way to fix an over-allocation would be a fake expense.

**[DECISION]** `external_deposit` / `external_withdrawal` are separate types so that Ahmed handing over 20,000 is not counted as the user's income, and Ahmed taking it back is not counted as the user's spending.

### 4.3 Derived values (single source of truth = SQL over ledger)

```
Total            = Σ effect on Total of all non-deleted transactions with occurred timestamp <= now
EnvelopeBalance  = Σ envelope effects for that envelope
Unallocated      = Total − Σ(all EnvelopeBalance)           # derived, never stored
YourMoney        = Unallocated + Σ(EnvelopeBalance where owner_type = 'mine')
HeldForOthers    = Σ(EnvelopeBalance where owner_type = 'other')
Borrowed(env)    = Σ remaining_amount of active loans where env is borrower
LoanedOut(env)   = Σ remaining_amount of active loans where env is lender
OwnFunds(env)    = balance − Borrowed(env)
```

- **FR-LED-01** Implement a `ledger_effects` SQL view (or equivalent query layer) that expands each transaction into signed postings `(user_id, transaction_id, account, delta)` where `account` is `TOTAL`, `UNALLOCATED`, or an envelope id. All balances come from aggregating this view. Do not duplicate the effect table in application code in more than one place.
- **FR-LED-02** `UNALLOCATED` is computed as `Total − Σ envelope balances`, which guarantees INV-1.
- **FR-LED-03** Display rule for loans (replaces the idea doc's "Owned/Borrowed" example, which breaks when a borrower spends borrowed money): show **Balance**, **Borrowed (owed back)**, and **Own funds = Balance − Borrowed**. If Own funds < 0 show a neutral note: "Home holds 2,000 but owes 5,000 to Personal." This is informational, not an error and not a red alert.

### 4.4 Ordering and time

- Each transaction has `occurred_on` (DATE, user-local), `occurred_at` (TIME, optional, default = now if date is today else 12:00), and `created_at` (TIMESTAMPTZ).
- Canonical order: `occurred_on, occurred_at, created_at, id`.
- **[DECISION]** Future-dated manual transactions are **not allowed** (date > today in `Asia/Karachi`). Error: "You can't record a transaction in the future. Use a recurring transaction for upcoming payments." Recurring items show as *Upcoming* projections only (Section 10).
- Backdating is allowed (user forgot to log yesterday) but is validated per Section 4.6.
- Midnight edge: "today" is computed in the user's timezone server-side, not from the client clock alone. Reject client dates that are > 1 day ahead of server-local today.

### 4.5 Soft delete and audit

- **[DECISION]** Transactions are soft-deleted (`deleted_at`, `deleted_by`) and excluded from all calculations; the idea doc says users can delete, and soft delete preserves an audit trail. A "Recently deleted" screen (Settings → Data) lets the user restore for 30 days; restoring re-runs the validation in 4.6 and fails with an explanation if it would break an invariant.
- An `audit_log` table records create/update/delete/restore of transactions, loans, envelopes, categories and recurring rules: `{id, user_id, entity, entity_id, action, before_json, after_json, at}`. Not user-visible in V1 except via export.

### 4.6 Timeline validation (the hardest rule — implement carefully)

Whenever a transaction is **created, edited, deleted, or restored**, or a loan/repayment changes, the server MUST verify that after the change, replaying the user's ledger in canonical order never makes any envelope balance < 0 or Unallocated < 0 **at any point in time** (not just now).

- **FR-VAL-01** Implementation: inside the DB transaction, compute running balances with window functions over the ledger for the affected envelopes only (those touched by the changed transaction before and after the change), starting from the earliest affected timestamp. Reject if any running balance < 0.
- **FR-VAL-02** On rejection, the error MUST name the cause in plain words, e.g. "Deleting this 150,000 salary would leave Home with −3,000 on 12 Oct (the grocery expense that day). Delete or edit that expense first." Include the first violating date, envelope and shortfall.
- **FR-VAL-03** Editing a transaction's envelope, amount, type, date, or loan link all count as "delete old + insert new" for validation purposes, in one DB transaction.
- **FR-VAL-04** Loans: at every point in time, a loan's `remaining_amount` ≥ 0 and ≤ `original_amount`, and a repayment cannot be dated before its loan.
- **FR-VAL-05** Reconciliation records are NOT revalidated (they are snapshots), but editing history after a record shows an "out of date" badge (FR-REC-10).

### 4.7 Concurrency and idempotency

- **FR-CON-01** All writes run in a DB transaction. Use a per-user advisory lock (`pg_advisory_xact_lock(hash(user_id))`) or `SERIALIZABLE` isolation with retry so two simultaneous writes cannot both pass validation and jointly break an invariant (e.g. two phones, double-tap).
- **FR-CON-02** Every create endpoint accepts a client-generated `idempotency_key` (UUID). Re-submitting the same key returns the original result and creates no duplicate. Keys are stored 24h per user.
- **FR-CON-03** Edits use optimistic concurrency: client sends `updated_at`/`version`; mismatch → 409 with "This was changed on another device. Reload to see the latest." and no overwrite.

---

## 5. Data model (PostgreSQL)

Use Drizzle or Prisma. Every table has `id` (UUID v7 or cuid), `user_id` (FK, `ON DELETE CASCADE`), `created_at`, `updated_at`. Add composite uniqueness / FKs so child rows can only reference parents with the same `user_id` (e.g. `(user_id, id)` unique on parents and composite FK on children).

### `users`
`id, name, email (citext, unique), password_hash, timezone (default 'Asia/Karachi'), currency ('PKR', fixed), theme ('system'|'light'|'dark'), onboarding_completed_at, failed_login_count, locked_until, created_at, updated_at`

### `envelopes`
`id, user_id, name, description, icon (emoji string), color (token name), owner_type ('mine'|'other'), owner_name (required if 'other'), kind ('standard'|'savings'), status ('active'|'archived'), archived_at, sort_order, created_at, updated_at`
- Unique `(user_id, lower(name))` among `status='active'`.
- CHECK `owner_type='other' → owner_name IS NOT NULL`.
- `kind='savings'` only changes presentation (progress/goal optional display, no monthly reset). **MAY** add optional `goal_amount`.
- `owner_type` is **immutable** once the envelope has any transaction (prevents silently turning someone else's money into the user's). Changing it requires archiving and creating a new envelope.

### `categories`
`id, user_id, name, kind ('expense'|'income'), group ('home'|'personal'|'other'|null), status ('active'|'archived'), is_system (bool), sort_order`
- Unique `(user_id, kind, lower(name))`.
- `is_system` = the built-in "Uncategorized" (one per kind) which cannot be archived or renamed.

### `transactions`
`id, user_id, type (enum from 4.2), amount_paisa BIGINT, occurred_on DATE, occurred_at TIME, envelope_id (nullable), counterpart_envelope_id (nullable), category_id (nullable), note (≤ 500 chars), loan_id (nullable), recurring_id (nullable), is_generated (bool), parent_transaction_id (nullable, e.g. paired rows), idempotency_key, deleted_at, version`
- CHECK constraints per type, e.g. `loan` requires `envelope_id` (lender), `counterpart_envelope_id` (borrower), `loan_id`, `envelope_id <> counterpart_envelope_id`; `expense` requires `envelope_id` and `category_id`; `income` requires no `envelope_id`; `allocation` requires `envelope_id`; `transfer` requires both envelopes; etc.
- `amount_paisa > 0` except `adjustment` (`<> 0`).
- Indexes: `(user_id, occurred_on desc, occurred_at desc)`, `(user_id, envelope_id)`, `(user_id, category_id)`, `(user_id, type)`, trigram GIN on `note`.

### `transaction_splits` (income only)
`id, user_id, transaction_id, envelope_id, amount_paisa`. Rule: `Σ splits ≤ income amount`; the remainder goes to Unallocated. Envelope must be active. No duplicate envelope in one income.

### `loans`
`id, user_id, lender_envelope_id, borrower_envelope_id, original_amount_paisa, remaining_amount_paisa (derived/cached, verified), status ('active'|'paid'), loan_date, note, paid_at, created_at, updated_at`
- CHECK `lender <> borrower`. Both envelopes `owner_type='mine'` (see FR-LOAN-02).
- `remaining` = original − Σ repayments (non-deleted). Always recomputable.

### `loan_repayments`
`id, user_id, loan_id, transaction_id (the loan_repayment tx), amount_paisa, repaid_on, created_at`

### `recurring_rules`
`id, user_id, name, type ('expense'|'income'), amount_paisa, envelope_id (nullable for income), category_id, split_template_json (income only: [{envelope_id, amount_paisa}]), frequency ('weekly'|'monthly'|'yearly'|'custom_days'), interval_n (default 1), anchor_day (1–31 for monthly), start_date, end_date (nullable), max_occurrences (nullable, for committees), occurrences_generated (int), next_due_date, status ('active'|'paused'|'completed'|'ended'), is_committee (bool), created_at, updated_at`

### `recurring_occurrences`
`id, user_id, rule_id, due_date, status ('generated'|'skipped'|'needs_attention'), transaction_id (nullable), note`. Unique `(rule_id, due_date)` guarantees a due date can never be generated twice.

### `reconciliations`
`id, user_id, checked_at TIMESTAMPTZ, expected_paisa, actual_paisa, difference_paisa (= actual − expected), note, adjustment_transaction_id (nullable), tx_count_at_check, last_tx_version_hash`

### `idempotency_keys`, `audit_log`, `sessions`/Auth.js tables
As needed.

### Deletion rules (FK behaviour)
- Envelope with ≥ 1 transaction/loan/recurring reference: **cannot be hard-deleted** (FR-ENV-08). Envelope with none: may be hard-deleted.
- Category referenced by any transaction: cannot be hard-deleted, only archived.

---

## 6. Authentication, accounts, security

- **FR-AUTH-01** Email + password registration, login, logout. Email stored lowercased (citext) and unique; validate format (Zod). Password min 10 chars, max 128; reject top common passwords; no composition rules beyond that.
- **FR-AUTH-02** Passwords hashed with argon2id (or bcrypt cost ≥ 12). Never log passwords or tokens.
- **FR-AUTH-03** Auth.js (credentials provider, database or JWT sessions with httpOnly, Secure, SameSite=Lax cookies). Session lifetime 30 days rolling; "Log out" invalidates the current session; "Log out of all devices" invalidates all.
- **FR-AUTH-04** Rate limiting: max 5 failed logins per email+IP per 15 min, then progressive delay/lock (`locked_until`). Generic error "Email or password is incorrect" (no user enumeration). Registration endpoint likewise must not reveal whether an email exists beyond a generic message when email verification is enabled.
- **FR-AUTH-05** **[DECISION]** Registration is controlled by env var `ALLOW_REGISTRATION` (default `true` in dev, `false` in production for a personal app). When false, `/register` returns 404 and only seeded/admin-created accounts can log in.
- **FR-AUTH-06** Seed account via environment variables only: `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME`. Seed script is idempotent (does nothing if user exists), and refuses to run in production unless `ALLOW_SEED=true`. No credentials in source.
- **FR-AUTH-07** Password change (requires current password, invalidates other sessions). **SHOULD** support password reset by email; if no email provider is configured, hide the "Forgot password" link and document a CLI/script reset.
- **FR-AUTH-08** Account deletion (Settings → Account → Delete account): requires password, typed confirmation "DELETE", offers JSON export first; cascades all data.
- **FR-SEC-01** Every query filtered by session `user_id`. Add automated tests that attempt cross-user access for every endpoint (IDOR tests). **SHOULD** also enable Postgres Row-Level Security as defence in depth.
- **FR-SEC-02** CSRF protection on all mutations (Next.js server actions provide origin checks; for API routes require same-origin + token). Strict CSP, `X-Content-Type-Options`, `Referrer-Policy`, HSTS.
- **FR-SEC-03** All user text (notes, names) rendered as text, never as HTML (XSS). CSV export MUST neutralise formula injection (prefix cells beginning with `= + - @` with `'`).
- **FR-SEC-04** Zod validation on every server input, trimmed strings, length caps (names ≤ 60, notes ≤ 500, descriptions ≤ 300).
- **FR-SEC-05** Secrets only via environment variables; `.env.example` provided; `.env` git-ignored.
- **FR-SEC-06** Optional app lock (PIN/biometric via WebAuthn) is **future**, not V1.

---

## 7. Onboarding (first run)

Flow after first login when `onboarding_completed_at IS NULL`:

1. Welcome: one-sentence explanation of envelopes.
2. **Enter your actual bank balance now** (creates the `opening_balance` transaction; value ≥ 0; may be 0).
3. **Create envelopes** (suggested chips: Home, Personal, Savings, Emergency, + custom; "Held for someone" option). For each: name, icon, amount to allocate from Unallocated.
4. Live summary: Total / Allocated / Unallocated. The user cannot allocate more than the opening balance. Remaining shows as Unallocated.
5. Finish → dashboard. Onboarding can be skipped with a "Set up later" link (dashboard then shows an empty state with a "Set opening balance" CTA).

Edge cases:
- **FR-ONB-01** Opening balance can be edited later (Settings → Finance, or transaction list). Reducing it is validated per 4.6. The opening balance transaction cannot be deleted while other transactions exist; only edited.
- **FR-ONB-02** If a user already has money held for others at start, the onboarding envelope step lets them tick "This money belongs to someone else" and enter the owner's name. That creates the envelope with an `allocation` (not an `external_deposit`, because the money was already in the opening balance).
- **FR-ONB-03** Abandoning onboarding midway must not leave half-created data: persist per step in a DB transaction, or keep client state and commit once at the end.

---

## 8. Envelopes

### 8.1 Behaviour

- **FR-ENV-01** Create envelope: name (required, unique among active, case-insensitive, trimmed), icon (emoji picker, default 💼), colour (optional token), description (optional), owner type (default Mine), owner name (required if Someone else's), kind (Standard/Savings). Initial funding is optional and creates an `allocation` (Mine) or `external_deposit` (Someone else's, increasing Total) per user choice. For "Someone else's", the form MUST ask: "Is this money already in your bank balance? (Yes → allocate from Unallocated / No → new money coming in)".
- **FR-ENV-02** Edit envelope: name, description, icon, colour, owner name, kind. Owner type is locked once transactions exist (see data model). Renaming to a name used by another active envelope is rejected.
- **FR-ENV-03** Envelope card shows: icon, name, balance, owner badge ("Not yours — held for Ahmed"), transaction count, loan chips ("Borrowed 5,000 from Personal", "Loaned out 5,000 to Home"), savings progress if goal set.
- **FR-ENV-04** Archived envelopes: hidden from dashboard, quick-add pickers and loan pickers; visible under Envelopes → "Archived" and in all history/filters/analytics.
- **FR-ENV-05** **Archive preconditions:** balance MUST be exactly 0 and no active loans in either direction. If balance > 0, show a sheet: for Mine → "Move remaining 4,000 to Unallocated and archive" (creates a `deallocation`) or "Cancel"; for Someone else's → "Record 4,000 returned to Ahmed and archive" (creates `external_withdrawal`) or "Move to Unallocated" (only if user confirms the money is now theirs, with a warning). If active loans exist: "Settle loans first" with links.
- **FR-ENV-06** **Unarchive** allowed any time; name conflict with an active envelope must be resolved by renaming first.
- **FR-ENV-07** Reordering: drag/long-press or up/down controls (accessible alternative); persisted in `sort_order`. Default order: Mine envelopes by sort order, then Others'.
- **FR-ENV-08** Hard delete allowed only for envelopes with zero transactions, loans and recurring references (e.g. created by mistake). Otherwise offer Archive only.
- **FR-ENV-09** Envelope detail page (Section 11.4) shows This Month: "spent X, added Y" where *added* = allocations + income splits + loan received + transfers in + external deposits, *spent* = expenses + external withdrawals (shown as "returned").
- **FR-ENV-10** Limits: soft cap 200 active envelopes (UI warning; no hard failure).

### 8.2 Allocation / deallocation / transfer

- **FR-ALLOC-01** Add money to envelope (Mine): amount ≤ Unallocated at that timeline point; else error "Only 20,000 is unallocated. Record income first or move money from another envelope."
- **FR-ALLOC-02** Add money to an "Others'" envelope from Unallocated is an allocation too, allowed (the money was already in the bank). New money from the other person is `external_deposit` (Total increases).
- **FR-ALLOC-03** Deallocate envelope → Unallocated: amount ≤ envelope balance (and, if the envelope has active borrowed funds, no extra restriction — loans are tracked separately).
- **FR-ALLOC-04** Transfer between two Mine envelopes: amount ≤ source balance. Source ≠ destination. **[DECISION]** Transfers between a Mine envelope and an Others' envelope are not allowed (that would mix ownership); use allocation/withdrawal flows instead.
- **FR-ALLOC-05** Moving money out of a borrower envelope's balance does not "forgive" loans; loans only change via repayment (or deletion rules in 9.4).

---

## 9. Internal loans

### 9.1 Creating a loan

- **FR-LOAN-01** Create loan: lender envelope, borrower envelope, amount, date, optional note. Posts a `loan` transaction + `loans` row in one DB transaction.
- **FR-LOAN-02** **[DECISION]** Both envelopes MUST be active and `owner_type='mine'`. Lending from or to another person's envelope is blocked: "Money held for Ahmed can't be lent out." (Protects other people's money.)
- **FR-LOAN-03** Lender ≠ borrower. Amount > 0. Amount ≤ lender's balance at that timeline point (INV-2). Show lender balance in the form and disable Save with an inline explanation when exceeded. Show the actionable alternative: "Add money to Personal first."
- **FR-LOAN-04** A loan never changes Total. The UI confirmation says: "Personal 45,000 (−5,000), Home 5,000 (+5,000). Total unchanged."
- **FR-LOAN-05** Multiple concurrent loans between the same pair and in opposite directions are allowed and tracked independently. **[DECISION]** No automatic netting.
- **FR-LOAN-06** Entry point from an envelope that lacks funds: when an expense fails with insufficient funds (FR-TXN-04), offer a one-tap "Borrow from another envelope" that pre-fills the loan form with borrower = this envelope, amount = shortfall, and returns to the pending expense after saving. The pending expense data MUST be preserved.

### 9.2 Repayment

- **FR-LOAN-10** Repay a specific loan: amount > 0, ≤ loan remaining, ≤ borrower's current balance at that timeline point. Posts a `loan_repayment` tx and a `loan_repayments` row; updates remaining; if remaining = 0 → status `paid`, `paid_at` set.
- **FR-LOAN-11** Partial repayments allowed; loan stays active with updated remaining.
- **FR-LOAN-12** "Repay all from Home to Personal" convenience: allocates oldest loans first until money or loans run out; creates one repayment per loan.
- **FR-LOAN-13** Overpayment is rejected, never turns into a reverse loan.
- **FR-LOAN-14** Repayment date ≥ loan date, ≤ today.
- **FR-LOAN-15** Paid loans stay visible in history ("Loans" tab, filter Paid) and in both envelopes' history, with full repayment timeline.

### 9.3 Display

- **FR-LOAN-20** Loans screen: tabs Active / Paid. Each row: "Personal → Home", original, repaid, remaining, date, progress bar.
- **FR-LOAN-21** Envelope detail shows two sections when relevant: "Borrowed" (this envelope owes) and "Loaned out" (this envelope is owed), each listing loans with Repay buttons (borrower side only).
- **FR-LOAN-22** Dashboard card chips: "Owes 5,000" on borrower, "Owed 5,000" on lender.

### 9.4 Editing and deleting loans (edge cases)

- **FR-LOAN-30** Edit a loan's note and date freely (date subject to ordering validation 4.6). Edit amount: new amount must be ≥ total already repaid, and timeline validation must pass.
- **FR-LOAN-31** Delete a loan: only if it has no repayments. If it has repayments, the user must delete repayments first (each validated). Deleting a loan removes its `loan` transaction too (soft).
- **FR-LOAN-32** Deleting a repayment reopens the loan (`paid` → `active`) and re-validates the timeline.
- **FR-LOAN-33** Loan-related transactions are edited **only** through the Loans UI; in the generic transaction editor they open the loan screen instead (prevents desync between `loans` and `transactions`).
- **FR-LOAN-34** Archiving an envelope with active loans is blocked (FR-ENV-05).
- **FR-LOAN-35** Loans are excluded from spending/income analytics (INV-6) and from "this month spent/added" unless shown in a separate "Loans" line.

---

## 10. Recurring transactions

### 10.1 Rules

- **FR-REC-01** Create rule: name, type (expense/income), amount, envelope (expense) or split template (income), category, frequency (weekly, monthly, yearly, every N days), start date, optional end date, optional max occurrences. Preview of the next 3 occurrences MUST be shown before saving.
- **FR-REC-02** Monthly rule on day 29/30/31: **[DECISION]** clamp to the last day of shorter months but keep the anchor day (31 → 28/29 Feb, 30 Apr, then back to 31). Never skip a month.
- **FR-REC-03** Start date may be in the past: the user chooses "Generate missed occurrences" (backfill, validated) or "Start from next occurrence".
- **FR-REC-04** Generation job: runs (a) on a scheduled cron (e.g. Vercel Cron daily at 00:05 Asia/Karachi) and (b) lazily on each authenticated app open, so it still works if cron fails. Idempotent via the unique `(rule_id, due_date)`.
- **FR-REC-05** When an occurrence is due, create the real transaction with `is_generated=true`, `recurring_id` set, and show a "Generated" badge (satisfies "not silently change the balance").
- **FR-REC-06** **Insufficient funds**: if an expense occurrence would make the envelope negative, DO NOT create it and DO NOT go negative. Create an occurrence with status `needs_attention`. Dashboard shows an attention card: "Spotify 1,099 due 1 Nov — Personal has only 600." Actions: "Add money", "Borrow from another envelope", "Skip this time", "Record anyway after funding" (re-runs the check).
- **FR-REC-07** Catch-up: if the app wasn't opened for several periods, generate every missed occurrence in order, each with its own due date as `occurred_on`, each validated; those that fail become `needs_attention`. Cap catch-up at 24 occurrences per rule per run (log a warning beyond).
- **FR-REC-08** Skip a single occurrence (no transaction; status `skipped`; it still counts toward `max_occurrences`? **[DECISION]** No, skipped occurrences do not count toward `max_occurrences`, the schedule extends by one). Pause/resume a rule (no occurrences generated while paused; on resume, user chooses "backfill missed" or "start from next").
- **FR-REC-09** Editing a rule affects **future** occurrences only; already generated transactions are unchanged. Deleting a rule stops future generation and keeps all generated history (rule is archived/`ended`). Editing/deleting a generated transaction does not alter the rule; deleting one generated transaction leaves its occurrence as `skipped`.
- **FR-REC-10** Archived envelope referenced by a rule: rule is auto-paused with a visible reason. Archived category: rule continues but flags "category archived — choose another".
- **FR-REC-11** Recurring income uses the split template; if a template envelope is archived, the share falls to Unallocated and the occurrence is marked with a note.
- **FR-REC-12** Upcoming list on dashboard: next 5 within 30 days, sorted by date, showing amount and "In 4 days" / "Tomorrow" / "Today" / "Overdue (needs attention)".
- **FR-REC-13** Year/leap edge cases (Feb 29 yearly → Feb 28 in non-leap years) follow the same clamp rule.

### 10.2 Committee (kameti)

- **FR-COM-01** Committee = recurring expense rule with `is_committee=true`, `max_occurrences` (e.g. 12), amount per month, start date. Rule detail shows: paid count, remaining count, total paid, total remaining, projected end date, progress bar.
- **FR-COM-02** On the final occurrence the rule becomes `completed` automatically.
- **FR-COM-03** **[DECISION]** The lump-sum payout the user receives from a committee is recorded manually as normal Income (category "Committee payout") — not auto-modelled in V1. Mention this in the UI help text.
- **FR-COM-04** Changing the committee amount mid-way affects future payments only.

---

## 11. Screens and UX requirements

### 11.1 Global

- Mobile-first (design at 375×812 first), responsive up to desktop. Bottom nav on mobile: **Home · Envelopes · ＋ · Activity · More**. Sidebar on ≥ 1024px: Dashboard, Envelopes, Transactions, Analytics, Recurring, Reconciliation, Loans, Settings.
- "More" contains: Analytics, Recurring, Reconciliation, Loans, Settings.
- Touch targets ≥ 44×44 px. Safe-area insets respected (iOS notch/home bar). Inputs use `inputmode="decimal"` so the numeric keypad opens; font-size ≥ 16px on inputs to prevent iOS zoom.
- Light/dark/system theme. Large numerals, rounded cards (16–24px), subtle shadows, generous spacing, strong type hierarchy (tabular numerals for money).
- Animations: number count transitions (~400ms), card update pulse, success check on save, bottom-sheet slide. Respect `prefers-reduced-motion` (disable non-essential motion).
- Every list/page has **loading skeletons**, **empty state** (illustration/text + primary CTA), and **error state** (plain message + Retry).
- Accessibility: WCAG 2.1 AA contrast, semantic HTML, labels for all inputs, screen-reader announcements for balance changes, focus management in sheets/modals, never rely on colour alone (use icons/text for mismatch, negative).
- All money in lists right-aligned, tabular figures; amounts for expenses prefixed "−", additions "+".
- Language: English UI V1; copy written to be easy to localise (no hard-coded strings in components; use a messages file). Urdu/RTL is a future phase, but do not use physical left/right CSS where logical properties (`ms-`, `me-`) work.

### 11.2 Dashboard

Top to bottom:
1. **Total Balance** (large) with reconciliation status chip (see 12.4 for states).
2. Three stat tiles: **Your Money**, **Held for Others**, **Unallocated**. Tapping a tile navigates (Unallocated → "Assign money" sheet; Held for Others → Others' envelopes).
3. **Attention strip** (only if needed): recurring needs-attention items, reconciliation unverified for > 14 days (**[DECISION]** soft nudge, dismissible).
4. **Envelope cards** (Mine first, then "Held for others" header). Horizontal-scroll or 2-column grid on mobile; tapping opens detail.
5. **Upcoming** recurring (FR-REC-12).
6. **Recent activity** (last 5 transactions) with "See all".
- Pull-to-refresh. Floating **＋** opens the quick actions sheet (Section 11.3).
- Empty state when no envelopes: "Create your first envelope".
- Privacy: a "hide balances" eye toggle (persisted locally) masks all amounts as "••••" for screen-sharing/public use. **SHOULD** have.

### 11.3 Quick-add (＋) actions

Add Expense · Add Income · Add Money to Envelope · Move Between Envelopes · Create Loan · Repay Loan · Create Envelope · Add Recurring · Record Held Money (external deposit) · Return Held Money (external withdrawal).

**Quick expense flow (≤ 4 taps typical):**
1. Amount (numeric keypad focused immediately; large display; calculator-style `+` allowed, e.g. "1200+350" evaluates safely without `eval`).
2. Envelope: defaults to the **last-used envelope**; shows each envelope's balance; envelopes with 0 balance shown but flagged.
3. Category: defaults to the last-used category for that envelope; recent categories first; search box.
4. Optional note, date (default today; quick chips Today/Yesterday/Pick).
5. Save → confirmation animation, haptic if available, toast with **Undo** (soft-delete, 6 seconds) .
- "Save & add another" button.
- After save, balances, dashboard, history and analytics update immediately (optimistic UI with rollback on server rejection).

### 11.4 Envelope detail

Header (icon, name, owner badge), Current Balance, Own funds / Borrowed / Loaned-out rows (only when relevant), This Month (spent / added), actions (Add expense, Add money, Move, Edit, Archive), filters (All / Income-adds / Expenses / Loans / Repayments + date, month, category), grouped transaction list (Today / Yesterday / date), infinite scroll or "Load more" (page size 30). Each row: category icon, note, amount, time; tap → transaction detail/edit.

### 11.5 Transactions page (global)

- Search box (debounced 250ms), filters: envelope(s), category(ies), type(s), date range, amount min/max, person (owner name), recurring (yes/no/generated), loan-related. Sort: Newest, Oldest, Highest, Lowest. Active filters shown as removable chips; "Clear all".
- Cursor-based pagination. Totals bar for the filtered result ("23 transactions · −38,000").
- Bulk actions (SHOULD, Tier 3): select multiple → change category/delete.

### 11.6 Transaction detail / edit

- Shows all fields, created/updated timestamps, linked items (loan, recurring rule, split breakdown).
- Edit any field subject to validation (4.6). Changing the type of a transaction is **not** allowed in edit (delete and recreate) except Expense ↔ Expense envelope/category changes. **[DECISION]** to avoid ledger-effect confusion.
- Delete → confirm sheet stating impact ("Home balance +2,500, Total +2,500") → soft delete + Undo toast.
- Duplicate action ("Add again") pre-fills the quick-add form.

### 11.7 Global search

- Search icon in header (and ⌘K/Ctrl+K on desktop). Searches across: envelope names/descriptions/owner names, transaction notes, category names, loan notes, recurring rule names, amounts (exact numeric match, e.g. "2500").
- Results grouped: Envelopes · Transactions · Loans · Recurring. Query "Ahmed" must return Ahmed's envelope, all transactions in it, loans involving it, and its deposit/withdrawal history.
- Implementation: Postgres `ILIKE` + `pg_trgm`; escape `%` and `_` in user input; min length 2 chars; max 50 results per group with "See all".
- Recent searches stored locally (clearable).

---

## 12. Reconciliation

### 12.1 Page
- Shows **Current expected balance**, input **Actual bank balance** (numeric), live **Difference = Actual − Expected**, status, optional note, and **Save check** button. Below: **Possible causes** list (static copy per spec §27) and **Recent transactions** (last 20, or all since the last matching reconciliation — whichever is larger up to 100) with quick edit access.
- Difference display: `0` → "✓ Everything reconciles"; positive → "Bank has 1,000 MORE than your records" ; negative → "Bank has 1,000 LESS than your records". Always show sign and plain words.

### 12.2 Requirements
- **FR-REC-R01** Expected = derived Total at the moment of check (server-computed, not client-sent; the client value is ignored/verified).
- **FR-REC-R02** Saving a check stores a snapshot: expected, actual, difference, timestamp, note, tx count, and a hash/version marker of the ledger at that moment.
- **FR-REC-R03** Checking is optional to save: the user can compute the difference without saving ("Just checking"). 
- **FR-REC-R04** Actual balance must be ≥ 0 (bank overdrafts out of scope: show "Negative balances aren't supported in V1").
- **FR-REC-R05** History table: Date, Expected, Actual, Difference, status icon, note. Records are immutable except the note; may be deleted (soft) individually.
- **FR-REC-R06** Never changes balances (INV-7).
- **FR-REC-08** **Optional adjustment**: when mismatched and saved, offer (never default-selected) "Fix difference with an adjustment". The sheet requires: choose where the difference lands (Unallocated by default; or a chosen envelope), a **mandatory note**, and a typed/explicit confirmation ("I understand this adds a correction of −1,000 to my records"). Creates an `adjustment` transaction linked to the reconciliation. Adjustments are shown with a distinct badge, excluded from spending/income analytics but shown in a separate "Adjustments" line. If a negative adjustment would drive the target below 0, reject (user must pick a funded target).
- **FR-REC-R07** Large mismatch warning (|diff| > 10% of total or > 50,000 PKR) prompts "Double-check you entered the bank balance correctly" (possible typo guard, e.g. missing zero). It does not block.
- **FR-REC-R08** Transposition hint: if difference is divisible by 9 and equals a plausible digit transposition, show an optional hint "This could be a typo in an amount (digits swapped)". (SHOULD, Tier 3)
- **FR-REC-R09** **Duplicate hint**: highlight possible duplicate transactions (same amount, envelope, date within ±1 day) in the recent list. **Missing-amount hint**: if a past transaction has an amount equal to |difference|, point to it.
- **FR-REC-10** After a saved check, if any transaction dated on/before the check is edited/added/deleted, that history row displays "Records changed since this check" (the stored expected value remains unchanged; the badge compares the snapshot hash).

### 12.4 Dashboard status states
1. **Never verified** — "Verify with your bank" (neutral).
2. **✓ Reconciled** — latest check difference = 0 and no ledger changes affecting Total since → green with date ("Verified today 14:05").
3. **Changes since last check** — latest check matched but transactions were added since → neutral/amber: "3 changes since you last verified (Oct 4)". This is *not* a mismatch.
4. **⚠ Mismatch** — latest check difference ≠ 0 and the ledger unchanged since: "⚠ 1,250 PKR mismatch".
5. If the user then fixes records so Expected now equals the last actual, status updates automatically to Reconciled (compare latest actual to current expected, annotate "based on your check of Oct 6").

---

## 13. Analytics

### 13.1 Definitions (strict — these implement INV-6)
- **Spending** = `expense` transactions only, in **Mine** envelopes by default. A toggle "Include money held for others" includes expenses from Others' envelopes.
- **Income** = `income` transactions only.
- **Excluded from both**: opening balance, allocations, deallocations, transfers, loans, repayments, external deposits/withdrawals, adjustments (shown on a separate "Adjustments" note if any exist in range).
- Dates use `occurred_on` in `Asia/Karachi`; month boundaries are calendar months in that timezone.

### 13.2 Ranges
Current month · Previous month · Last 3 / 6 / 12 months · Custom range (start ≤ end, max 5 years). Default = current month. Range selection persists per session.

### 13.3 Sections
1. **Summary cards**: Spent, Income, Net (Income − Spent), vs previous period (% change; hide % if previous = 0, show "—").
2. **Monthly spending** bar/line chart (one point per month in range; months with zero shown as 0, not omitted).
3. **Spending by category** donut + ranked list with amounts and %. Show top 7 + "Other" group; tap a category → filtered Transactions list. Uses category at time of query (rename-safe via ID); archived categories still appear.
4. **Spending by envelope**: share percentages summing to 100% (largest-remainder rounding so the displayed % add to exactly 100).
5. **Top expenses** list (top 5 by amount).
6. **Daily spending** heat/bars for current month (SHOULD).
- Each chart has a text/table alternative for accessibility and an empty state ("No spending in this period").
- Charts: Recharts, responsive, tooltips on tap, readable labels at 375px, colour palette that works in dark mode and for common colour-blindness (add patterns or labels).
- Performance: aggregate in SQL; target < 300ms for 50k transactions with indexes; cache per (user, range) with invalidation on writes.

---

## 14. Categories

- **FR-CAT-01** Seed defaults on user creation, as separate `expense` categories grouped by purpose:
  - Home: Electricity, Gas, Water, Internet, Rent, Groceries, Household, Maintenance, Daily Items, Eggs, Vegetables, Other (Home)
  - Personal: Food, Fuel, Shopping, Entertainment, Transport, Health, Other (Personal)
  - Income: Salary, Business, Gift, Committee payout, Other income
  - System: Uncategorized (expense), Uncategorized (income)
- **FR-CAT-02** Categories are **not** tied to envelopes (an expense may use any category), but the category picker sorts the group matching the envelope's name first (**[DECISION]** heuristic: name contains "home"/"house" → Home group; else show recent first).
- **FR-CAT-03** CRUD: create, rename, archive/unarchive. Rename keeps history (by ID). Names unique per kind (case-insensitive), 1–40 chars.
- **FR-CAT-04** Archiving removes from pickers but keeps history. A category cannot be hard-deleted if used.
- **FR-CAT-05** Merge categories (SHOULD): reassign all transactions from A to B in one DB transaction, then archive A.
- **FR-CAT-06** Expense categories apply to `expense` only; income categories to `income` only; other types have no category. A missing category on save defaults to "Uncategorized" — the UI still requires explicit selection in the quick flow but allows "Skip".

---

## 15. Transaction rules (consolidated validation)

- **FR-TXN-01** Required fields per type per 4.2/Section 5 CHECK constraints; the server returns field-level errors keyed by field name.
- **FR-TXN-02** Amount: positive, ≤ max, ≤ 2 decimals. Reject `NaN`, empty, commas misplaced; strip thousands separators on input; handle Arabic-Indic/Urdu digits (٠-٩, ۰-۹) by normalising to ASCII digits (SHOULD).
- **FR-TXN-03** Date: valid, not future, not earlier than **2000-01-01**; optional time.
- **FR-TXN-04** **Insufficient funds**: if an expense > envelope balance (at that timeline point), reject with "Home has only 2,000 PKR available." and offer: **Add money to Home** (allocation from Unallocated, if available; else "record income"), **Borrow from another envelope** (FR-LOAN-06). Never allow negative.
- **FR-TXN-05** Archived envelopes cannot receive new transactions (except by unarchiving). Archived categories cannot be chosen for new items (but remain on old ones, editing an old transaction keeps its archived category).
- **FR-TXN-06** Income splits: sum ≤ income amount; each split > 0; no duplicates; envelopes active. Remainder → Unallocated, displayed in the form as "Unallocated: X".
- **FR-TXN-07** Editing an income amount or splits: re-validate that no downstream balance would go negative (4.6).
- **FR-TXN-08** Notes: trim, collapse nothing, allow emoji, max 500 chars. Control characters stripped.
- **FR-TXN-09** Duplicate guard: when creating an expense identical (amount, envelope, category, date) to one created within the last 2 minutes, show a "Looks like a duplicate — add anyway?" prompt (idempotency key handles accidental double-submits silently; this handles deliberate double-entry).
- **FR-TXN-10** Deleting a transaction that is the only transaction in an envelope never deletes the envelope.
- **FR-TXN-11** Deleting an `external_deposit` while the other person's money has been spent/returned is rejected via timeline validation.
- **FR-TXN-12** `external_withdrawal`: amount ≤ the envelope's balance. If the user wants the money to go to Ahmed but the envelope is short, error explains the shortfall; no negative.
- **FR-TXN-13** Spending someone else's money (expense from an Others' envelope, e.g. buying something for Ahmed): allowed; row is badged "On behalf of Ahmed"; excluded from the user's spending analytics by default.

---

## 16. Settings

- **Account:** name, email (change requires password), password change, logout, logout all devices, delete account.
- **Finance:** currency displayed as PKR (read-only), opening balance edit, timezone (default Asia/Karachi; changing it only affects future date interpretation; **[DECISION]** stored `occurred_on` dates are not shifted), number grouping (western; lakh optional later), week start (Mon default).
- **Appearance:** theme, hide-balances default.
- **Categories:** Section 14.
- **Envelopes:** list, reorder, archive/unarchive.
- **Recurring:** manage rules (pause/resume/edit/end), view needs-attention items.
- **Data:** Export JSON, Export CSV, Import JSON (restore), Recently deleted, "Run integrity check" (FR-INT-03).
- **Security:** active sessions list with device/last seen and revoke; app lock = "coming later".
- **About:** version, build, PWA install help.

---

## 17. Import / export / backup

### 17.1 JSON backup
- **FR-BAK-01** Export includes: `schema_version`, `exported_at`, `app_version`, user profile (no password hash), envelopes, categories, transactions (incl. soft-deleted flagged), splits, loans, loan repayments, recurring rules and occurrences, reconciliations, settings. Amounts as integer paisa. IDs preserved.
- **FR-BAK-02** Filename `envelope-backup-YYYY-MM-DD.json`. On mobile use the share sheet / download.
- **FR-BAK-03** Import (restore): validate schema version and Zod shape, then **validate the whole ledger** (INV-1…INV-3 over the timeline, FK integrity, loan sums) *before* committing anything. Any failure → no changes, with a list of the first 20 problems.
- **FR-BAK-04** Import modes: **Replace everything** (default; requires typed confirmation and an automatic pre-import export prompt) or **Merge** (SHOULD NOT be built in V1; if not built, show only Replace). IDs are remapped to avoid collisions; `user_id` always overwritten with the current user.
- **FR-BAK-05** Import is atomic (single DB transaction) and idempotent per file hash (importing the same file twice with Replace yields identical data).
- **FR-BAK-06** Size limit 20 MB; show progress; reject non-JSON, wrong version with a clear message. Unknown future `schema_version` is rejected; older versions are migrated by versioned migrators.

### 17.2 CSV
- **FR-CSV-01** Exports: transactions (all fields incl. envelope & category names, type, signed amount in PKR, date, note), expenses only, income only, reconciliation history. UTF-8 with BOM (Excel-friendly), RFC 4180 quoting, ISO dates, formula-injection neutralisation (FR-SEC-03). Date-range filter option.

---

## 18. PWA, performance, offline

- **FR-PWA-01** Web app manifest (name, short_name, icons 192/512 + maskable, `display: standalone`, theme/background colours for light/dark, `start_url=/`), service worker via a maintained Next.js PWA integration (e.g. Serwist). iOS: apple-touch-icon, `apple-mobile-web-app-capable`, splash handling; show a one-time "Add to Home Screen" help card (Safari instructions, since iOS has no install prompt) and use `beforeinstallprompt` on Android.
- **FR-PWA-02** Offline V1: cache the app shell and last-fetched read-only data (dashboard, envelopes, last 100 transactions). When offline: show a persistent "Offline — showing saved data" banner; **disable all write actions** with an explanatory tooltip. (Offline queue is Tier 3/future.) Never display stale data without a "last updated" timestamp.
- **FR-PWA-03** Service worker updates: prompt "New version available — Reload" instead of silently swapping mid-form. Never cache authenticated API responses in a way that could leak between users on a shared device; clear caches on logout.
- **FR-PERF-01** Targets on a mid-range Android on 4G: LCP < 2.5s, INP < 200ms, dashboard API < 300ms p95. Use server components for static layout, streamed data, skeletons.
- **FR-PERF-02** Optimistic updates with rollback for add/edit/delete; revalidate affected queries.
- **FR-PERF-03** Pagination everywhere lists can grow (transactions, search, history).

---

## 19. Non-functional requirements

- **Stack (recommended, per owner's doc):** Next.js (App Router) + TypeScript, Tailwind CSS, shadcn/ui, Framer Motion, Recharts, Zod, Drizzle ORM (or Prisma), PostgreSQL (Neon or Supabase), Auth.js, Vercel deployment, PWA via Serwist.
- **Money library:** use a small integer-money helper module (`parseMoney`, `formatMoney`, `add`, `sub`) as the only place amounts are converted. Lint rule or test forbidding `parseFloat`/floating arithmetic on money.
- **Migrations:** versioned SQL migrations, reversible where feasible; run in CI; never edit applied migrations.
- **Environments:** `.env.example` with `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`, `ALLOW_REGISTRATION`, `SEED_ADMIN_*`, `CRON_SECRET`, optional email provider vars. Cron endpoint requires `CRON_SECRET` bearer.
- **Error handling:** typed domain errors (`InsufficientFunds`, `InvariantViolation`, `NotFound`, `Conflict`, `ValidationError`) mapped to user-friendly messages; unexpected errors logged server-side (no financial data in logs; amounts and notes redacted), generic message to user with a reference id.
- **Observability:** structured logs, Sentry-style error tracking (optional), health endpoint `/api/health`.
- **Backups (infra):** enable provider point-in-time recovery; document restore.
- **Time:** servers in UTC; all date logic through one timezone utility; unit-test month ends, leap years.
- **Browser support:** last 2 versions of Safari iOS, Chrome Android, Chrome/Edge/Firefox/Safari desktop.
- **Privacy:** no third-party analytics or trackers in V1; no financial data to third parties.
- **Accessibility, i18n-readiness:** per 11.1.
- **FR-INT-01** Domain logic (ledger, validation, loan math, recurrence) lives in a pure, framework-free TypeScript module with exhaustive unit tests; server actions only orchestrate.
- **FR-INT-02** Property-based tests (fast-check) generate random sequences of operations and assert INV-1…INV-6 after each step.
- **FR-INT-03** **Integrity check** (Settings → Data, and nightly job): recompute everything from the ledger and verify: INV-1, INV-2, INV-3, loan remaining = original − repayments, no orphaned references, cached values equal derived values. Report any discrepancy; never auto-fix.

---

## 20. Delivery phases and acceptance

**Phase 1 — Foundation:** project setup, DB schema + migrations, money utilities, ledger module with unit/property tests, auth (register/login/logout, seed), user scoping + IDOR tests, onboarding.
*Accept when:* a seeded user can log in, complete onboarding, and see correct Total/Unallocated; all invariant tests pass.

**Phase 2 — Core money flows (Tier 1):** envelopes CRUD/archive, expense, income (with splits), allocation/deallocation/transfer, categories, transaction list/detail/edit/delete (soft) with timeline validation, quick-add, dashboard, global search, reconciliation (page, history, adjustment).
*Accept when:* the Section 22 scenario passes end to end and all Section 21 Tier-1 tests pass.

**Phase 3 — Differentiators (Tier 2):** external-owner envelopes and held-money flows, loans + repayments, savings envelopes, recurring + committee, analytics + charts.

**Phase 4 — Quality (Tier 3):** import/export (JSON/CSV), advanced filters, polish and animations, PWA install + offline read-only, integrity check job, accessibility audit, performance pass.

---

## 21. Edge-case catalogue and required tests

Each item below MUST have an automated test (unit, integration, or E2E).

**Money and parsing**
1. Input "2,500", "2500.50", " 2500 ", "2500.555" (reject), "-5" (reject), "0" (reject), "1e3" (reject), "٢٥٠٠" (normalise), "1200+350" (calculator → 1550.00).
2. 0.1 + 0.2 style sums produce exact paisa results; 10,000 random sums equal BigInt sums.
3. Largest allowed amount works; one paisa above is rejected.

**Balances and invariants**
4. Expense equal to full envelope balance succeeds (balance 0); one paisa more fails.
5. Allocation > Unallocated fails; = Unallocated succeeds (Unallocated 0).
6. Income with splits summing to full amount → Unallocated unchanged; splits sum 0 → all to Unallocated; splits > amount fails.
7. Backdated expense that would have been impossible at that earlier date (envelope funded later) is rejected with the first violating date.
8. Deleting an income used to fund later spending is rejected; deleting it after deleting the spending succeeds.
9. Editing an expense amount up/down updates balances and Total; up beyond balance fails.
10. Edit an expense's envelope from A to B validates both A and B timelines.
11. Two concurrent expenses totalling more than the balance: exactly one succeeds.
12. Double-submit with same idempotency key creates one transaction.
13. Edit conflict from stale `version` → 409, no overwrite.
14. Soft-deleted transactions never affect balances; restore re-validates.

**Envelopes and ownership**
15. Duplicate envelope name (different case, trailing space) rejected among active; allowed if the other is archived.
16. Owner type can't change after first transaction.
17. Archive with balance > 0 triggers the correct flow; archive with active loan blocked; archived envelope absent from pickers; unarchive with name clash demands rename.
18. Hard delete only when completely unreferenced.
19. External envelope: deposit raises Total and "Held for Others", not income analytics; withdrawal lowers Total, not spending analytics; YourMoney excludes it.
20. External envelope cannot lend or borrow; cannot transfer to/from Mine envelopes.

**Loans**
21. Loan > lender balance fails; = lender balance succeeds. Lender = borrower fails. Archived party fails.
22. Loan leaves Total unchanged; both balances update; loan chips show correctly.
23. Partial repayment, full repayment (status Paid), overpayment rejected, repayment > borrower balance rejected, repayment dated before loan rejected.
24. Borrower spends borrowed money → Own funds negative displays the neutral "owes" note; repayment limited by balance.
25. Delete repayment reopens loan; delete loan with repayments blocked; edit loan amount below repaid blocked.
26. Opposite-direction loans between the same pair stay independent.
27. Loan/repayment never appear in spending or income analytics.
28. Insufficient-funds expense → Borrow flow → returns and completes the original expense with preserved data.

**Recurring**
29. Monthly 31st clamps correctly across a full year including leap Feb; yearly Feb 29.
30. Generation is idempotent when the job runs twice or runs concurrently.
31. App not opened for 3 months → 3 occurrences generated with correct dates; failures become needs_attention.
32. Insufficient funds → needs_attention, no negative balance; resolve by funding then retry.
33. Pause/resume with and without backfill; skip doesn't count toward committee total; committee completes after N paid.
34. Edit rule affects future only; delete rule keeps history; archived envelope pauses rule.
35. Recurring income with split template where one envelope was archived.

**Reconciliation**
36. Match → "Reconciled"; add a transaction afterwards → "Changes since last check", not mismatch.
37. Mismatch shows signed difference with correct wording; fixing records flips status.
38. Saving a check doesn't alter any balance; adjustment requires note + confirmation, lands in chosen target, excluded from analytics, rejects negative-result targets.
39. Editing history after a check shows "changed since" badge; stored snapshot unchanged.
40. Actual < 0 rejected; huge-mismatch warning appears.

**Analytics**
41. Only `income`/`expense` counted; adjustments, loans, transfers, allocations, deposits excluded.
42. Percentages always sum to exactly 100; months with zero included; ranges cross year boundary; month boundaries respect Asia/Karachi (transaction at 23:59 PKT on the 31st counts in that month).
43. Archived/renamed category appears correctly; Others' envelope expenses excluded unless toggled.

**Auth/security**
44. Every endpoint: user B can't read/write user A's rows (IDOR matrix). Mass-assignment (`user_id` in body) ignored.
45. Login throttling; generic error messages; registration disabled flag returns 404; seed idempotent and env-driven; production seed guard.
46. XSS payloads in notes/names render inertly; CSV formula injection neutralised.
47. Logout clears caches/SW data; session revoke works.

**Import/export**
48. Export → wipe → import reproduces identical balances and history; import with a corrupted ledger (negative running balance, orphaned loan) rejected atomically with readable errors; wrong schema version rejected; same file twice is idempotent.

**UX/PWA**
49. Offline: read-only banner, writes disabled, no data leak after logout.
50. Dark/light, 320px width, 200% text zoom, screen-reader labels on money and status.
51. Quick expense completes in ≤ 4 taps with last-used defaults; Undo toast restores correctly.

**Time**
52. Transaction "today" near midnight PKT vs UTC boundary lands on the correct date; future date rejected; server date authoritative.

---

## 22. Reference scenario (must pass as an E2E test, numbers in PKR)

1. Opening balance 200,000. Create Home 50,000, Personal 80,000, Savings 30,000, Ahmed (Others') 20,000 (allocated from existing). → Unallocated 20,000; Total 200,000; Your Money 180,000; Held for Others 20,000.
2. Expense Home 2,500 Groceries → Home 47,500; Total 197,500.
3. Income Salary 150,000 split 50,000 Savings, 50,000 Home, 50,000 Personal → Total 347,500; Unallocated 20,000 (unchanged: splits equal income).
4. Home spends down to 0 (after step 3 Home would be 97,500, so spend 97,500 across several expenses); electricity 5,000 attempted → rejected "Home has only 0 PKR available".
5. Loan Personal → Home 5,000 → Personal −5,000, Home 5,000, Total unchanged; electricity 5,000 expense then succeeds → Home 0, Borrowed 5,000, Own funds −5,000 note shown.
6. Add 20,000 to Home (allocation from Unallocated) → Home 20,000; repay 5,000 Home → Personal → loan Paid; Personal restored.
7. Reconcile: expected X, enter actual = X → ✓ Reconciled. Enter X − 1,000 → Mismatch −1,000 with causes shown; no balances change.
8. Ahmed takes money back: `external_withdrawal` 20,000 → Ahmed 0, Total −20,000, not in spending analytics; archive Ahmed → disappears from dashboard, appears in Archived and history.
9. Analytics for the month: spending = only the expenses (not loan/repayment/withdrawal); income = 150,000 only.
10. Export JSON → import into a clean DB → all balances, loans, history identical.

---

## 23. Open decisions the owner may want to change later

| # | Decision made in this URD | Alternative |
|---|---|---|
| D1 | Money stored in paisa, shown mostly as whole rupees | Whole rupees only |
| D2 | Added `deallocation` and `transfer` types | Allow only via fake expense/loan |
| D3 | Loans only between "Mine" envelopes; no netting | Allow lending others' money |
| D4 | No future-dated manual transactions | Allow scheduled one-offs |
| D5 | Insufficient-funds recurring → "needs attention" | Allow temporary negative |
| D6 | Soft delete with 30-day restore | Hard delete |
| D7 | Registration off in production | Open sign-up |
| D8 | Committee payout recorded manually as income | Automatic payout modelling |
| D9 | Western digit grouping (200,000) | Lakh/crore grouping |
| D10 | Transaction type not changeable on edit | Allow type conversion |
| D11 | Offline = read-only | Offline write queue + sync |
| D12 | Own funds shown as Balance − Borrowed (can be negative) | Hide negative / cap at 0 |

---

## 24. Definition of done (V1)

- All Tier 1 and Tier 2 requirements implemented; Tier 3 items implemented or explicitly deferred in `DECISIONS.md`.
- All tests in Section 21 pass in CI; property tests hold INV-1…INV-6 over ≥ 1,000 random operation sequences.
- Reference scenario (Section 22) passes end to end.
- Lighthouse PWA/Performance/Accessibility ≥ 90 on mobile for the dashboard.
- The app lets the user answer the ten V1 success questions (original spec §60) from the dashboard and one tap from it.
- Deployed on Vercel with managed PostgreSQL, environment variables configured, seeded account created via env vars, backups enabled.
