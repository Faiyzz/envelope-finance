# TD-02 — Authentication, Accounts & Security

**URD coverage:** §6 (FR-AUTH-01…08, FR-SEC-01…06), IDOR/auth tests 44–47, part of FR-PWA-03 (cache clearing on logout).
**Depends on:** TD-00, TD-01 (`users`). **Used by:** every action (`requireUser`), TD-03 (settings screens), TD-12 (logout cache purge).

---

## 1. Design summary

- Auth.js v5, **Credentials provider with JWT sessions**. (Auth.js does not support database sessions with the Credentials provider; TD v1.0's "database or JWT" was not implementable.)
- Revocation, "log out of all devices" and the active-sessions list need server state, so the JWT carries only `{ uid, sid }` and **`sid` is checked against a `sessions` table on every authenticated server request**.
- Password hashing: **argon2id** via `@node-rs/argon2` (prebuilt binaries, works in the Node.js runtime on Vercel). Params: memory 19 MiB, iterations 2, parallelism 1 (OWASP minimum). Hashing/verification only in Node runtime handlers — **never in `middleware.ts` (Edge)**.
- `middleware.ts` (Edge) does only: cookie-presence redirect, CSP nonce + security headers, `ALLOW_REGISTRATION` 404 gate. It never reads the DB.

## 2. Schema (migration `0004_auth.sql`)

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY,                                  -- the JWT 'sid'
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,                                      -- ≤ 300 chars, parsed for display ("Chrome on Android")
  ip_hash TEXT                                          -- sha256(ip + AUTH_SECRET); never raw IP
);
CREATE INDEX ix_sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_attempts (                           -- rate limiting that works on serverless (no in-memory state)
  id BIGSERIAL PRIMARY KEY,
  email CITEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  succeeded BOOLEAN NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_login_attempts_email ON login_attempts (email, at DESC);
CREATE INDEX ix_login_attempts_ip ON login_attempts (ip_hash, at DESC);

CREATE TABLE password_reset_tokens (                    -- only used when SMTP is configured
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,                      -- sha256 of the emailed token
  expires_at TIMESTAMPTZ NOT NULL,                      -- 30 min
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
No row in these tables is returned by user-facing APIs except the user's own `sessions` (id, device label, created, last seen, "this device" flag).

## 3. Flows

### 3.1 Registration (FR-AUTH-01, 05)
`register({ name, email, password })` Server Action.
1. If `ALLOW_REGISTRATION !== 'true'` → `notFound()`; the `/register` route is also gated in middleware (returns 404, no hint).
2. Zod: `name` 1–60 trimmed; `email` RFC-valid, lowercased, ≤ 254; `password` 10–128 chars, not in the bundled top-10k common-password list (case-insensitive exact match), not equal to email local-part. **No composition rules.**
3. Transaction: insert user (id UUIDv7, `argon2id` hash) → **seed categories** (TD-05 §9) → no envelopes yet (onboarding does that). Duplicate email → same neutral error path: *"We couldn't create that account. If you already have one, try signing in."* (no enumeration; email verification is out of V1 — D7 makes registration closed in production anyway).
4. Creates a session (§3.2) and redirects to `/onboarding`.

### 3.2 Login (FR-AUTH-04)
`authorize(credentials)` inside Auth.js Credentials:
1. Normalise email (lowercase, trim). Zod parse (shape only).
2. **Throttle check** (§5) → if blocked: return the generic error and `Retry-After`; do not reveal which limiter tripped.
3. Load user by email. If none: **verify against a constant dummy argon2 hash** (timing equalisation), record failed attempt, generic error `"Email or password is incorrect"`.
4. If `locked_until > now()`: generic error (still verify dummy hash first for timing). Else `verify(hash, password)`.
5. Success: reset `failed_login_count`, clear `locked_until`, record success, **insert `sessions` row** (`expires_at = now()+30d`), return `{ id: uid, sid }` → Auth.js `jwt` callback stores `{ uid, sid }`; `session` callback exposes only `user.id`.
6. If the stored hash needs rehash (params changed) → rehash and update.

### 3.3 Session validation — `requireUser()`
```ts
export async function requireUser(): Promise<{ userId: string; sid: string; user: UserCtx }> {
  const jwt = await auth();                                  // cookie → {uid, sid}
  if (!jwt) throw new Unauthenticated();
  const s = await db.sessions.findActive(jwt.sid, jwt.uid);  // revoked_at IS NULL AND expires_at > now()
  if (!s) throw new Unauthenticated();                       // revoked on another device → forced logout
  if (s.lastSeenAt < now() - 5min) await db.sessions.touch(s.id, /* rolling */ extendTo = now()+30d);
  return …;
}
```
`UserCtx` = `{ timezone, theme, numberGrouping, weekStart, onboardingCompletedAt }` loaded in the same query (one indexed lookup per request). `Unauthenticated` redirects to `/login?next=…` in RSC and returns `UNAUTHENTICATED` from actions. Cookie: `httpOnly; Secure; SameSite=Lax; Path=/`, name `__Secure-` prefixed in prod; JWT `maxAge` 30 d (rolling via `updateAge` 1 d).

### 3.4 Logout / logout-all / revoke
- `logout()`: set `revoked_at` on current `sid`; clear cookie; respond with header `Clear-Site-Data: "cache", "storage"` and the client calls the SW cleanup hook (TD-12 §7). (Test 47)
- `logoutAllDevices()`: `UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL`.
- `revokeSession(sessionId)`: scoped by `user_id`; revoking the current one behaves as `logout()`.
- `listSessions()`: own sessions, newest first, `{id, device, createdAt, lastSeenAt, current}`.

### 3.5 Password change / email change (FR-AUTH-07, §16)
- `changePassword({ current, next })`: verify current (throttled like login); validate `next` by §3.1 rules; update hash + `password_changed_at`; **revoke all sessions except current**.
- `changeEmail({ password, newEmail })`: verify password; uniqueness (neutral error on clash); update; if SMTP configured send a notice to the old address. (No verification mail in V1.)
- **Password reset** (SHOULD): only if `SMTP_HOST` is set. `requestReset(email)` always returns the same message; if the user exists, create token (32 random bytes, base64url, store sha256, 30 min) and email a link. `resetPassword(token, next)` validates, updates, revokes **all** sessions, marks token used. If SMTP is unset, the "Forgot password?" link is not rendered and `pnpm user:reset-password <email>` (CLI, prompts for password, refuses to run unless `DATABASE_URL` set) is documented in the runbook (TD-13).

### 3.6 Account deletion (FR-AUTH-08)
Settings → Account → Delete account: (1) offer JSON export (TD-11), (2) require password and the typed word `DELETE`, (3) `deleteAccount` re-verifies password, runs `DELETE FROM users WHERE id=$1` in a write txn (all data cascades: every table has `ON DELETE CASCADE` from `users`; `transactions.deleted_by` FK to users is satisfied because rows cascade in the same statement — verified by a test), clears cookie + `Clear-Site-Data`. Audit entry is *not* kept (cascade).

### 3.7 Seeding (FR-AUTH-06)
`pnpm db:seed` (`scripts/seed.ts`):
- Reads `SEED_ADMIN_EMAIL/PASSWORD/NAME`; fails with a clear message if missing.
- Refuses when `NODE_ENV=production` unless `ALLOW_SEED=true`.
- **Idempotent**: if a user with that email exists → logs "already exists" and exits 0 without changes (does not reset the password).
- Creates user + default categories exactly like registration. Never prints the password.

## 4. Password policy details
Min 10 / max 128 (max prevents hash-DoS). Common-password list shipped as a bundled sorted text file and checked by binary search (no network). Unicode NFKC-normalise before hashing so the same password typed on different keyboards verifies.

## 5. Rate limiting & lockout (FR-AUTH-04)

Computed from `login_attempts` (stateless):
- **Per (email, ip_hash):** ≥ 5 failures in the last 15 min → blocked until the oldest of those 5 is > 15 min old.
- **Per email (any IP):** ≥ 20 failures in 1 h → blocked 1 h (stops distributed guessing).
- **Per IP:** ≥ 50 failures in 15 min → blocked.
- **Progressive account lock:** on each *consecutive* block trigger, `failed_login_count++` and `locked_until = now() + [1, 5, 15, 60][min(n,3)] min`. Reset on success.
- Responses are identical to a wrong password (generic message). A blocked request still costs a dummy hash verify. Owner lock-out risk (someone spamming the owner's email) is accepted for a personal app; the CLI reset (§3.5) also clears `locked_until`.
- The same limiter wraps `changePassword`, `deleteAccount`, `changeEmail`.

## 6. Authorization (FR-SEC-01) — three layers

1. **Repos:** every function `(userId, …)`; every SQL has `user_id = $userId`. No repo method accepts only an entity id.
2. **Composite FKs** (TD-01 §4): a child row physically cannot reference another user's parent.
3. **RLS** (defence in depth, §9): even a forgotten `WHERE user_id` returns nothing.

Not-found vs not-yours both → `NOT_FOUND` (404 in routes; `NOT_FOUND` result in actions). Never `403` for resource ownership.

## 7. Input & output security (FR-SEC-02…05)

- **Zod everywhere**, `.strict()`, trimmed strings, caps: name ≤ 60, note ≤ 500, description ≤ 300, category ≤ 40, owner name ≤ 60. Control characters (`\p{Cc}` except `\n`,`\t` in notes) stripped by a shared `cleanText()` transform.
- **XSS:** no `dangerouslySetInnerHTML` anywhere (ESLint rule `react/no-danger` = error). User text is only rendered as React text nodes; user text is never placed in `href`/`style`/attribute context except `aria-label` text. Emoji icon field validated as a **single grapheme** emoji via `Intl.Segmenter` + `\p{Extended_Pictographic}`.
- **CSV injection:** TD-11 §6.
- **CSRF:** Server Actions use Next's built-in Origin/Host check; ensure `serverActions.allowedOrigins` lists only the production host. Route Handlers that mutate (`POST/PUT/DELETE`) call `assertSameOrigin(req)` (Origin header must equal `new URL(AUTH_URL).origin`; missing Origin on a non-GET → reject). Cookies are `SameSite=Lax`. The cron endpoint is bearer-authenticated (no cookie auth, constant-time compare).
- **Security headers** (middleware, all responses): 
  - `Content-Security-Policy`: `default-src 'self'; script-src 'self' 'nonce-{n}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://*.ingest.sentry.io (only if Sentry on); worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; upgrade-insecure-requests` (nonce propagated via `x-nonce` request header to RSC; `unsafe-inline` for styles is required by Tailwind/Framer inline styles — documented trade-off). Self-hosted fonts only (no Google Fonts → no third-party requests; also satisfies "no third-party trackers").
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`, `Cross-Origin-Opener-Policy: same-origin`.
  - Authenticated HTML/JSON: `Cache-Control: private, no-store` (prevents shared-device/CDN leaks; the SW applies its own rules, TD-12).
- **Secrets:** env only (TD-00 §9); `.env*` in `.gitignore`; CI secret scan (gitleaks).
- **Logging:** never log passwords/tokens/Authorization; redaction list in TD-00 §8.

## 8. App lock
Out of V1 (FR-SEC-06). Settings shows a disabled "App lock — coming later" row. Schema leaves room (`webauthn_credentials` table is **not** created now).

## 9. Row-Level Security (SHOULD → we implement)

Migration `0005_rls.sql`, for every user-owned table `T`:
```sql
ALTER TABLE T ENABLE ROW LEVEL SECURITY;
ALTER TABLE T FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON T
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);
```
- The app connects as role `app_rw` (no `BYPASSRLS`, not the table owner). Migrations/seed/cron-wide jobs use `app_admin` (owner) via `DATABASE_URL_UNPOOLED`; cron tasks that iterate users still run per-user inside `withUserWrite`/`withUserRead` so they exercise the same policies.
- `users` itself: policy `id = current_setting('app.user_id', true)::uuid`; the **auth lookup by email** (pre-session) uses a `SECURITY DEFINER` function `auth_find_user(email)` returning only `(id, password_hash, locked_until, failed_login_count)`.
- `set_config('app.user_id', …, true)` is transaction-local (pooler-safe). Reads outside a txn must go through `withUserRead`.
- Test: with `app.user_id` unset, `SELECT count(*) FROM transactions` returns 0; with user A set, user B's rows are invisible even via raw SQL.

## 10. IDOR test harness (URD test 44)

- Every `defineAction` and every route handler registers in a central **registry** with metadata `{ name, idParams: [{ path, entity }] }`.
- A generated test creates users A and B with full fixtures (envelopes, tx, loans, rules, reconciliations, categories), then for **every registry entry** invokes it as B with A's ids and asserts `NOT_FOUND` (or a validation error that does not confirm existence) **and** that A's data is byte-identical afterwards (snapshot hash). A completeness test fails if an action exists that is not in the registry.
- Mass-assignment tests: send `userId`, `user_id`, `id`, `deletedAt`, `version` (where not allowed) in bodies → rejected by `.strict()`.
- RLS test (§9) runs the same matrix with the app-layer `WHERE user_id` temporarily omitted in a test-only repo to prove the DB layer holds.

## 11. Screens
`/login`, `/register` (404 when disabled), `/forgot-password` (only with SMTP), `/reset-password/[token]`, Settings → Account (name, email, password, sessions list, logout all, delete). All forms: labelled inputs, `autocomplete` attributes (`username`, `current-password`, `new-password`), show/hide password toggle (44 px target), inline field errors, generic top-level error for credential failure, disabled submit while pending, `aria-live="polite"` error region.

## 12. Tests owned
URD 44–47 (IDOR matrix; throttling; generic errors; registration flag 404; seed idempotent + production guard; XSS inertness; session revocation; logout clears caches); timing-equalisation test (unknown-email and wrong-password latency within a tolerance); password-policy table tests (9 chars, 129 chars, common password, NFKC equivalence); account deletion cascades completely (row counts zero in every table).

## 13. Acceptance
A seeded user can log in; wrong credentials and unknown email are indistinguishable (message and timing class); 6th failure inside 15 min is blocked; revoking a session on device 2 makes device 1's next request redirect to `/login`; B can never read/write A's rows through any registered action, route, or raw SQL under `app_rw`.
