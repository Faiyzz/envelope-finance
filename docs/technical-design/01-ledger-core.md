# TD-01 — Ledger Core (money, schema, postings, timeline validation, concurrency)

**URD coverage:** §3 (INV-1…10), §4 (all), §5 (core tables), §19 (money lib, FR-INT-01/02/03), FR-CON-01…03, FR-VAL-01…05.
**Depends on:** TD-00. **Used by:** every money feature (TD-04 … TD-09, TD-11).

This is the heart of the system. Nothing else may compute a balance by any other route.

---

## 1. Responsibilities

1. Integer money type, parsing, formatting (`domain/money`).
2. Local date/time utilities (`domain/dates`).
3. Core schema: `users` (ledger part), `envelopes`, `categories`, `transactions`, `transaction_splits`, `idempotency_keys`, `audit_log`.
4. The `ledger_effects` posting view and all derived balances.
5. Timeline validation (create/edit/delete/restore).
6. The per-user write lock, idempotency, optimistic concurrency, `ledger_revision`.
7. Soft delete / restore / purge semantics, audit log.
8. Integrity check (FR-INT-03).

## 2. Money (`domain/money`)

```ts
export type Paisa = bigint & { readonly __brand: 'Paisa' };
export const MAX_PAISA = 99_999_999_999n as Paisa;          // 999,999,999.99 PKR
export const paisa = (n: bigint): Paisa => n as Paisa;       // only constructor besides parse/sum

export type ParseResult = { ok: true; value: Paisa } | { ok: false; reason: ParseFailure };
export type ParseFailure = 'EMPTY' | 'FORMAT' | 'TOO_MANY_DECIMALS' | 'NOT_POSITIVE' | 'TOO_LARGE' | 'BAD_GROUPING';

parseMoney(input: string, opts?: { allowZero?: boolean; allowNegative?: boolean }): ParseResult
evaluateAmountExpression(input: string): ParseResult           // calculator: "1200+350"
formatMoney(p: Paisa, o?: { decimals?: 'auto'|'always'|'never'; sign?: 'auto'|'always'; currency?: boolean }): string
add(a, b) / sub(a, b) / neg(a) / abs(a) / cmp(a, b) / min(a, b) / max(a, b) / sum(ps: Paisa[])
```

### 2.1 Parsing rules (`parseMoney`)
Pipeline: **normalise → validate → convert**. No `parseFloat`, no `Number`, no `eval`.

1. `trim()`; strip internal spaces/NBSP; remove U+066C/U+060C separators.
2. **Digit normalisation** (FR-TXN-02): map Arabic-Indic `٠-٩` (U+0660–0669) and Extended Arabic-Indic/Urdu `۰-۹` (U+06F0–06F9) to ASCII; map Arabic decimal separator `٫` to `.`.
3. Grammar (anchored):
   - plain: `^\d+(\.\d{1,2})?$`
   - western grouping: `^\d{1,3}(,\d{3})+(\.\d{1,2})?$`
   - lakh grouping: `^\d{1,2}(,\d{2})*,\d{3}(\.\d{1,2})?$` (accepted on input regardless of display setting)
   - anything else with commas → `BAD_GROUPING`; more than 2 decimals → `TOO_MANY_DECIMALS`; `"-5"`, `"1e3"`, `"0x10"`, `".5"`, `"5."`, `"NaN"` → `FORMAT`.
4. Convert: `BigInt(intPart) * 100n + BigInt(frac.padEnd(2,'0'))`.
5. Range: `0 < v ≤ MAX_PAISA` (or `0 ≤ v` when `allowZero`; signed `|v|` when `allowNegative` — adjustments only). One paisa above the max → `TOO_LARGE`.

### 2.2 Calculator (`evaluateAmountExpression`)
Grammar: `term ('+' term)*` where each `term` is a plain/grouped amount per §2.1 (no sign, no parentheses, no `-`,`*`,`/`). Split on `+`, parse each term with `allowZero:false`, `sum`, re-check range. `"1200+350"` → `155000n`. Input with trailing `+` → `FORMAT`. (TD-D10.)

### 2.3 Formatting
- Implements western grouping itself (digit-string regex `\B(?=(\d{3})+(?!\d))`) — **do not use `Intl.NumberFormat('en-PK')`**: ICU may emit lakh grouping, and `Number(bigint)` is unnecessary.
- `decimals:'auto'` (default): whole rupees → `2,500 PKR`; non-zero paisa → `2,500.50 PKR`.
- Negative: true minus `−` (U+2212) + `abs` formatted; never `-5.-50` (TD v1.0 bug). `sign:'always'` renders `+2,500`/`−2,500` for lists.
- A setting `number_grouping: 'western'|'lakh'` (TD-03) switches the regex; default western (D9).

