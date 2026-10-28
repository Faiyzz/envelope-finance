# TD-13 — Testing, Quality Gates, Deployment & Operations

**URD coverage:** §20 (phases/acceptance), §21 (all 52 tests), §22 (reference scenario), §24 (definition of done), §19 (migrations, environments, backups, observability), FR-INT-02.
**Depends on:** everything. This is the verification and release plan.

---

## 1. Test pyramid & tooling

| Layer | Tool | Scope | Runs |
|---|---|---|---|
| Unit | Vitest | `domain/**` (money, dates, validation, loans, recurrence, reconciliation, analytics, backup validators), messages | every commit |
| Differential | Vitest + Testcontainers | SQL `ledger_effects` vs TS mirror on random ledgers | every commit |
| Property | fast-check (+ model) | invariants INV-1…6, 10 over random operation sequences (≥ 1,000 runs; 10,000 nightly) | every commit / nightly |
| Integration | Vitest + Testcontainers Postgres 16 (real migrations, RLS on, role `app_rw`) | actions, repos, triggers, verifier, concurrency, idempotency, jobs | every commit |
| IDOR/Security | generated matrix (TD-02 §10) | every action & route | every commit |
| E2E | Playwright (Chromium, WebKit, mobile viewports) | reference scenario, critical flows, offline, a11y (axe) | PR + nightly |
| Perf | Lighthouse CI, EXPLAIN assertions, k6-lite concurrency | budgets | PR (soft) / release (hard) |

Test DB: one container per worker, template database with migrations applied once, per-test schema reset via `TRUNCATE … CASCADE` or per-test user (tests always create their own users → isolation also exercises scoping). `Clock` and `Random` are injected so time-dependent tests (recurring, midnight PKT, 24 h idempotency expiry, 30 d purge) are deterministic.

## 2. Property-based testing design (FR-INT-02)

**Reference model** (`tests/property/model.ts`): a tiny in-memory ledger that implements *only* the effect table (TD-01 §5) and the rule "after every operation, replaying all postings in canonical order never makes an envelope or Unallocated negative". It is deliberately written independently of the SQL.

**Operation generator** (weighted): `income(withSplits)`, `expense`, `allocate`, `deallocate`, `transfer`, `externalDeposit`, `externalWithdrawal`, `createLoan`, `repay`, `repayAll`, `editAmount`, `editDate(backdate)`, `editEnvelope`, `delete`, `restore`, `archive`, `unarchive`, `skewTime` (same-day ties), each with random envelopes/amounts/dates drawn from a small universe so collisions are frequent.

**Per step**, execute against **(a) the model and (b) the real action layer on Postgres**, then assert:
1. Decision equivalence: accept/reject agree (verifier neither too strict nor too lax).
2. On reject, the DB state is byte-identical to before (snapshot hash).
3. INV-1 (`total = Σenv + unallocated`), INV-2/3/10 (running balances ≥ 0 via independent replay), INV-4 (no stored balance), INV-5 (Total unchanged by allocation/dealloc/transfer/loan/repay), INV-6 (analytics only count income/expense), loan sanity (`0 ≤ remaining ≤ original`), idempotent retry returns the same result without new rows.
4. Shrinking prints the minimal operation sequence + seed.

Runs: 1,000 sequences × ≤ 40 ops in CI (model-only fast path for the pure layer; DB-backed path 200 sequences), 10,000 nightly. DoD requires ≥ 1,000 green.

## 3. URD §21 → test traceability

| URD # | Topic | Layer | Owner doc | Location |
|---|---|---|---|---|
| 1–3 | Money parsing/sums/limits | unit | TD-01 §2 | `tests/unit/money.*` |
| 4–6 | Boundary balances, allocation, income splits | integration | TD-01/04/05 | `tests/integration/balances.*` |
| 7–10 | Backdating, delete-funding, edits, envelope change | integration + property | TD-01/05 | `…/timeline.*` |
| 11 | Concurrent overspend (exactly one wins) | integration (20 parallel) | TD-01 §7 | `…/concurrency.*` |
| 12 | Idempotent double submit | integration | TD-01 §7 | `…/idempotency.*` |
| 13 | Stale version → 409/`CONFLICT` | integration | TD-01 §7 | `…/versioning.*` |
| 14 | Soft delete / restore re-validation | integration | TD-01/05 | `…/softdelete.*` |
| 15–18 | Envelope names, owner lock, archive/unarchive, hard delete | integration | TD-04 | `…/envelopes.*` |
| 19–20 | Held-money effects; others' envelopes cannot lend/borrow/transfer | integration + trigger tests | TD-04/06 | `…/held-money.*` |
| 21–28 | Loans | integration + E2E (28) | TD-06 | `…/loans.*`, `e2e/borrow-flow` |
| 29–35 | Recurring/committee | unit (engine) + integration | TD-07 | `…/recurring.*` |
| 36–40 | Reconciliation | unit (status table) + integration | TD-08 | `…/reconciliation.*` |
| 41–43 | Analytics | integration | TD-09 | `…/analytics.*` |
| 44–47 | Auth/security/XSS/CSV/logout | IDOR matrix + integration + E2E | TD-02/11 | `tests/idor/*`, `…/auth.*` |
| 48 | Import/export round trip | integration + property | TD-11 | `…/backup.*` |
| 49 | Offline/no leak after logout | E2E (Playwright offline) | TD-12 | `e2e/offline.*` |
| 50 | Themes, 320 px, 200 % zoom, SR labels | E2E + axe | TD-10/12 | `e2e/a11y.*` |
| 51 | Quick expense ≤ 4 taps; Undo | E2E | TD-10 | `e2e/quick-expense.*` |
| 52 | Midnight PKT/UTC date boundary, future rejected | unit + integration (pinned `Clock`) | TD-01 §3 | `…/time.*` |

