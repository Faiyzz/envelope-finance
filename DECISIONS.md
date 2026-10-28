# Decisions Log

This document records all decisions made during implementation, as required by URD §0.7 and TD-00 §11.

Format per entry: `ID · date · decision · reason · alternative · affects (requirement ids)`

---

## URD Decisions (D1-D12)

| ID | Date | Decision | Reason | Alternative | Affects |
|---|------|----------|--------|-------------|---------|
| D1 | 2026-10-06 | Money stored in paisa, shown mostly as whole rupees | Precision, no floating point errors | Whole rupees only | URD §4.1 |
| D2 | 2026-10-06 | Added `deallocation` and `transfer` types | Users must be able to move money out of envelopes without spending | Allow only via fake expense/loan | URD §4.2 |
| D3 | 2026-10-06 | Loans only between "Mine" envelopes; no netting | Protects other people's money | Allow lending others' money | URD §9.1 |
| D4 | 2026-10-06 | No future-dated manual transactions | Prevents confusion with recurring | Allow scheduled one-offs | URD §4.4 |
| D5 | 2026-10-06 | Insufficient-funds recurring → "needs attention" | Never allow negative balances | Allow temporary negative | URD §10.1 |
| D6 | 2026-10-06 | Soft delete with 30-day restore | Audit trail, recoverable | Hard delete | URD §4.5 |
| D7 | 2026-10-06 | Registration off in production | Personal app, controlled access | Open sign-up | URD §6.5 |
| D8 | 2026-10-06 | Committee payout recorded manually as income | Simpler model for V1 | Automatic payout modelling | URD §10.2 |
| D9 | 2026-10-06 | Western digit grouping (200,000) | Standard format | Lakh/crore grouping | URD §4.1 |
| D10 | 2026-10-06 | Transaction type not changeable on edit | Avoid ledger-effect confusion | Allow type conversion | URD §11.6 |
| D11 | 2026-10-06 | Offline = read-only | Simpler V1 implementation | Offline write queue + sync | URD §18 |
| D12 | 2026-10-06 | Own funds shown as Balance − Borrowed (can be negative) | Informational, not an error | Hide negative / cap at 0 | URD §4.3 |

---

## Technical Decisions (TD-D1 through TD-D10)

| ID | Date | Decision | Reason | Alternative | Affects |
|---|------|----------|--------|-------------|---------|
| TD-D1 | 2026-10-07 | Postings convention: `envelope_id` = source/"from", `counterpart_envelope_id` = destination/"to" for `transfer`, `loan`, `loan_repayment` | Consistent orientation removes sign bugs | Undefined orientation | TD-01 §5, TD-06 §1 |
| TD-D2 | 2026-10-07 | `loans.remaining/status` and `loan_repayments` are not stored; derived from `loan_repayment` transactions via `loan_state` view | INV-4, no desync (FR-LOAN-33) | Cached with verification | TD-06 §1 |
| TD-D3 | 2026-10-07 | Idempotency lives only in `idempotency_keys` (not a `transactions.idempotency_key` column) | One mechanism covers multi-row actions | Per-transaction column | TD-00 §4.1 |
| TD-D4 | 2026-10-07 | `opening_balance` may be 0 (only type besides `adjustment` with relaxed amount rule) | URD §7 allows 0 opening balance but §4.1 demands amount > 0 | Strict > 0 for all | TD-01 §4 |
| TD-D5 | 2026-10-07 | `ledger_revision` counter on `users` + per-check `ledger_hash` | Needed for reconciliation status & FR-RCN-10 | No version tracking | TD-08 |
| TD-D6 | 2026-10-07 | Generated recurring income is posted at 00:01, expenses at 12:00 on the due date | Same-day income funds same-day expense under canonical ordering | Same default time for all | TD-07 §3 |
| TD-D7 | 2026-10-07 | Soft-deleted transactions still block hard-deletion of their envelope/category until purged at 30d | Keeps FKs and restore valid | Allow hard delete with soft-deleted refs | TD-03 §4, TD-05 §7 |
| TD-D8 | 2026-10-07 | Cron = single daily dispatcher | Vercel Hobby limits; idempotent tasks | Multiple cron jobs | TD-00 §7 |
| TD-D9 | 2026-10-07 | Import preserves IDs unless they collide with another user's rows, then deterministic UUIDv5 remap | Satisfies "IDs preserved" and "remapped to avoid collisions" | Always remap or always preserve | TD-11 |
| TD-D10 | 2026-10-07 | Calculator input supports `+` only (also `-` between operands is not allowed) | Matches URD §11.3 and avoids sign confusion | Full calculator with all ops | TD-01 §2 |

---

## Implementation Decisions

| ID | Date | Decision | Reason | Alternative | Affects |
|---|------|----------|--------|-------------|---------|
| IMP-001 | 2026-10-07 | Use `pg` driver with pooled connection for standard Postgres, `@neondatabase/serverless` Pool (WebSocket) for Neon | HTTP drivers have no interactive transactions, making advisory locks impossible | HTTP drivers | TD-00 §2 |
| IMP-002 | 2026-10-07 | Use `defineAction` wrapper for all mutations | Ensures locking, idempotency, audit, revalidation are never forgotten | Manual implementation per action | TD-00 §6 |
| IMP-003 | 2026-10-07 | Domain layer is pure TypeScript with no framework dependencies | Enables exhaustive unit testing, property-based testing, reusability | Mixed with framework code | TD-00 §3 |
| IMP-004 | 2026-10-07 | Money on wire = decimal string of integer paisa | bigint cannot be JSON.stringify'd without throwing | Pass bigint directly | TD-00 §4.1 |
| IMP-005 | 2026-10-07 | Dates use branded LocalDate/LocalTime strings | Calendar maths never use JS Date | JS Date objects | TD-00 §4.2 |
| IMP-006 | 2026-10-07 | All user-visible text from `messages/en.ts` | i18n-ready, no literals in components | Hard-coded strings | TD-00 §4.4 |
| IMP-007 | 2026-10-07 | ESLint rules ban parseFloat, parseInt on money, floating arithmetic on Paisa | Prevents floating point money bugs | Manual code review only | TD-00 §3 |
| IMP-008 | 2026-10-07 | Layering rules enforced by ESLint with no-restricted-imports and eslint-plugin-boundaries | Prevents architectural violations | Manual enforcement | TD-00 §3 |

## TD-10 implementation notes (2026-10-07)
- Optimistic UI uses a small zustand store (`usePending`) layered over server data via the pure `applyPendingExpenses`, instead of `useOptimistic`, because the quick-add sheet (in the layout) and the dashboard (in the page) are separate trees. Behaviour matches TD-10 §5.3 (paint, reconcile on refresh, rollback on failure).
- Middleware is cookie-presence only (Edge-safe); `requireUser()` in `(app)/layout.tsx` is the real session check (TD-02 §1).
- Routes owned by other design docs render a "coming soon" placeholder (`(app)/[section]/[[...rest]]`).
- Not done here (other TDs): onboarding gate/wizard (TD-03), RecurringSync (TD-07), integrity attention item (TD-01 §10), income/allocate/transfer/loan/etc. forms (quick-add shows placeholders), PWA/offline (TD-12).
