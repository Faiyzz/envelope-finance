# Gap Analysis — `TECHNICAL_DESIGN.md` v1.0 vs `envelope-finance-urd.md` v1.0

**Method:** every URD section and requirement id was traced into TD v1.0; code/SQL in TD v1.0 was read for correctness. Findings are grouped as **A** (defects that would make the implementation fail or violate an invariant), **B** (missing design — whole features or mechanisms the URD requires), **C** (ambiguities/contradictions inside the URD itself, resolved here). Each row says where it is fixed in the new set.

Severity: 🔴 breaks correctness/invariants or cannot run · 🟠 required feature/mechanism missing · 🟡 incomplete/unclear.

---

## A. Defects in TD v1.0

| ID | Sev | Where (TD v1.0) | Problem | Resolution |
|---|---|---|---|---|
| G-01 | 🔴 | §4.2 DDL | Invalid SQL: `CHECK (owner_name IS NOT NULL WHEN …)`, `CHECK (a → b)`, inline `UNIQUE(user_id, LOWER(name)) WHERE …` (expressions/predicates need `CREATE UNIQUE INDEX`). Migrations would not apply. | TD-01 §4 — valid DDL, partial/expression unique indexes |
| G-02 | 🔴 | §4.3 `ledger_effects` | `adjustment` has **no TOTAL posting** (`ELSE 0`) → an adjustment changes envelope/Unallocated but not Total, breaking INV-1 and reconciliation. | TD-01 §5 |
| G-03 | 🔴 | §4.3/4.4 | `account` column mixes the literal `'TOTAL'`/`'UNALLOCATED'` with UUID-as-text; queries do `account::UUID` over all rows → runtime cast error. | TD-01 §5 (`account` + typed `envelope_id UUID`) |
| G-04 | 🔴 | §4.3 vs §6.2 | Orientation of `envelope_id`/`counterpart_envelope_id` never defined; view posts `loan_repayment` as **+envelope_id** while the action text treats the borrower as payer. Sign errors in loans. | TD-00 §11 TD-D1, TD-01 §5, TD-06 §1 |
| G-05 | 🟠 | §4.3 | `transfer` branch `WHEN … counterpart IS NOT NULL` is dead code under a first branch already matching; fragile CASE structure; zero-delta rows emitted. | TD-01 §5 (VALUES-based, zero rows dropped) |
| G-06 | 🔴 | §5.4 | `validateTimeline` has typos (`occurred at`, selects non-existent `id`), mixes DB access into a "PURE" module, replays whole history, ignores loans, validates Unallocated in a separate query; "when" (before/after the change) unspecified. | TD-01 §6 (apply→verify→rollback; SQL verifier; pure `findFirstViolation`) |
| G-07 | 🔴 | §5.5 | `withUserLock`: callback never receives the transaction (queries run outside the lock/txn); `hashUserId` undefined; SERIALIZABLE example uses a non-existent API. | TD-01 §7 |
| G-08 | 🔴 | §5.6 | Idempotency: check-then-insert race; `JSON.stringify` on `bigint` throws; `JSON.parse` on JSONB (already parsed); key TEXT vs UUID; no uniqueness on `transactions.idempotency_key`. | TD-01 §7, TD-00 §4.1 (wire format), TD-D3 |
| G-09 | 🟠 | §5.1 | `parseMoney`: no Arabic/Urdu digit normalisation, no misplaced-comma rejection, recursion checks `=== null` on a throwing function; `formatMoney` prints `-5.-50` for negatives; `subMoney` throws on negative results although Own funds/adjustments are legitimately negative; `Intl en-PK` may group lakh-style. | TD-01 §2 |
| G-10 | 🔴 | §5.8 | Recurrence engine: local-timezone `Date` maths, `setMonth` overflow *before* clamping (Jan 31 → Mar 3), `toISOString()` date keys shift by timezone, impure `new Date()` in `shouldContinue`, counts occurrences from `startDate` ignoring skips, defaults generated slots to `needs_attention`. | TD-07 §3 (index-based, pure, `LocalDate`) |
| G-11 | 🔴 | §6.4, §11.3 | Vercel Cron issues **GET** (not POST) and schedules in **UTC** ("00:05 Asia/Karachi" is `5 19 * * *`); Hobby plan limits → single dispatcher needed. | TD-00 §7 |
| G-12 | 🔴 | §2.1 | "Neon" driver unspecified; the HTTP driver has no interactive transactions → advisory-lock + validate-then-commit impossible. | TD-00 §2 (pooled/WebSocket driver; `SET LOCAL` only) |
| G-13 | 🔴 | §2.1/§7.1 | "Auth.js database or JWT sessions" — Credentials provider requires JWT; "log out all devices" and the sessions list need server state; argon2 cannot run in Edge middleware. | TD-02 §1–3 |
| G-14 | 🔴 | §4.1/4.2 | Composite `(user_id, id)` FKs described but **not in the DDL**; no DB enforcement for: external_* ↔ other-owned, loan/transfer ↔ mine-only, category kind vs type, owner_type immutability, one opening balance, Σsplits ≤ income. | TD-01 §4, §4.1 triggers |
| G-15 | 🟠 | §4.2 | Missing tables/columns: `sessions`, `login_attempts`, `password_reset_tokens`, `import_runs`, user preferences, `goal_amount`, `ledger_revision`, reconciliation snapshot hash definition, `integrity_runs`, `pause_reason`, occurrence `slot_index`. | TD-01/02/07/08/11 |
| G-16 | 🟠 | §4.2 | `loans.remaining_amount_paisa` cached with no verification path; `loan_repayments` duplicates `loan_repayment` transactions (two sources of truth). | TD-06 §1 (derived `loan_state`; TD-D2) |
| G-17 | 🟡 | §8.5 | State management contradictory (React Query/SWR vs Server Components + Server Actions). | TD-00 §2 |
| G-18 | 🟡 | §4.2 | `transactions` CHECK covers only 5 of 11 types, rejects `opening_balance = 0` (URD §7 allows 0), and mixes `adjustment` rules. | TD-01 §4 (full `tx_shape`/`tx_amount`) |
| G-19 | 🟡 | §6 | API layer is pseudo-code: no error/result contract, no pagination, no read endpoints, no Zod schemas, no `defineAction` pipeline, no wire format for money. | TD-00 §5–6, per-feature docs |
| G-20 | 🟡 | §5.3 | `income` described only for TOTAL/UNALLOCATED; split postings and `external_*` ownership not specified in SQL. | TD-01 §5 |
| G-21 | 🟡 | §6.2 | `archiveEnvelope` options named `deallocate/withdraw/move_to_unallocated` do not map to the URD sheet (Mine vs Others', "give to me" warning); unarchive/hard-delete reference rules (incl. soft-deleted rows, recurring templates) missing. | TD-04 §3.3–3.4 |
| G-22 | 🟡 | §10 | Testing strategy summarises URD §21 but gives no traceability, no model for property tests (example is trivial), no concurrency/IDOR design. | TD-13 §2–3, TD-02 §10 |

## B. Missing design (URD features with no TD v1.0 design)

| ID | Sev | URD | Missing | Resolution |
|---|---|---|---|---|
| G-30 | 🟠 | §7 | Onboarding wizard, single-commit semantics, 0 opening balance, skip, opening-balance edit/delete rules | TD-03 §1–2 |
| G-31 | 🟠 | §16 | Settings (account/finance/appearance/data/security/about), timezone-change semantics, number grouping | TD-03 §3 |
| G-32 | 🟠 | §14 | Categories: seed list, CRUD, merge, picker ordering | TD-05 §9 |
| G-33 | 🟠 | §11.7 | Global search (ILIKE escaping, pg_trgm, groups, "Ahmed" completeness, amount match) | TD-05 §8 |
| G-34 | 🟠 | §13 | **Analytics** — no queries, ranges, previous period, largest-remainder, caching, charts | TD-09 |
| G-35 | 🟠 | §12 | Reconciliation status states, hash/"changed since", adjustment flow, hints, history | TD-08 |
| G-36 | 🟠 | §10.2 | Committee (kameti) detail, projected end date with skips | TD-07 §8 |
| G-37 | 🟠 | §10 | Needs-attention flow, lazy generation, catch-up cap, cross-rule ordering, hooks on archive | TD-07 §5–7 |
| G-38 | 🟠 | §9.1/FR-LOAN-06 | Borrow-on-shortfall resume protocol (pending-intent) | TD-06 §4 |
| G-39 | 🟠 | §17 | JSON/CSV export, Replace-import pipeline, validation, id remap, atomicity, formula injection | TD-11 |
| G-40 | 🟠 | §18 | PWA: manifest, SW strategies, offline snapshots, update flow, install UX, logout cache purge | TD-12 |
| G-41 | 🟠 | §4.5 | Recently-deleted screen, 30-day purge job, restore validation, undo behaviour | TD-03 §4, TD-05 §4/7 |
| G-42 | 🟠 | §19 / FR-INT-03 | Integrity check specification and nightly job | TD-01 §10, TD-00 §7 |
| G-43 | 🟠 | §11.2/11.3 | Dashboard data contract, attention rules, quick-add flow incl. optimistic rollback and last-used defaults, hide-balances SSR | TD-10 |
| G-44 | 🟠 | §6 | Rate limiting store for serverless, lockout policy, password policy details, CSP/headers concretely, RLS SQL, IDOR harness | TD-02 |
| G-45 | 🟡 | §11.5 | Transaction list filters, keyset cursors, totals bar definition | TD-05 §6 |
| G-46 | 🟡 | §15 | Duplicate guard (FR-TXN-09), edit matrix per type, loan-linked rows redirect | TD-05 §1–3 |
| G-47 | 🟡 | §19 | Logging redaction, health endpoint, env validation, migration policy, backup/runbook | TD-00 §8–10, TD-13 §6–8 |
| G-48 | 🟡 | §24 | Release gates per phase, DoD checklist | TD-13 §9–10 |

## C. URD ambiguities / contradictions (decisions recorded)

| ID | Issue in URD | Decision in this set |
|---|---|---|
| U-01 | `FR-REC-*` ids are used for both recurring (§10) and reconciliation (§12: FR-REC-08, FR-REC-10) | Reconciliation ids written as **FR-RCN-*** in the TDs (TD-08) |
| U-02 | §12.1 cites "spec §27" (possible causes) and §24 cites "original spec §60" (ten success questions) — neither is in the provided docs | Proposed content in TD-08 §7 and TD-10 §4.6, marked as **assumptions for the owner to confirm** |
| U-03 | §4.1 says amount > 0 for every type except `adjustment`, but §7 allows an opening balance of 0 | `opening_balance` may be 0 (TD-D4) |
| U-04 | Which fields are editable per type is unspecified (§11.6 only mentions expense) | Edit matrix, TD-05 §3 |
| U-05 | Orientation of from/to in movement types undefined | TD-D1 |
| U-06 | `Total = Σ … occurred timestamp ≤ now` vs "no future-dated transactions" | Both consistent: no future rows exist; generators only create due rows. View needs no `≤ now` filter |
| U-07 | Reconciliation chip: what if ledger changed *and* the last check was a mismatch and still not equal? | 5th state `changes_since_still_off` (TD-08 §5) |
| U-08 | Committee/`max_occurrences` accounting with `needs_attention` slots | Skipped excluded; generated + needs_attention consume budget (TD-07 §2) |
| U-09 | CSV formula-injection rule (prefix cells starting with `-`) would corrupt negative numeric amounts | Neutralise **text** cells only; numerics validated (TD-11 §3) |
| U-10 | Hard-delete of envelope/category "with no references" — do soft-deleted transactions count? | Yes until purged (TD-D7) |
| U-11 | Undo toast (6 s) vs timeline validation after other writes | Undo may fail; show plain-language reason (TD-05 §4) |
| U-12 | Same-day ordering with default time 12:00; recurring income vs expense on same day | Recurring income at 00:01, expense at 12:00 (TD-D6); user can set time explicitly |
| U-13 | Time-zone change semantics | Stored `occurred_on` never shifted; warning shown (TD-03 §3.1) |
| U-14 | Import: "IDs preserved" vs "IDs remapped to avoid collisions" | Preserve; deterministic UUIDv5 remap only on collision (TD-D9) |
| U-15 | `loan_repayments` table and `loans.remaining/status` stored vs "derived/cached, verified" | Derived only (TD-D2) |
| U-16 | `transactions.idempotency_key` column vs 24 h key store | Single store (TD-D3) |
| U-17 | INV-2 says "active envelope balance ≥ 0" | Verifier covers **all** envelopes incl. archived (archived must be 0) |
| U-18 | Registration: URD mentions email verification "when enabled" but no verification flow exists | No verification in V1; registration closed in production (TD-02 §3.1) |
| U-19 | "Skip" on category in quick flow vs expense requiring `category_id` | Server defaults to system "Uncategorized" (TD-05 §1) |
| U-20 | Others' envelope adjustments, income splits into Others' envelopes | Splits: `mine` only; adjustments to Others' only on explicit pick with warning (TD-05 §2, TD-08 §6) |

## D. Coverage result
All URD requirement groups (§3–§22 and the 52 tests) now map to at least one TD document; see the traceability table in **TD-13 §3** and the requirement index in **README.md**. All previously open items (U-02 missing spec sections, TD-D1…D10, lakh grouping) were delegated by the owner and are resolved as written in this set; nothing is pending.