CI includes a **traceability check**: each URD test number appears in at least one test title (`[URD-12]` tag convention). Missing tag ⇒ CI failure.

## 4. Reference scenario (URD §22) as the Phase-2/3 gate

`e2e/reference-scenario.spec.ts` drives the real UI with stable `data-testid`s (`total-balance`, `tile-your-money`, `tile-held`, `tile-unallocated`, `envelope-card-{slug}`, `quick-add-fab`, `amount-input`, …) and asserts the exact numbers from URD §22 at each step (PKR; the amounts below are in rupees):

| Step | Action | Assertions |
|---|---|---|
| 1 | Onboard 200,000; Home 50,000, Personal 80,000, Savings 30,000, Ahmed(other) 20,000 | Unallocated 20,000; Total 200,000; Your Money 180,000; Held 20,000 |
| 2 | Expense Home 2,500 Groceries | Home 47,500; Total 197,500 |
| 3 | Income Salary 150,000: 50,000 each to Savings, Home, Personal | Total 347,500; Unallocated 20,000 |
| 4 | Spend Home down to 0 (97,500 total across expenses); try 5,000 Electricity | error "Home has only 0 PKR available."; offers Add money / Borrow |
| 5 | Loan Personal→Home 5,000; expense 5,000 Electricity | Personal −5,000 effect, Home 5,000→0; Total unchanged; Borrowed 5,000; Own funds −5,000 note |
| 6 | Allocate 20,000 to Home; repay 5,000 Home→Personal | Home 20,000 − 5,000 = 15,000; loan Paid; Personal restored |
| 7 | Reconcile actual = X → ✓; actual = X−1,000 → Mismatch −1,000 + causes | balances untouched |
| 8 | Ahmed external_withdrawal 20,000; archive Ahmed | Ahmed 0, Total −20,000; hidden from dashboard; present under Archived & history |
| 9 | Analytics (month) | spending = only recorded expenses; income = 150,000; no loan/repay/withdrawal |
| 10 | Export JSON → import into clean DB (new user) | all balances, loans, history identical |

