# TD-00 — Foundation & Architecture

**Applies to:** every other TD document. Read this first.
**URD coverage:** §0, §2, §19 (stack, errors, observability, time, migrations), cross-cutting parts of §6/§11.1.
**Depends on:** nothing. **Used by:** TD-01 … TD-13.

---

## 1. Purpose

Defines the things every feature shares: stack and driver choices (with the constraints that make them *work*), repo layout and layering rules, conventions for IDs / money / dates on the wire, the single server-action pipeline, the error model, logging, i18n, background jobs, and the `DECISIONS.md` process.

## 2. Stack (with binding constraints)

| Concern | Choice | Binding constraint (why) |
|---|---|---|
| Framework | Next.js App Router, TypeScript `strict`, `noUncheckedIndexedAccess` | Server Components for reads, Server Actions for writes |
| DB | PostgreSQL ≥ 15 (Neon or Supabase) | Needs `citext`, `pg_trgm`, window functions, partial/expression indexes, advisory locks, RLS |
| **DB driver** | `pg` (node-postgres) or `postgres.js` over a **pooled** connection string; on Neon use `@neondatabase/serverless` **`Pool` (WebSocket)** | **Do NOT use `neon-http`/HTTP drivers**: they have no interactive transactions, so `pg_advisory_xact_lock` + multi-statement validate-then-commit (TD-01 §7) is impossible. Pool must be transaction-pooling-safe: use only `SET LOCAL`, never session `SET`, never session-level advisory locks. |
| ORM | Drizzle ORM + `drizzle-kit` | Views, triggers, RLS and CHECKs live in **hand-written SQL migration files** (drizzle `--custom`); Drizzle schema mirrors them for typing only |
| Validation | Zod | Every server input; shared with client forms |
| Auth | Auth.js v5 Credentials + **JWT sessions** + custom `sessions` table | See TD-02 (Credentials provider cannot use DB sessions) |
| UI | Tailwind, shadcn/ui (Radix), Framer Motion, Recharts | |
| Client state | **Server Components + `revalidateTag` + `useOptimistic`**; React Hook Form + Zod for forms; `@tanstack/react-query` **only** for infinite lists (transactions, search) | Resolves TD v1.0 contradiction (React Query vs RSC) |
| PWA | Serwist | TD-12 |
| Tests | Vitest, fast-check, Playwright, Testcontainers (Postgres) | TD-13 |
| Deploy | Vercel (+ Neon). Functions region close to DB (e.g. DB `ap-southeast-1`, functions `sin1`) | Round-trips dominate latency; keep app & DB co-located |
| IDs | UUIDv7 generated in the app (`uuidv7` package); DB default `gen_random_uuid()` as fallback | Time-ordered keys, index-friendly |

## 3. Repository layout and layering

```
src/
  domain/                 # PURE TypeScript. No imports from next/*, react, drizzle, pg, auth.
    money/                # TD-01
    dates/                # LocalDate utilities (TD-01 §3)
    ledger/               # postings, effects (TS mirror used for simulation/tests), snapshot validator
    validation/           # timeline violation finder, messages
    loans/                # TD-06
    recurrence/           # TD-07
    reconciliation/       # TD-08
    analytics/            # TD-09 (largest-remainder, range maths)
    backup/               # TD-11 (schema, migrators, snapshot validation)
    errors.ts             # domain error classes
  server/
    db/                   # client, schema.ts, migrations/, repos/*.ts (all SQL lives here)
    actions/              # Server Actions: thin orchestration only
    jobs/                 # cron tasks
    auth/                 # Auth.js config, session helpers, rate limiter
    http/                 # route handlers helpers
  app/                    # routes, layouts (RSC)
  components/             # UI
  messages/en.ts          # every user-visible string (i18n-ready)
  lib/                    # client-only helpers (hooks, idb, sw bridge)
tests/{unit,integration,property,e2e,idor}/
```

**Layering rules (enforced by ESLint `no-restricted-imports` + `eslint-plugin-boundaries`, failing CI):**

