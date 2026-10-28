# Envelope Finance — Technical Design (split edition)

Replaces the single `TECHNICAL_DESIGN.md` v1.0. Each document below is a **complete, self-contained design for one feature area**: data model, rules, algorithms, actions/APIs, UI, edge cases, tests and acceptance. Source of truth for *what* is built is `envelope-finance-urd.md`; these documents define *how*.

Start with **GAP_ANALYSIS.md** (what was wrong or missing in v1.0 and the decisions taken), then read **TD-00** and **TD-01** before anything else.

## Documents

| # | Document | Owns | URD sections |
|---|---|---|---|
| — | [GAP_ANALYSIS.md](GAP_ANALYSIS.md) | Defects, missing design, URD ambiguities and their resolutions | all |
| 00 | [Foundation & Architecture](00-foundation-architecture.md) | Stack/driver constraints, layering, wire formats, error model, `defineAction` write pipeline, cron, logging, env, migrations, TD decisions | §0, §2, §19 |
| 01 | [Ledger Core](01-ledger-core.md) | Money & date libs, core schema, triggers, `ledger_effects`, timeline verifier, locking/idempotency/versioning, soft delete, integrity check | §3, §4, §5 core, §19 |
| 02 | [Auth, Accounts & Security](02-auth-accounts-security.md) | Auth.js JWT+sessions, passwords, throttling, headers/CSP, RLS, IDOR harness | §6 |
| 03 | [Onboarding & Settings](03-onboarding-settings.md) | Wizard, opening balance, preferences, recently deleted | §7, §16 |
| 04 | [Envelopes, Allocation & Held Money](04-envelopes-allocations-held-money.md) | Envelope CRUD/archive, allocate/deallocate/transfer, external deposit/withdrawal | §8 |
| 05 | [Transactions, Categories & Search](05-transactions-categories-search.md) | Expense/income/splits, edit matrix, delete/undo/restore, lists, categories, global search | §11.3–11.7, §14, §15 |
| 06 | [Internal Loans](06-internal-loans.md) | Loan model & view, create/repay/repay-all, edit/delete, borrow-on-shortfall | §9 |
| 07 | [Recurring & Committees](07-recurring-committee.md) | Rules, pure recurrence engine, generation, needs-attention, kameti | §10 |
| 08 | [Reconciliation](08-reconciliation.md) | Checks, status machine, hash/revision, adjustment, hints | §12 |
| 09 | [Analytics](09-analytics.md) | Definitions, ranges, SQL, percentages, caching, charts | §13 |
| 10 | [App Shell, Dashboard & Quick-Add](10-app-shell-dashboard-quick-add.md) | Routes, nav, design system, dashboard, quick expense, optimistic UI, a11y | §11.1–11.4 |
| 11 | [Import, Export & Backup](11-import-export-backup.md) | JSON/CSV export, Replace-import pipeline | §17 |
| 12 | [PWA, Offline & Performance](12-pwa-offline-performance.md) | Manifest, service worker, read-only offline, update flow, perf budgets | §18 |
| 13 | [Testing, Quality & Deployment](13-testing-quality-deployment.md) | Test strategy, URD §21 traceability, reference scenario, CI/CD, ops, DoD | §20–22, §24 |

## Dependency graph (build order)

```
00 Foundation ─► 01 Ledger Core ─► 02 Auth ─► 03 Onboarding/Settings
                      │
                      ├─► 04 Envelopes ─► 05 Transactions/Categories/Search ─┬─► 06 Loans
                      │                                                      ├─► 07 Recurring
                      │                                                      ├─► 08 Reconciliation
                      │                                                      └─► 09 Analytics
                      └──────────────────────────────► 10 App Shell (composes all) ─► 12 PWA
                                                       11 Import/Export (needs 01,05,06,07,08)
                                                       13 Testing/Deploy (all)
```

## Phase map (URD §20)
- **Phase 1:** 00, 01, 02, 03 (§1–2).
- **Phase 2:** 04, 05, 08, 10, 03 (§3–4).
- **Phase 3:** 04 (held money), 06, 07, 09.
- **Phase 4:** 11, 12, 13 (+ integrity job, advanced filters, a11y/perf).
Gates per phase: TD-13 §9.

## Conventions used across the documents
- **Requirement ids** (`FR-LOAN-07`, `INV-2`, …) refer to the URD. `FR-RCN-*` = URD reconciliation ids that collide with `FR-REC-*` (recurring).
- **`TD-Dn`** = technical decisions (listed in TD-00 §11). **`G-nn` / `U-nn`** = gap/URD-issue ids (GAP_ANALYSIS).
- Money is integer paisa (`bigint`), strings on the wire. Dates are `LocalDate` strings. Never floating point.
- SQL uses PostgreSQL ≥ 15. Code is TypeScript (strict). `domain/**` is pure.
- Each document ends with its **Tests owned** and **Acceptance** sections; together they cover URD §21 (traceability in TD-13 §3).

## Decisions (final)
The owner delegated all open questions, so every assumption in this set is **final** and no input is pending:
1. The *possible-causes copy* (TD-08 §7) and the *ten V1 success questions* (TD-10 §4.6) are adopted as written.
2. Technical decisions TD-D1…TD-D10 (TD-00 §11) are adopted: derived loan state, single idempotency store, opening balance may be 0, recurring income posts before same-day expenses.
3. Hosting: Vercel + Neon with a pooled/WebSocket driver (the HTTP driver is incompatible with the locking design). Lakh grouping stays an optional setting; default is western.
Implementers record any further choice in `DECISIONS.md` (URD §0.7).