(Step 5/6 numbers in the URD for Personal's balance depend on the earlier sequence; the test computes expected values with the independent model rather than hard-coding anything beyond the stated ones.)

## 5. CI pipeline (GitHub Actions; any CI works)

1. `install` (pnpm, cache) → `lint` (ESLint incl. layering + money rules) → `typecheck` (`tsc --noEmit`, strict) → `format:check`.
2. `unit + differential + property` (parallel, coverage gates: `domain/**` ≥ 95 % lines & branches; overall ≥ 85 %).
3. `db`: Postgres service/Testcontainers → apply migrations from scratch → `drizzle-kit check` → schema-drift test → `integration` + `idor` suites.
4. `build` (`next build`), bundle-size check, `gitleaks` secret scan, `pnpm audit --prod` (high severity gate), license check.
5. `e2e` (Playwright against `next start` + seeded DB), `lighthouse-ci` (mobile preset) on PR with budgets.
6. `migrate-dry-run` against a snapshot of production schema (nightly) to catch drift.
7. On `main`: deploy preview → manual approval → production (§6).
Git hooks (Husky): pre-commit `lint-staged` (eslint --fix, prettier, typecheck changed); pre-push `unit` suite.

## 6. Environments & deployment (§19, TD-00 §9–10)

| Env | DB | Notes |
|---|---|---|
| local | docker Postgres 16 | `docker compose up db`; `pnpm db:migrate && pnpm db:seed && pnpm dev` |
| preview (per PR) | Neon branch (copy-on-write) | seeded test user via env; `ALLOW_REGISTRATION=true` allowed here |
| production | Neon (PITR on) | `ALLOW_REGISTRATION=false`, `ALLOW_SEED=false` except the first-deploy seed run |

**Release procedure:**
1. CI green on `main`.
2. Run migrations with `DATABASE_URL_UNPOOLED` as a pre-deploy step (expand/contract compatible with the previous build).
3. Deploy to Vercel (Node runtime for all DB/auth routes; `export const runtime = 'nodejs'`; function region matches DB).
4. First deploy only: one-off seed (`ALLOW_SEED=true pnpm db:seed` from CI/CLI), then remove `ALLOW_SEED`.
5. Post-deploy smoke: `/api/health` (db ok), login, dashboard renders, `/api/cron/daily` dry run with `CRON_SECRET` (idempotent no-op).
6. Verify Vercel Cron registered (`vercel.json`, `5 19 * * *` UTC = 00:05 PKT).
7. Lighthouse mobile ≥ 90 on production URL (DoD).
Rollback: redeploy previous build (migrations are backward compatible for one release); data restore via PITR (§8).

## 7. Observability & ops (TD-00 §8)
- Structured logs with redaction; `ref` ids for user-reported errors; Sentry optional with scrubbing.
- `integrity.check` nightly result visible to the owner (dashboard attention strip on failure).
- Alerts (if hosting provides): cron failure, health failing, 5xx rate. For a personal app, a free uptime pinger on `/api/health` suffices.

## 8. Backups & disaster recovery (infra level)
- Enable Neon/Supabase **point-in-time recovery** (≥ 7 days; ideally 30). Document and rehearse: restore to a new branch, point `DATABASE_URL` at it, run `pnpm integrity:run`.
- User-level backups: JSON export (TD-11). Recommend a monthly export reminder (dashboard nudge, optional).
- **Runbook (`docs/RUNBOOK.md`, created in Phase 4):** reset a password via CLI (TD-02 §3.5), unlock account, revoke all sessions, run a job manually (`pnpm job:run recurring.generate`), restore from PITR, rotate `AUTH_SECRET` (invalidates all sessions — intended), rotate `CRON_SECRET`, run integrity check, import a backup, migrate a failed deploy.

## 9. Phases → documents → gates (URD §20)

| Phase | Build (TD docs) | Gate (must pass before next phase) |
|---|---|---|
| **1 Foundation** | TD-00, TD-01 (money, dates, schema, ledger view, verifier, locks, idempotency), TD-02 (auth, seed, IDOR harness, RLS), TD-03 §1–2 (onboarding, opening balance) | Seeded user logs in, completes onboarding, sees correct Total/Unallocated; money/ledger/property tests green; IDOR matrix green; migrations apply from scratch |
| **2 Core flows (Tier 1)** | TD-04 (envelopes, allocate/deallocate/transfer), TD-05 (expense/income/splits, edit/delete/restore, list, categories, search), TD-08 (reconciliation + adjustment), TD-10 (dashboard, quick-add, shell), TD-03 §3–4 (settings, recently deleted) | Reference scenario steps 1–4, 7 pass E2E; URD tests 1–20, 36–40, 44–47, 51–52 pass; quick expense ≤ 4 taps |
| **3 Differentiators (Tier 2)** | TD-04 held-money, TD-06 (loans), TD-07 (recurring + committee), TD-09 (analytics) | Reference scenario steps 5, 6, 8, 9 pass; tests 19–35, 41–43 pass; property suite extended with loans/held money |
| **4 Quality (Tier 3)** | TD-11 (import/export), TD-12 (PWA/offline/perf), integrity check job, advanced filters/bulk actions, a11y audit, TD-13 ops | Reference step 10 passes; tests 48–50; Lighthouse ≥ 90; E2E green on three viewports; runbook written; production deployed with backups on |

(The URD lists reconciliation and global search under Phase 2; this document keeps that assignment. Held-money *envelope creation for others* is available from onboarding in Phase 1 via allocation, but `external_deposit/withdrawal` flows ship in Phase 3.)

## 10. Definition of Done checklist (URD §24)

- [ ] All Tier 1 & 2 requirements implemented; Tier 3 implemented or deferred **in DECISIONS.md**
- [ ] All 52 URD tests pass in CI (traceability check green)
- [ ] Property suite ≥ 1,000 sequences green (INV-1…6, 10)
- [ ] Reference scenario (URD §22) passes E2E
- [ ] Lighthouse mobile Performance/Accessibility/PWA ≥ 90 on the dashboard
- [ ] Dashboard answers the ten success questions (TD-10 §4.6; owner confirmed the list)
- [ ] Deployed on Vercel + managed Postgres; env configured; seeded account created from env; PITR on
- [ ] `DECISIONS.md`, `.env.example`, `docs/RUNBOOK.md` present
- [ ] IDOR matrix complete (registry completeness test green); RLS test green
- [ ] No `parseFloat`/float-money lint violations; no `any` in `domain/**`

## 11. Initial `DECISIONS.md` seed (copy into repo)
D1–D12 from URD §23 plus TD-D1…TD-D10 (TD-00 §11), each as `ID · date · decision · reason · alternative · affects`.