1. `domain/**` may import only from `domain/**` and `zod`/`uuid` types. It never touches `Date.now()`, `new Date()` (no-arg), `Math.random`, or I/O: time and randomness are *parameters*.
2. `server/actions/**` call `server/db/repos/**` and `domain/**`; they contain no SQL and no business rules beyond orchestration (FR-INT-01).
3. `app/**` and `components/**` never import `server/db/**`. They call actions or read-model functions in `server/db/queries/**` (RSC only).
4. Custom ESLint rules (CI-blocking): ban `parseFloat`, `parseInt` on money, `Number(<Paisa>)`, `toFixed`, unary `+` on money strings, and `*`/`/` on values typed `Paisa` (use a branded type + lint rule `no-float-money`).

## 4. Cross-cutting conventions

### 4.1 Money on the wire
`Paisa` is a branded `bigint` in domain code. **JSON/Server Action boundary format = decimal string of integer paisa** (`"250050"`). `bigint` is never passed to `JSON.stringify` (it throws). Zod helper:

```ts
export const PaisaStr = z.string().regex(/^-?\d{1,18}$/).transform((s) => BigInt(s) as Paisa);
export const PositivePaisaStr = PaisaStr.refine((p) => p > 0n && p <= MAX_PAISA);
```
DB driver returns `BIGINT` as `string`; repos convert to `bigint` at the boundary (Drizzle `bigint({ mode: 'bigint' })`). UI converts paisa↔display only through `domain/money`.