### 2.4 Required property tests (domain)
`sum` of 10,000 random paisa arrays equals a reference `BigInt` fold; `parse(format(x)) == x` for all `x` in range; 0.1+0.2-style inputs (`"0.10"+"0.20"`) give exactly `30n`; `format` never emits `NaN`/`undefined`/double minus.

## 3. Dates (`domain/dates`)

```ts
export type LocalDate = string & { __b: 'LocalDate' };      // 'YYYY-MM-DD'
export type LocalTime = string & { __b: 'LocalTime' };      // 'HH:MM:SS'
parseLocalDate(s): LocalDate | null          // strict calendar validation (no JS Date)
addDays(d, n) / addMonthsClamped(d, n, anchorDay) / addYears(d, n)
daysInMonth(y, m) / isLeap(y) / compare(a, b) / diffDays(a, b)
startOfMonth(d) / endOfMonth(d) / monthsBetween(from, to): LocalDate[]   // first-of-month list
todayIn(tz: string, now: Instant): LocalDate  // the ONLY tz conversion (Intl.DateTimeFormat 'en-CA' with timeZone)
nowTimeIn(tz, now): LocalTime
MIN_DATE = '2000-01-01'
```
Implementation uses integer day-number arithmetic (civil-from-days algorithm). Unit tests: month ends, leap years (2024-02-29, 2100 not leap), year boundaries, 31→Feb clamping, `todayIn` at `2026-10-05T19:30:00Z` for `Asia/Karachi` = `2026-10-06`.

**Server date authority (§4.4):** `assertDateAllowed(date, today)`:
- `date > today` → `VALIDATION{date}`: "You can't record a transaction in the future. Use a recurring transaction for upcoming payments."
- `date < MIN_DATE` → `VALIDATION{date}`.
- Client-supplied "today" is ignored; client sends only the chosen date. (The ">1 day ahead" tolerance in URD §4.4 is therefore subsumed: the server compares to its own `today`.)
- Time default: if `occurredAt` omitted → `nowTimeIn(tz)` when `date == today`, else `12:00:00`. Always stored (`NOT NULL`).

