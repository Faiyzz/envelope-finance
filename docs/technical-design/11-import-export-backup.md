# TD-11 — Import, Export & Backup

**URD coverage:** §17 (FR-BAK-01…06, FR-CSV-01), FR-SEC-03 (CSV formula injection), FR-AUTH-08 (export before delete), test 48, reference scenario step 10.
**Depends on:** TD-01 (schema, snapshot validator, verifier), TD-02 (auth), TD-05 (category seeding). **Used by:** TD-03 (Data page), TD-13 (restore runbook).

---

## 1. Scope
1. JSON backup export (full fidelity).
2. JSON import = **Replace everything** only (Merge is not built in V1 — FR-BAK-04).
3. CSV exports (transactions, expenses only, income only, reconciliation history), optional date range.
4. Infra-level backups (PITR) are documented in TD-13; this document covers *user-level* backup.

## 2. JSON format (`schema_version = 1`)

```jsonc
{
  "schema_version": 1,
  "exported_at": "2026-10-06T14:05:00Z",
  "app_version": "1.0.0",
  "timezone": "Asia/Karachi",
  "profile":   { "name": "…", "email": "…", "currency": "PKR", "timezone": "…", "theme": "…", "number_grouping": "…", "week_start": 1, "hide_balances_default": false },
  "envelopes": [ { "id", "name", "description", "icon", "color", "owner_type", "owner_name", "kind", "goal_amount_paisa", "status", "archived_at", "sort_order", "created_at", "updated_at" } ],
  "categories": [ { "id", "name", "kind", "group_name", "status", "is_system", "sort_order", … } ],
  "transactions": [ { "id", "type", "amount_paisa", "occurred_on", "occurred_at", "envelope_id", "counterpart_envelope_id", "category_id", "note", "loan_id", "recurring_id", "is_generated", "parent_transaction_id", "deleted_at", "version", "created_at", "updated_at" } ],
  "transaction_splits": [ { "id", "transaction_id", "envelope_id", "amount_paisa" } ],
  "loans": [ { "id", "lender_envelope_id", "borrower_envelope_id", "note", "deleted_at", "created_at", "updated_at" } ],
  "recurring_rules": [ … ], "recurring_occurrences": [ … ],
  "reconciliations": [ … ],
  "audit_log": [ … ]                                   // included, flagged; capped to last 20,000 rows
}
```
Rules: **money = integer paisa as JSON strings** (`"250050"`), dates ISO (`YYYY-MM-DD`), timestamps RFC 3339 UTC, ids preserved, soft-deleted transactions included with `deleted_at`, **no password hash, no sessions, no tokens**, `user_id` omitted (always the importing user). Derived loan fields (`remaining`, `status`) are **not** exported (TD-D2). A top-level `checksum` = sha256 of the canonical JSON of all other keys (detects truncation/corruption, not tampering).

Filename `envelope-backup-YYYY-MM-DD.json` (user-local date). Delivery: `GET /api/export/json` (auth required, `Cache-Control: no-store`, `Content-Disposition: attachment`); streamed with `JSON` writer per table using server-side cursors so memory stays flat; on mobile the client uses the Web Share API with a `File` when available, otherwise a normal download. Export is a read-only transaction (`REPEATABLE READ`) so tables are mutually consistent.

## 3. Export of CSV (FR-CSV-01, FR-SEC-03)

Endpoints: `GET /api/export/csv?kind=transactions|expenses|income|reconciliations&from=&to=`.

- UTF-8 **with BOM**, RFC 4180 quoting (quote fields containing `,` `"` CR LF; double inner quotes), `\r\n` line endings, ISO dates.
- `transactions` columns: `date, time, type, envelope, to_envelope, category, amount_pkr, note, loan, recurring, generated, owner_name, id`.
  - `amount_pkr` = **signed effect on Total** (income/deposit +, expense/withdrawal −, others `0.00`) rendered by `formatPlain(paisa)` = `-1234.50` (dot decimal, no grouping, no currency).
  - `to_envelope` for transfer/loan/repayment; `owner_name` for others' envelopes.
- Formula-injection neutralisation (**refines URD §6**): applies to **text-typed cells only** (envelope, category, note, names). Any text cell whose first character is one of `= + - @ \t \r` (after trimming nothing — check raw) is prefixed with `'`. **Numeric columns are written from a validated `^-?\d+\.\d{2}$` string and are never prefixed**, otherwise every negative amount (`-500.00`) would be corrupted (GAP U-09).
- `reconciliations`: `checked_at, expected_pkr, actual_pkr, difference_pkr, note, adjustment`.
- Date-range filter by `occurred_on` (or `checked_on`), validated, max 5 years per request; no range ⇒ all.
- Streaming response; row cap none (personal scale), but a 100 MB response guard returns `VALIDATION`.

## 4. Import (Replace) — pipeline (FR-BAK-03…06)

`POST /api/import` (multipart) or Server Action with `File`. UI flow in Settings → Data → Import:

1. **Pick file** → client checks extension/size ≤ 20 MB (FR-BAK-06) and shows file name + size.
2. **Pre-import backup gate (FR-BAK-04):** screen "Importing replaces everything currently in your account." with a button **Download a backup of my current data first** (must be pressed or explicitly waived by a checkbox "I already have a backup") and a typed confirmation `REPLACE`.
3. **Server validation (no writes):**
   1. Size/MIME/UTF-8/JSON parse; reject non-JSON.
   2. `schema_version`: unknown/newer → reject "This backup was made by a newer version of the app."; older → migrate through the versioned `migrators[n → n+1]` chain (pure functions, each tested with fixtures).
   3. Zod parse of the entire document (strict shape, string-paisa regex, enum values, ISO dates, lengths).
   4. **Snapshot ledger validation** (pure, `domain/backup/validateSnapshot`) — the *same* rules as the live system, collecting up to **20 problems** with human-readable messages and entity ids:
      - referential integrity (every FK target exists; envelope/category/loan/rule ids; splits belong to income; parent tx ids),
      - structural CHECK equivalents (`tx_shape`, amount ranges, ≤1 live opening balance, unique active envelope names, unique category names, system categories present once per kind),
      - ownership rules (external_* ↔ other envelopes; transfer/loan between mine),
      - loan consistency: each live loan has exactly one live origin tx; repayments reference live loans; running remaining ≥ 0 (reuse §6.3 logic in TS),
      - **timeline replay** with `findFirstViolation` over postings built by the TS ledger mirror (INV-1…3, INV-10),
      - recurring: unique `(rule_id, due_date)` and `(rule_id, slot_index)`, generated occurrences point to live transactions,
      - reconciliation arithmetic (`difference = actual − expected`),
      - archived envelopes balance 0; dates not in the future relative to *now* and ≥ 2000-01-01.
   5. Output: `{ ok: false, problems: [{path, message}] (≤ 20), totalProblems }` → UI lists them; **nothing was written**.
4. **Commit** (only if valid) in **one** `withUserWrite` transaction (same advisory lock):
   1. Compute the **file hash** (sha256 of bytes). Insert `import_runs(user_id, file_hash, imported_at, counts)`.
   2. Delete all user data in FK-safe order: `audit_log, reconciliations, recurring_occurrences, transaction_splits, transactions (with deferred loan/recurring FKs), loans, recurring_rules, envelopes, categories, idempotency_keys`; keep `users`, `sessions`.
   3. **ID strategy (TD-D9):** attempt to preserve ids. Check `SELECT id FROM <table> WHERE id = ANY($ids) AND user_id <> $me` for each table; any collision ⇒ remap **every** id in the file with `uuidv5(oldId, namespace = userId)` (deterministic, so re-importing the same file is idempotent). Remap applied consistently across FKs, `parent_transaction_id`, `loan_id`, `recurring_id`, `split_template` (JSON ids), `adjustment_transaction_id`.
   4. Insert in dependency order in batches of 1,000 (multi-row `INSERT … VALUES` / `COPY`), with loan/recurring FKs deferred.
   5. Update `users` preferences from `profile` **except email/password**; `ledger_revision = max(existing, imported) + 1`; set `onboarding_completed_at = now()` if absent.
   6. Re-run the **live** verifier for all envelopes and `runIntegrityCheck` inside the transaction; any failure ⇒ rollback and report "Import failed integrity check; nothing was changed" (belt-and-braces: the pure validation should have caught it).
   7. Commit; `revalidateTag` everything for the user.
5. Result screen: counts per table, balances before/after summary (Total / Unallocated), integrity ✓, and "Imported file identical to a previous import" if the hash matches the last import (FR-BAK-05). Importing the same file twice yields identical data (replace semantics + deterministic ids).
6. Atomicity: any exception ⇒ rollback ⇒ zero changes (test 48). Progress: upload progress bar + indeterminate "Checking…" / "Importing…" states; the long phase is server-side, so UI polls nothing — the request holds until done (limit 60 s; 20 MB imports comfortably fit at this scale; if exceeded, `maxDuration = 60` in route config).

### 4.1 Supporting table
```sql
CREATE TABLE import_runs (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_hash TEXT NOT NULL, schema_version INT NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT now(), counts JSONB NOT NULL);
```

### 4.2 Security of import
Treat the file as hostile: size cap before parse, depth-limited JSON parse (reject nesting > 20), Zod string length caps, no `eval`/dynamic keys (`__proto__`, `constructor` rejected by the strict schema), every text field passes `cleanText`, `user_id` ignored/overwritten, all inserts parameterised, rate-limited (3/hour). Imported notes/names are rendered as text only (XSS test with payloads in a fixture).

## 5. Account-deletion hook (FR-AUTH-08)
Delete-account flow first offers `Export JSON` (this endpoint), then proceeds (TD-02 §3.6).

## 6. Integrity of round trip
Contract: `export(A) → wipe → import → export(B)` ⇒ `canonical(A) == canonical(B)` ignoring `exported_at` (property test over random ledgers incl. soft-deleted rows, loans, rules, reconciliations). `Total`, every envelope balance, loan states, analytics outputs, and reconciliation statuses equal before/after.

## 7. Tests owned (URD §21 #48)
Export→wipe→import identical; corrupted ledger fixtures (negative running balance, orphan loan, orphan repayment, duplicate opening balance, bad FK, tampered checksum) rejected atomically with readable first-20 list; wrong/future schema version; same file twice idempotent; id-collision across users → deterministic remap and still consistent; oversize/non-JSON/deeply nested rejected; migrators v1→v1 (identity) now and fixtures framework for future versions; CSV: BOM present, quoting, formula neutralisation for `=cmd|…`, `+1`, `-2`, `@SUM`, tab-prefixed; negative amounts **not** prefixed; date-range filter; reconciliation CSV.

## 8. Acceptance
Reference scenario step 10: export JSON, import into a clean database under a new user → all balances, loans, history identical; a hand-corrupted file is rejected with a plain-language list and leaves the account untouched.