### 4.2 Dates
- `LocalDate` = branded string `'YYYY-MM-DD'` (the user's calendar date). `LocalTime` = `'HH:MM:SS'`. Both map to Postgres `DATE`/`TIME`. **Calendar maths never uses JS `Date`** (TD-01 §3 gives the utility API). Timezone conversion happens in exactly one function: `todayIn(tz, nowInstant)`.
- Server is UTC. "Today" is authoritative on the server: `todayIn(user.timezone, clock.now())`. `Clock` is injected (`{ now(): Instant }`) so tests can pin it.

### 4.3 Identifiers & scoping
- All ids UUIDv7. Every table has `user_id`; every repo function takes `userId` as its first argument and includes it in the `WHERE` (and, with RLS enabled, in `SET LOCAL app.user_id`).
- Not-found and not-yours are indistinguishable: both return `NOT_FOUND`.

### 4.4 Strings
- All user-visible text comes from `messages/en.ts` as functions/keys (`msg.err.insufficientFunds({ envelope, available })`). No literals in components. Money inside messages is pre-formatted by `formatMoney`.
- Logical CSS properties only (`ms-`, `me-`, `ps-`, `pe-`, `text-start`).

## 5. Error model

```ts
// domain/errors.ts
export type ErrorCode =
  | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INSUFFICIENT_FUNDS' | 'TIMELINE_VIOLATION'
  | 'RULE_VIOLATION'      // business rule (e.g. lending others' money, archive with active loan)
  | 'DUPLICATE_SUSPECTED' // soft, user may confirm and retry with confirmDuplicate: true
  | 'RATE_LIMITED' | 'UNAUTHENTICATED' | 'FORBIDDEN_FEATURE' | 'INTERNAL';

export abstract class DomainError extends Error { abstract code: ErrorCode; details?: Record<string, unknown>; }
export class ValidationError extends DomainError { code='VALIDATION'; constructor(public fieldErrors: Record<string,string>) {…} }
export class InsufficientFunds extends DomainError { code='INSUFFICIENT_FUNDS'; constructor(public envelopeId: string, public available: Paisa, public required: Paisa) {…} }
export class TimelineViolation extends DomainError { code='TIMELINE_VIOLATION'; constructor(public v: Violation, public op: OpContext) {…} }
export class RuleViolation extends DomainError { code='RULE_VIOLATION'; constructor(public rule: RuleId, public ctx: Record<string,unknown>) {…} }
export class NotFound / Conflict / RateLimited …
```

`ActionResult` — **the only shape returned to clients** (actions never throw to the client except for unexpected bugs, which Next turns into the error boundary):

```ts
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; fieldErrors?: Record<string,string>;
                          details?: Record<string, unknown>;   // machine-readable (envelopeId, shortfall as string, firstViolationDate…)
                          actions?: SuggestedAction[];          // e.g. [{kind:'borrow', …},{kind:'add_money', …}]
                          ref?: string } };                      // INTERNAL only: support reference id
```
`message` is rendered server-side from `messages/en.ts` (plain language, says what to do next). `details` carries strings for money (`shortfallPaisa: "300000"`).

`SuggestedAction` powers FR-TXN-04 / FR-LOAN-06 / FR-REC-06 ("Add money", "Borrow from another envelope") without the UI parsing messages.

## 6. The single write pipeline — `defineAction`

Every mutation is declared through one wrapper so locking, idempotency, audit, revalidation and error mapping are impossible to forget:

```ts
export const createExpense = defineAction({
  name: 'transactions.createExpense',
  input: CreateExpenseInput,            // Zod; includes idempotencyKey: z.string().uuid()
  idempotent: true,
  async run(ctx: WriteCtx, input) {     // ctx.tx is THE db transaction; ctx.userId from session only
    …
  },
  revalidate: (res) => [tags.dashboard, tags.envelope(res.envelopeId), tags.transactions, tags.analytics],
});
```

`defineAction` executes, in order:

1. `requireUser()` (TD-02) → `userId`. **`userId` never comes from input**; any `userId`/`user_id` key in input is stripped by Zod (`.strict()` on every schema → 400 on unknown keys, which also kills mass-assignment).
2. Zod parse (trim strings, caps, `PaisaStr`). Failure → `VALIDATION` with `fieldErrors`.
3. Rate-limit hook for sensitive actions (auth only).
4. `withUserWrite(userId, fn)` (TD-01 §7): begin txn → `SELECT pg_advisory_xact_lock(hashtextextended($userId::text, 0))` → `SET LOCAL app.user_id = $userId` → **idempotency lookup** → `run()` → **timeline validation of touched accounts** (if `run` reported mutations via `ctx.touch(...)`) → `UPDATE users SET ledger_revision = ledger_revision + 1` (if any ledger-affecting write) → audit rows → store idempotency response → commit.
5. On `DomainError` → rollback, map to `ActionResult` error. On unknown error → rollback, log with a `ref`, return `INTERNAL` ("Something went wrong. Reference 7F3K9Q. Your data was not changed.").
6. After commit: `revalidateTag(...)` for each tag (tags are user-scoped: `u:{userId}:dashboard`).

`WriteCtx` exposes: `tx`, `userId`, `clock`, `touch(accountIds)`, `audit(entity, id, action, before, after)`, `bumpsLedger()`. Reads inside actions use the same `tx`.

Read-only model functions use `withUserRead(userId, fn)` (a read-only txn with `SET LOCAL app.user_id`) so RLS (TD-02 §9) applies uniformly.

## 7. Background jobs

Vercel cron is **UTC-only and issues `GET` with `Authorization: Bearer $CRON_SECRET`** (TD v1.0 incorrectly used `POST` and a local-time schedule). Hobby plans allow few jobs, once daily → **one dispatcher route** runs every task idempotently:

```json
// vercel.json
{ "crons": [{ "path": "/api/cron/daily", "schedule": "5 19 * * *" }] }   // 19:05 UTC = 00:05 Asia/Karachi
```

`GET /api/cron/daily` (verifies bearer with constant-time compare; 401 otherwise) runs, each in its own try/catch and reporting `{task, ok, ms, count}`:

| Task | Spec |
|---|---|
| `recurring.generate` | TD-07 §6 for all users with due rules |
| `deleted.purge` | hard-delete soft-deleted transactions with `deleted_at < now() − 30d` (TD-05 §7) |
| `idempotency.cleanup` | delete expired keys |
| `auth.cleanup` | delete expired sessions, old `login_attempts`, used/expired reset tokens |
| `integrity.check` | TD-01 §10 for every user; writes `integrity_runs` row; never fixes |

The same task functions are exported so tests and a `pnpm job:run <task>` CLI can invoke them. Lazy recurring generation on app open (TD-07 §6.3) means a missed cron never loses data.

## 8. Logging & observability (URD §19)

- `pino` JSON logs. A `redact` list removes `amount*`, `note`, `name`, `owner_name`, `email`, `password*`, `token*`, `authorization`, `cookie`. Logs may contain ids, action names, durations, error codes.
- Request id per action (`ref`) included in logs and returned on `INTERNAL`.
- `GET /api/health` → `{status:'ok', db:'ok'|'down', version, time}`; runs `SELECT 1` with 1 s timeout; never reveals config.
- Optional Sentry (`SENTRY_DSN`): `beforeSend` scrubs request bodies, breadcrumbs, and applies the same redaction.

## 9. Environment variables

`.env.example` (all documented, no real values). Validated at boot by a Zod `env.ts` (app refuses to start on invalid config).

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | **Pooled** URL for runtime |
| `DATABASE_URL_UNPOOLED` | migrations | Direct URL for `drizzle-kit migrate` and advisory-lock-heavy jobs |
| `AUTH_SECRET`, `AUTH_URL` | yes | `AUTH_SECRET` ≥ 32 bytes |
| `ALLOW_REGISTRATION` | no | default `true` in dev, `false` in production (FR-AUTH-05) |
| `SEED_ADMIN_EMAIL/PASSWORD/NAME`, `ALLOW_SEED` | seed | FR-AUTH-06 |
| `CRON_SECRET` | prod | ≥ 32 chars |
| `SMTP_*` | optional | enables password-reset email |
| `SENTRY_DSN` | optional | |
| `APP_VERSION`/`NEXT_PUBLIC_APP_VERSION` | build | injected from git sha |

## 10. Migrations

- Versioned SQL in `src/server/db/migrations/NNNN_name.sql`; generated for tables by drizzle-kit, **hand-written** for views, triggers, partial/expression indexes, RLS. Never edit an applied migration; fix forward.
- CI applies all migrations to an empty Postgres, then runs `drizzle-kit check` and a schema-drift test (introspected schema equals Drizzle schema for columns/types).
- Down-migrations: provided for table-only changes; views/triggers are `CREATE OR REPLACE`/`DROP IF EXISTS` so they are re-runnable.
- Production migrations run in the deploy pipeline *before* promoting the new build; migrations must be backward compatible with the previous build for one release (expand → migrate → contract).

## 11. `DECISIONS.md`

Created in Phase 1 with the URD decisions D1–D12 and the TD decisions below. Format per entry: `ID · date · decision · reason · alternative · affects (requirement ids)`. Any "unspecified → simplest invariant-preserving choice" taken by an implementer is appended here (URD §0.7).

### Technical decisions introduced by this design set (TD-D*)

| ID | Decision | Reason |
|---|---|---|
| TD-D1 | Postings convention: `envelope_id` = **source/“from”**, `counterpart_envelope_id` = **destination/“to”** for `transfer`, `loan`, `loan_repayment`. Single-envelope types use `envelope_id` only | URD left orientation undefined; consistent orientation removes sign bugs (GAP G-04) |
| TD-D2 | `loans.remaining/status` and `loan_repayments` are **not stored**; derived from `loan_repayment` transactions via `loan_state` view | INV-4, no desync (FR-LOAN-33); URD allows cache but a cache buys nothing at this scale |
| TD-D3 | Idempotency lives only in `idempotency_keys` (not a `transactions.idempotency_key` column) | One mechanism covers multi-row actions |
| TD-D4 | `opening_balance` may be `0` (only type besides `adjustment` with relaxed amount rule) | URD §7 allows a 0 opening balance but §4.1 demands amount > 0 |
| TD-D5 | `ledger_revision` counter on `users` + per-check `ledger_hash` | Needed for reconciliation status & FR-REC-10 (TD-08) |
| TD-D6 | Generated recurring income is posted at `00:01`, expenses at `12:00` on the due date | Same-day income funds same-day expense under canonical ordering |
| TD-D7 | Soft-deleted transactions still block hard-deletion of their envelope/category until purged at 30 d | Keeps FKs and restore valid |
| TD-D8 | Cron = single daily dispatcher | Vercel Hobby limits; idempotent tasks |
| TD-D9 | Import preserves IDs unless they collide with another user's rows, then deterministic UUIDv5 remap | Satisfies “IDs preserved” and “remapped to avoid collisions” |
| TD-D10 | Calculator input supports `+` only (also `-` between operands is **not** allowed) | Matches URD §11.3 and avoids sign confusion |

## 12. Acceptance (foundation)

- `pnpm lint` fails on: `parseFloat` use, `domain/**` importing `next`/`react`/`pg`, floating arithmetic on `Paisa`.
- A `defineAction` with an input containing `user_id` rejects with `VALIDATION`.
- Booting with missing/invalid env fails fast with a readable message.
- `GET /api/cron/daily` without bearer → 401; with bearer → runs all tasks idempotently (second run is a no-op).