## 4. Core schema (SQL migration `0001_core.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
  currency TEXT NOT NULL DEFAULT 'PKR' CHECK (currency = 'PKR'),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  number_grouping TEXT NOT NULL DEFAULT 'western' CHECK (number_grouping IN ('western','lakh')),
  week_start SMALLINT NOT NULL DEFAULT 1 CHECK (week_start IN (0,1,6)),      -- 1=Mon
  hide_balances_default BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_completed_at TIMESTAMPTZ,
  ledger_revision BIGINT NOT NULL DEFAULT 0,                                   -- TD-D5
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE envelopes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description TEXT CHECK (char_length(description) <= 300),
  icon TEXT NOT NULL DEFAULT '💼',
  color TEXT,                                                                    -- design token name
  owner_type TEXT NOT NULL DEFAULT 'mine' CHECK (owner_type IN ('mine','other')),
  owner_name TEXT CHECK (char_length(owner_name) <= 60),
  kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','savings')),
  goal_amount_paisa BIGINT CHECK (goal_amount_paisa IS NULL OR goal_amount_paisa > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CONSTRAINT env_owner_name CHECK (owner_type <> 'other' OR (owner_name IS NOT NULL AND btrim(owner_name) <> '')),
  CONSTRAINT env_archived CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_env_active_name ON envelopes (user_id, lower(btrim(name))) WHERE status = 'active';
CREATE INDEX ix_env_user_status ON envelopes (user_id, status, sort_order);

CREATE TABLE categories (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
  group_name TEXT CHECK (group_name IN ('home','personal','other')),            -- "group" is reserved
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CONSTRAINT cat_system_active CHECK (NOT is_system OR status = 'active')
);
CREATE UNIQUE INDEX uq_cat_name ON categories (user_id, kind, lower(btrim(name)));
CREATE UNIQUE INDEX uq_cat_system ON categories (user_id, kind) WHERE is_system;

CREATE TYPE transaction_type AS ENUM (
  'opening_balance','income','external_deposit','expense','external_withdrawal',
  'allocation','deallocation','transfer','loan','loan_repayment','adjustment');

CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type transaction_type NOT NULL,
  amount_paisa BIGINT NOT NULL,
  occurred_on DATE NOT NULL CHECK (occurred_on >= DATE '2000-01-01'),
  occurred_at TIME NOT NULL DEFAULT TIME '12:00:00',
  envelope_id UUID,                   -- SOURCE ("from") for movement types; the envelope for single-envelope types
  counterpart_envelope_id UUID,       -- DESTINATION ("to") for transfer / loan / loan_repayment
  category_id UUID,
  note TEXT CHECK (char_length(note) <= 500),
  loan_id UUID,                       -- FK added in TD-06 migration (DEFERRABLE INITIALLY DEFERRED)
  recurring_id UUID,                  -- FK added in TD-07 migration
  is_generated BOOLEAN NOT NULL DEFAULT FALSE,
  parent_transaction_id UUID,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, envelope_id)             REFERENCES envelopes (user_id, id),
  FOREIGN KEY (user_id, counterpart_envelope_id) REFERENCES envelopes (user_id, id),
  FOREIGN KEY (user_id, category_id)             REFERENCES categories (user_id, id),
  FOREIGN KEY (user_id, parent_transaction_id)   REFERENCES transactions (user_id, id),
  CONSTRAINT tx_deleted_pair CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  CONSTRAINT tx_amount CHECK (
    CASE type
      WHEN 'adjustment'      THEN amount_paisa <> 0 AND abs(amount_paisa) <= 99999999999
      WHEN 'opening_balance' THEN amount_paisa BETWEEN 0 AND 99999999999     -- TD-D4
      ELSE amount_paisa BETWEEN 1 AND 99999999999
    END),
  CONSTRAINT tx_shape CHECK (
    CASE
      WHEN type = 'opening_balance'
        THEN envelope_id IS NULL AND counterpart_envelope_id IS NULL AND category_id IS NULL AND loan_id IS NULL
      WHEN type = 'income'
        THEN envelope_id IS NULL AND counterpart_envelope_id IS NULL AND category_id IS NOT NULL AND loan_id IS NULL
      WHEN type = 'expense'
        THEN envelope_id IS NOT NULL AND counterpart_envelope_id IS NULL AND category_id IS NOT NULL AND loan_id IS NULL
      WHEN type IN ('external_deposit','external_withdrawal','allocation','deallocation')
        THEN envelope_id IS NOT NULL AND counterpart_envelope_id IS NULL AND category_id IS NULL AND loan_id IS NULL
      WHEN type = 'transfer'
        THEN envelope_id IS NOT NULL AND counterpart_envelope_id IS NOT NULL
             AND envelope_id <> counterpart_envelope_id AND category_id IS NULL AND loan_id IS NULL
      WHEN type IN ('loan','loan_repayment')
        THEN envelope_id IS NOT NULL AND counterpart_envelope_id IS NOT NULL
             AND envelope_id <> counterpart_envelope_id AND category_id IS NULL AND loan_id IS NOT NULL
      WHEN type = 'adjustment'                       -- envelope_id NULL ⇒ target is Unallocated
        THEN counterpart_envelope_id IS NULL AND category_id IS NULL AND loan_id IS NULL
    END)
);
CREATE UNIQUE INDEX uq_tx_opening ON transactions (user_id) WHERE type = 'opening_balance' AND deleted_at IS NULL;
CREATE INDEX ix_tx_user_time  ON transactions (user_id, occurred_on DESC, occurred_at DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_tx_env        ON transactions (user_id, envelope_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_tx_cp_env     ON transactions (user_id, counterpart_envelope_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_tx_cat        ON transactions (user_id, category_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_tx_type       ON transactions (user_id, type) WHERE deleted_at IS NULL;
CREATE INDEX ix_tx_loan       ON transactions (user_id, loan_id) WHERE loan_id IS NOT NULL;
CREATE INDEX ix_tx_recurring  ON transactions (user_id, recurring_id) WHERE recurring_id IS NOT NULL;
CREATE INDEX ix_tx_deleted    ON transactions (user_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX ix_tx_note_trgm  ON transactions USING gin (note gin_trgm_ops);

CREATE TABLE transaction_splits (                  -- income only
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL,
  envelope_id UUID NOT NULL,
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa BETWEEN 1 AND 99999999999),
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, envelope_id)    REFERENCES envelopes (user_id, id),
  UNIQUE (transaction_id, envelope_id)
);
CREATE INDEX ix_split_tx ON transaction_splits (user_id, transaction_id);
CREATE INDEX ix_split_env ON transaction_splits (user_id, envelope_id);

CREATE TABLE idempotency_keys (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key UUID NOT NULL,
  action TEXT NOT NULL,
  request_hash TEXT NOT NULL,                       -- sha256 of canonical input JSON
  response JSONB NOT NULL,                          -- ActionResult with money as strings
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id, key)
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,                             -- 'transaction','loan','envelope','category','recurring_rule','reconciliation'
  entity_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete','restore','archive','unarchive')),
  before_json JSONB, after_json JSONB,              -- bigint serialised as strings
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_log (user_id, entity, entity_id, at DESC);
CREATE INDEX ix_audit_user_at ON audit_log (user_id, at DESC);
```

### 4.1 Triggers (migration `0002_core_triggers.sql`)

Constraints that need other rows, enforced in the DB as defence in depth (the app validates first and returns friendly errors):

```sql
-- (a) updated_at maintenance for every table that has it
CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;

-- (b) transactions: version bump on UPDATE (optimistic concurrency, FR-CON-03)
CREATE FUNCTION tx_bump_version() RETURNS trigger AS $$
BEGIN IF NEW IS DISTINCT FROM OLD THEN NEW.version := OLD.version + 1; NEW.updated_at := now(); END IF; RETURN NEW; END $$ LANGUAGE plpgsql;

-- (c) transactions: ownership and category-kind rules, checked on INSERT/UPDATE
CREATE FUNCTION tx_check_refs() RETURNS trigger AS $$
DECLARE o_from TEXT; o_to TEXT; ck TEXT;
BEGIN
  IF NEW.envelope_id IS NOT NULL THEN SELECT owner_type INTO o_from FROM envelopes WHERE id = NEW.envelope_id; END IF;
  IF NEW.counterpart_envelope_id IS NOT NULL THEN SELECT owner_type INTO o_to FROM envelopes WHERE id = NEW.counterpart_envelope_id; END IF;
  IF NEW.type IN ('external_deposit','external_withdrawal') AND o_from <> 'other' THEN RAISE EXCEPTION 'external_* requires an other-owned envelope' USING ERRCODE='23514'; END IF;
  IF NEW.type IN ('transfer','loan','loan_repayment') AND (o_from <> 'mine' OR o_to <> 'mine') THEN RAISE EXCEPTION 'transfer/loan requires mine envelopes' USING ERRCODE='23514'; END IF;
  IF NEW.category_id IS NOT NULL THEN
    SELECT kind INTO ck FROM categories WHERE id = NEW.category_id;
    IF (NEW.type = 'expense' AND ck <> 'expense') OR (NEW.type = 'income' AND ck <> 'income') THEN RAISE EXCEPTION 'category kind mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- (d) envelopes: owner_type immutable once referenced (URD §5)
CREATE FUNCTION env_owner_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.owner_type <> OLD.owner_type AND (
       EXISTS (SELECT 1 FROM transactions WHERE envelope_id = OLD.id OR counterpart_envelope_id = OLD.id)
    OR EXISTS (SELECT 1 FROM transaction_splits WHERE envelope_id = OLD.id)) THEN
    RAISE EXCEPTION 'owner_type is immutable once the envelope has transactions' USING ERRCODE='23514';
  END IF; RETURN NEW; END $$ LANGUAGE plpgsql;

-- (e) splits: Σ splits ≤ income amount, and parent must be an income (deferred so multi-row insert works)
CREATE FUNCTION split_check() RETURNS trigger AS $$
DECLARE t RECORD; s BIGINT;
BEGIN
  SELECT type, amount_paisa INTO t FROM transactions WHERE id = COALESCE(NEW.transaction_id, OLD.transaction_id);
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount_paisa),0) INTO s FROM transaction_splits WHERE transaction_id = COALESCE(NEW.transaction_id, OLD.transaction_id);
  IF t.type <> 'income' AND s > 0 THEN RAISE EXCEPTION 'splits only on income' USING ERRCODE='23514'; END IF;
  IF s > t.amount_paisa THEN RAISE EXCEPTION 'splits exceed income amount' USING ERRCODE='23514'; END IF;
  RETURN NULL; END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_split_check AFTER INSERT OR UPDATE OR DELETE ON transaction_splits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION split_check();
-- also re-run when the income amount is edited: AFTER UPDATE OF amount_paisa ON transactions … (same function via wrapper)
```
`ERRCODE 23514` (check_violation) from these triggers is mapped to `RULE_VIOLATION` with a generic message if it ever escapes the app-level checks (it indicates an app bug; logged at `error`).

### 4.2 Row-Level Security
Defined in TD-02 §9; every table above gets `ENABLE ROW LEVEL SECURITY` + a `user_id = current_setting('app.user_id')::uuid` policy.

## 5. Posting model — `ledger_effects`

**Convention (TD-D1):** for movement types `envelope_id` = source, `counterpart_envelope_id` = destination.

| Type | TOTAL | UNALLOCATED | envelope_id | counterpart_envelope_id | splits |
|---|---|---|---|---|---|
| opening_balance | +A | +A | | | |
| income | +A | +(A − Σsplits) | | | each split env **+s** |
| external_deposit | +A | | +A | | |
| expense | −A | | −A | | |
| external_withdrawal | −A | | −A | | |
| allocation | | −A | +A | | |
| deallocation | | +A | −A | | |
| transfer | | | −A | +A | |
| loan (lender→borrower) | | | −A (lender) | +A (borrower) | |
| loan_repayment (borrower→lender) | | | −A (borrower) | +A (lender) | |
| adjustment (A signed) | +A | +A **iff** `envelope_id IS NULL` | +A when set | | |

(Blank = 0.) INV-5 follows from the table: allocation/deallocation/transfer/loan/repayment have no TOTAL posting.

```sql
-- migration 0003_ledger_views.sql
CREATE VIEW ledger_effects AS
SELECT t.user_id, t.id AS transaction_id, t.type AS tx_type,
       t.occurred_on, t.occurred_at, t.created_at,
       p.account, p.envelope_id, p.delta
FROM transactions t
LEFT JOIN LATERAL (SELECT COALESCE(SUM(s.amount_paisa), 0) AS split_total
                   FROM transaction_splits s WHERE s.transaction_id = t.id) sp ON TRUE
CROSS JOIN LATERAL (VALUES
  ('TOTAL'::text, NULL::uuid,
     CASE t.type WHEN 'opening_balance' THEN t.amount_paisa WHEN 'income' THEN t.amount_paisa
                 WHEN 'external_deposit' THEN t.amount_paisa WHEN 'adjustment' THEN t.amount_paisa
                 WHEN 'expense' THEN -t.amount_paisa WHEN 'external_withdrawal' THEN -t.amount_paisa
                 ELSE 0 END),
  ('UNALLOCATED', NULL::uuid,
     CASE WHEN t.type = 'opening_balance' THEN t.amount_paisa
          WHEN t.type = 'income'          THEN t.amount_paisa - sp.split_total
          WHEN t.type = 'deallocation'    THEN t.amount_paisa
          WHEN t.type = 'allocation'      THEN -t.amount_paisa
          WHEN t.type = 'adjustment' AND t.envelope_id IS NULL THEN t.amount_paisa
          ELSE 0 END),
  ('ENVELOPE', t.envelope_id,
     CASE WHEN t.type IN ('expense','external_withdrawal','deallocation','transfer','loan','loan_repayment') THEN -t.amount_paisa
          WHEN t.type IN ('external_deposit','allocation','adjustment') THEN t.amount_paisa
          ELSE 0 END),
  ('ENVELOPE', t.counterpart_envelope_id,
     CASE WHEN t.type IN ('transfer','loan','loan_repayment') THEN t.amount_paisa ELSE 0 END)
) AS p(account, envelope_id, delta)
WHERE t.deleted_at IS NULL
  AND p.delta <> 0
  AND (p.account <> 'ENVELOPE' OR p.envelope_id IS NOT NULL)

UNION ALL                                           -- income splits
SELECT s.user_id, s.transaction_id, t.type, t.occurred_on, t.occurred_at, t.created_at,
       'ENVELOPE', s.envelope_id, s.amount_paisa
FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
WHERE t.deleted_at IS NULL;
```
Differences from TD v1.0 (all were defects): explicit `envelope_id UUID` column instead of stringly-typed `account` (no `::UUID` cast on `'TOTAL'`); `adjustment` now posts to `TOTAL`; orientation defined; dead `transfer` branch removed; zero-delta rows dropped.

**FR-LED-01 compliance:** the table in §5 exists in exactly one place per language — the SQL view (authoritative) and `domain/ledger/effects.ts` (a TS mirror used *only* by simulators/tests and the import snapshot validator). A **differential test** (§11) asserts they agree for randomly generated ledgers.

### 5.1 Derived balances
```sql
CREATE VIEW envelope_balances AS                      -- one row per envelope, zero if no postings
SELECT e.user_id, e.id AS envelope_id, COALESCE(SUM(le.delta), 0)::bigint AS balance_paisa
FROM envelopes e
LEFT JOIN ledger_effects le ON le.user_id = e.user_id AND le.account = 'ENVELOPE' AND le.envelope_id = e.id
GROUP BY e.user_id, e.id;

CREATE VIEW ledger_totals AS
SELECT u.id AS user_id,
  COALESCE((SELECT SUM(delta) FROM ledger_effects WHERE user_id = u.id AND account = 'TOTAL'), 0)::bigint AS total_paisa,
  COALESCE((SELECT SUM(delta) FROM ledger_effects WHERE user_id = u.id AND account = 'UNALLOCATED'), 0)::bigint AS unallocated_explicit_paisa,
  COALESCE((SELECT SUM(balance_paisa) FROM envelope_balances WHERE user_id = u.id), 0)::bigint AS envelopes_paisa,
  COALESCE((SELECT SUM(eb.balance_paisa) FROM envelope_balances eb JOIN envelopes e ON e.id = eb.envelope_id
            WHERE e.user_id = u.id AND e.owner_type = 'mine'), 0)::bigint AS mine_paisa,
  COALESCE((SELECT SUM(eb.balance_paisa) FROM envelope_balances eb JOIN envelopes e ON e.id = eb.envelope_id
            WHERE e.user_id = u.id AND e.owner_type = 'other'), 0)::bigint AS other_paisa
FROM users u;
```
Application values (FR-LED-02): `unallocated = total − envelopes`; `yourMoney = unallocated + mine`; `heldForOthers = other`. The `unallocated_explicit_paisa` column exists **only** for the integrity check: `unallocated_explicit == total − envelopes` must always hold.

`Borrowed(env)`, `LoanedOut(env)`, `OwnFunds` come from `loan_state` (TD-06).

## 6. Timeline validation (FR-VAL-01…05, INV-2/3/10)

### 6.1 Strategy: *apply, then verify, rollback on violation*
Inside the write transaction, after the change is applied (insert / update / soft-delete / restore), run the verifier for every **touched** account. If a violation exists, throw `TimelineViolation` → the whole transaction rolls back. This treats edit as "delete old + insert new" (FR-VAL-03) automatically, because the verifier looks at the resulting ledger, and it cannot disagree with the real balance function because it reads the same view.

*Touched accounts* = the union of envelope ids (`envelope_id`, `counterpart_envelope_id`, split envelopes) of the **old** and **new** version of every changed transaction, plus `UNALLOCATED` always, plus loan ids touched. Actions register them with `ctx.touch()`.

### 6.2 Verifier SQL (envelopes + Unallocated)
```sql
WITH running AS (
  SELECT le.account, le.envelope_id, le.transaction_id, le.occurred_on, le.occurred_at, le.created_at,
         SUM(le.delta) OVER (
           PARTITION BY le.account, le.envelope_id
           ORDER BY le.occurred_on, le.occurred_at, le.created_at, le.transaction_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS bal
  FROM ledger_effects le
  WHERE le.user_id = $1
    AND le.account <> 'TOTAL'
    AND (le.account = 'UNALLOCATED' OR le.envelope_id = ANY($2::uuid[]))
)
SELECT account, envelope_id, transaction_id, occurred_on, occurred_at, -bal AS shortfall_paisa
FROM running WHERE bal < 0
ORDER BY occurred_on, occurred_at, created_at, transaction_id
LIMIT 1;
```
`(user_id, transaction_id, account, envelope_id)` is unique, so the window order is total (ties impossible). Cost: replays touched accounts' full history — personal-scale data (≤ ~50k rows) executes in tens of ms with `ix_tx_env`/`ix_tx_cp_env`. (Optimisation reserved: start from a checkpoint balance at the earliest affected timestamp, as FR-VAL-01 suggests; not needed for V1 and adds correctness risk.)

### 6.3 Verifier SQL (loans) — FR-VAL-04
Each loan has a single `loan` posting (+A) and N `loan_repayment` postings (−A). Running remaining per loan must never be negative (covers "repayment before loan", "overpayment", "delete loan with repayments", "edit loan amount below repaid"):
```sql
WITH r AS (
  SELECT t.loan_id, t.id, t.occurred_on, t.occurred_at, t.created_at,
         SUM(CASE t.type WHEN 'loan' THEN t.amount_paisa ELSE -t.amount_paisa END) OVER (
           PARTITION BY t.loan_id ORDER BY t.occurred_on, t.occurred_at, t.created_at, t.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS remaining
  FROM transactions t
  WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.type IN ('loan','loan_repayment') AND t.loan_id = ANY($2::uuid[]))
SELECT loan_id, id, occurred_on, -remaining AS shortfall FROM r WHERE remaining < 0 ORDER BY occurred_on LIMIT 1;
```
`remaining ≤ original` holds automatically (only one `loan` row per loan — partial unique index in TD-06).

### 6.4 Pure counterpart (`domain/validation/timeline.ts`)
The same rule as a pure function used by the snapshot validator (import, TD-11) and simulators:
```ts
export interface Posting { txId: string; seq: SortKey; account: 'UNALLOCATED'|'ENVELOPE'; envelopeId: string|null; delta: Paisa; }
export type SortKey = readonly [on: LocalDate, at: LocalTime, createdAt: string, id: string];
export type Violation =
  | { kind: 'envelope'; envelopeId: string; at: LocalDate; txId: string; shortfall: Paisa }
  | { kind: 'unallocated'; at: LocalDate; txId: string; shortfall: Paisa }
  | { kind: 'loan'; loanId: string; at: LocalDate; txId: string; shortfall: Paisa };
export function findFirstViolation(postings: Posting[]): Violation | null;   // sorts, replays, first negative
```
It never takes a DB handle (TD v1.0's `validateTimeline(userId, ids, db)` was impure and had query typos).

### 6.5 Messages (FR-VAL-02)
`TimelineViolation` carries `Violation` plus `OpContext` (`{kind:'delete'|'edit'|'create'|'restore', tx: {type, amount}}`). `messages.timeline(v, ctx, names)` renders plain language including **first violating date, envelope name, shortfall, and the culprit**:

- delete income: "Deleting this 150,000 salary would leave Home with −3,000 on 12 Oct (the Groceries expense that day). Delete or edit that expense first."
- backdated expense: "Home only had 1,200 on 3 Oct, so a 2,500 expense on that date isn't possible. Pick a later date or add money to Home first."
- unallocated: "This would leave Unallocated at −20,000 on 5 Oct."
The culprit tx is `v.txId` (the posting at which the balance first went negative); the message builder fetches its category/note/amount for the "(the … expense that day)" clause.

## 7. Write lock, idempotency, concurrency (FR-CON-01…03)

```ts
// server/db/withUserWrite.ts
export async function withUserWrite<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return pool.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);   // = SET LOCAL
    return fn(tx);                                                              // fn MUST use this tx
  });
}
```
- Default isolation `READ COMMITTED` is sufficient *because* all writers for a user are serialised by the advisory lock (xact-scoped → released at commit/rollback, safe under transaction pooling). `SERIALIZABLE`+retry is **not** used (TD v1.0 offered it as an alternative with an invalid API).
- Two phones / double-tap: the second action blocks on the lock, then validates against the first's committed result → exactly one of two competing expenses succeeds (URD test 11).
- **Idempotency** (FR-CON-02) is done *inside* the locked txn so concurrent retries can't race:
  1. `SELECT response, request_hash FROM idempotency_keys WHERE user_id=$1 AND key=$2 AND expires_at>now()`.
  2. Hit with equal `request_hash` → return stored response, **no writes**. Hit with different hash → `CONFLICT`("This request key was already used for a different action").
  3. Miss → run, `INSERT … ON CONFLICT DO NOTHING`, store the `ActionResult` (money as strings; `JSON.stringify` never sees `bigint`).
- **Optimistic concurrency** (FR-CON-03): edit inputs carry `version`. `UPDATE … WHERE id=$ AND user_id=$ AND version=$v AND deleted_at IS NULL RETURNING *`; zero rows → re-select: absent → `NOT_FOUND`, present → `CONFLICT`: "This was changed on another device. Reload to see the latest." Non-ledger entities (envelopes, categories, rules) use `updated_at` equality the same way.
- **`ledger_revision`**: every write that changes the ledger or reconciliation-relevant data runs `UPDATE users SET ledger_revision = ledger_revision + 1 WHERE id=$1` (also bumps for restore/purge). Used by TD-08.

## 8. Transaction mutation semantics (shared by all types)

Generic repo operations (feature docs add type-specific input validation):

| Op | Steps (all inside `withUserWrite`) |
|---|---|
| `insertTx(row, splits?)` | assign UUIDv7 id; insert; insert splits; `touch` envelopes; audit `create` |
| `updateTx(id, patch, version)` | `SELECT … FOR UPDATE`; version check; reject immutable-field change (`type`, `loan_id` on non-loan UI); apply patch; **replace** splits if provided; `touch` old ∪ new accounts; audit `update` with before/after |
| `softDeleteTx(id)` | set `deleted_at`, `deleted_by`; `touch`; audit `delete` |
| `restoreTx(id)` | clear both; re-check referenced envelopes still exist (archived envelope → `RULE_VIOLATION`: "Unarchive Home first"); `touch`; audit `restore` |

After the op, `verifyTimeline(touched)` runs; violation → rollback. Referential/active checks (archived envelope cannot receive new tx, FR-TXN-05) are done in the action before insert so errors are friendly; edits of old transactions that already reference an archived envelope may keep it only if the field is unchanged.

**Opening balance** is the sole transaction that cannot be deleted while other non-deleted transactions exist (FR-ONB-01); edit allowed, validated by §6.

## 9. Soft delete, restore, purge, audit

- Soft-deleted rows are excluded from `ledger_effects` and all lists; they appear only in "Recently deleted" (TD-03/05) for 30 days. Purge job (TD-00 §7) hard-deletes expired rows; FKs `recurring_occurrences.transaction_id` and `reconciliations.adjustment_transaction_id` are `ON DELETE SET NULL`.
- `audit_log` is append-only (no UPDATE/DELETE grants to the app role except cascade with user deletion). `before_json/after_json` are the row snapshots (+ splits). Not exposed in UI in V1; included in JSON export (TD-11).

## 10. Integrity check (FR-INT-03)

`runIntegrityCheck(userId): IntegrityReport` — read-only; **never repairs**. Checks:

| # | Check | Query idea |
|---|---|---|
| I1 | INV-1: `total = Σenvelopes + unallocated` and `unallocated_explicit = total − envelopes` | `ledger_totals` |
| I2 | INV-2/10: no envelope running balance < 0 at any time | §6.2 for **all** envelopes |
| I3 | INV-3: Unallocated running balance ≥ 0 | §6.2 |
| I4 | Loans: running remaining ≥ 0; `loan` row exists exactly once per `loans` row; both parties `mine` | §6.3 + joins |
| I5 | Orphans: transactions pointing at missing/foreign-user envelopes/categories/loans; splits Σ ≤ amount | joins |
| I6 | Opening balance: ≤ 1 non-deleted row | count |
| I7 | Archived envelopes have balance 0 and no active loans | joins |
| I8 | Recurring: `(rule_id, due_date)` unique; generated occurrences point to live transactions | joins |
| I9 | Reconciliation: stored `difference = actual − expected` | arithmetic |
| I10 | Caches: any cache table/column (none in V1 — this check is the hook for future caches) equals derived | n/a |

Output `{ ok, checkedAt, findings: [{ id, severity, message, ref? }] }`; persisted in `integrity_runs(user_id, at, ok, findings jsonb)`. UI (Settings → Data) shows it; nightly job writes it and flags the dashboard attention strip only on failure.

## 11. Tests owned by this document

- **Unit:** URD §21 tests 1–3 (money), date utilities, `findFirstViolation`, message rendering.
- **Differential:** random ledger generator → (a) SQL `ledger_effects` aggregates, (b) TS `effects.ts` aggregates; must match exactly (INV-1…5).
- **Property (fast-check, ≥ 1000 sequences):** operations `{income(splits), expense, allocate, deallocate, transfer, extDeposit, extWithdrawal, loan, repay, edit, delete, restore, backdated variants}` against a **reference in-memory model**; after every step (accepted or rejected) assert INV-1…6, INV-10, that rejected ops leave state unchanged, and that the DB result equals the model's decision (accept/reject) — i.e. the verifier is neither too strict nor too lax.
- **Integration (Testcontainers):** URD tests 4–14, 52; concurrency test with 20 parallel writers asserting no invariant breach and exactly-N-successes; idempotency double-submit; stale `version` → `CONFLICT`; trigger errors surface as `RULE_VIOLATION`.

## 12. Acceptance
INV-1…10 property suite green; reference scenario steps 1–6 produce the exact numbers in URD §22; deleting a salary that funded later spending is rejected with the first violating date/envelope/shortfall; two simultaneous overspending expenses → one succeeds; the integrity check returns `ok` for all test fixtures and reports a deliberately corrupted row without modifying it.
