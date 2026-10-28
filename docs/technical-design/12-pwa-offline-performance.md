# TD-12 — PWA, Offline (read-only) & Performance

**URD coverage:** §18 (FR-PWA-01…03, FR-PERF-01…03), §19 browser support, FR-SEC (cache hygiene on logout), tests 49–50, Lighthouse DoD (§24).
**Depends on:** TD-00 (headers), TD-02 (logout/cache clearing), TD-10 (UI shell). **Used by:** TD-13 (Lighthouse CI).

---

## 1. Goals & non-goals
- Installable PWA on iOS Safari and Android Chrome; works as a fast shell.
- **Offline V1 is read-only** (D11): show last known data with a clear banner; all writes disabled. No offline queue (Tier 3/future).
- Never leak one user's cached data to another on a shared device; never show stale data without a "last updated" time.

## 2. Manifest (`app/manifest.ts`)
```ts
{ name: 'Envelope Finance', short_name: 'Envelopes', start_url: '/', scope: '/', display: 'standalone',
  orientation: 'portrait', background_color: '#0b0f14' /* dark */, theme_color: '#4f46e5',
  icons: [ 192, 512 any + 192/512 maskable (safe-zone padded) , 180 apple-touch ],
  shortcuts: [ { name: 'Add expense', url: '/?add=expense' }, { name: 'Dashboard', url: '/' } ] }
```
Light/dark `theme-color` via two `<meta name="theme-color" media="(prefers-color-scheme: …)">`. iOS: `apple-touch-icon`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=default`, startup images optional (generated build step; skipped if absent). `viewport-fit=cover`.

## 3. Install UX (FR-PWA-01)
- **Android/desktop Chrome:** capture `beforeinstallprompt`; show an unobtrusive "Install app" row in Settings → About and a dismissible card after the 3rd session (stored in `localStorage`).
- **iOS Safari:** no prompt exists → detect iOS Safari non-standalone (`navigator.standalone !== true` + UA) and show a **one-time** help card: "Tap Share → Add to Home Screen" with an illustration; dismissal persisted; also available under Settings → About → "PWA install help".

## 4. Service worker (Serwist) (`src/app/sw.ts`)

Config: `@serwist/next`, `precacheEntries: self.__SW_MANIFEST`, `skipWaiting: false` (see §6), `clientsClaim: true`, `navigationPreload: true`, disabled in development.

| Route class | Strategy | Notes |
|---|---|---|
| Static build assets `/_next/static/*`, fonts, icons | **CacheFirst** (precached, revisioned) | |
| `/offline` page + its JS chunks | **Precached** | The offline viewer shell |
| Navigation requests (HTML/RSC) | **NetworkOnly**; on failure → `/offline` fallback | **Authenticated HTML is never stored** in Cache Storage |
| `POST` / Server Action requests | pass-through, never cached | when offline the UI blocks them (§5) |
| `/api/*` | NetworkOnly | export/import/cron/health |

**Offline data is not read from HTTP caches.** Instead, the app writes **snapshots to IndexedDB** itself (scoped by user id), which keeps control over what is stored and how it is cleared (§7).

## 5. Offline behaviour (FR-PWA-02)

### 5.1 Snapshots
After each successful dashboard/envelopes/activity render, a client effect (`useSnapshotWriter`) stores in IndexedDB database `ef:{userId}`:
```ts
{ dashboard: DashboardData (money as strings), envelopes: EnvelopeCard[], recent100: TxRow[], fetchedAt: ISO, appVersion }
```
Only the latest snapshot is kept (overwrite). Data volume is small (≤ ~200 KB). Writes are throttled (once per 10 s, only when changed).

### 5.2 Offline viewer (`/offline`)
A **client-rendered, precached** route reading the snapshot for the user id (from a non-sensitive `ef-last-user` marker in `localStorage`; the IDB DB itself is the data): Dashboard-lite (totals, tiles, envelope cards), Envelopes list, Recent 100 transactions (client-side filter by text/envelope only). Header always shows **"Offline — showing saved data · Last updated 14:05 today"** (persistent banner, `role="status"`). If no snapshot exists: "Connect to the internet to load your data."
Mobile nav items that need the network are disabled with tooltip/`aria-disabled` and an explanatory toast ("You're offline. Reconnect to add or change anything.").

### 5.3 Write guard
`useOnline()` = `navigator.onLine` + recent fetch failures (heartbeat `HEAD /api/health` every 15 s when the tab is visible and `onLine` is false→true flapping). `<WriteGuard>` wraps every submit button / FAB: when offline the control is `disabled` with an `aria-describedby` explanation (tooltip on desktop, helper text on mobile). Server actions called while offline would fail anyway (fetch error) — the guard prevents the attempt and, as a fallback, `ActionResult` network errors are mapped to "You appear to be offline. Nothing was saved." (never a silent success).

### 5.4 Freshness
Every number rendered from a snapshot carries the page-level timestamp; snapshots older than 7 days add a stronger warning "This data is 9 days old".

## 6. Updates (FR-PWA-03)
- `skipWaiting` is **false** so a new SW never takes over mid-form. On `waiting` event the app shows a toast/banner **"New version available — Reload"** (Serwist `useSerwist().addEventListener('waiting')`). On tap: `postMessage({type:'SKIP_WAITING'})` → `controlling` → `location.reload()`. Never auto-reload.
- If the user has an *unsaved* form (a global `dirtyForms` counter), the reload button first confirms "You have unsaved changes".
- Version skew guard: snapshot `appVersion` mismatch ⇒ snapshot schema migrated or dropped (never crash).

## 7. Logout / account switch hygiene (test 47/49)
On `logout` and `deleteAccount` the client runs `purgeLocalData()`:
1. Delete IndexedDB `ef:{userId}` (and any `ef:*`).
2. `caches.keys()` → delete all non-precache caches; message the SW `{type:'CLEAR_USER_CACHES'}`.
3. Clear `localStorage` keys: `ef-last-user`, recent searches, hide-balance cookie remains (non-sensitive), pending intents (`sessionStorage`).
4. Server also sends `Clear-Site-Data: "cache", "storage"` (TD-02 §3.4) as a backstop (supported browsers).
After logout the offline viewer shows nothing (no snapshot, no user marker). Login of a different user can never read another user's IDB because DB name includes the user id **and** the marker is cleared.
Test: log in A → load → log out → offline → `/offline` shows no data; log in B → offline → only B's snapshot.

## 8. Performance (FR-PERF-01…03)

Targets on mid-range Android over 4G: **LCP < 2.5 s, INP < 200 ms, CLS < 0.1**, dashboard data p95 < 300 ms server time.

### 8.1 Frontend
- RSC for layout and data; client components only for interactivity; `<Suspense>` streaming of dashboard sections; skeletons sized to prevent CLS.
- Route-level code-splitting; Recharts and the emoji picker loaded with `next/dynamic` on the pages that need them (analytics, create-envelope sheet); Framer Motion via `LazyMotion` + `domAnimation`.
- Fonts: self-hosted, `font-display: swap`, subset to Latin; preload the primary weight.
- Bundle budgets in CI (`size-limit`): initial JS for dashboard ≤ 170 kB gz; per-route ≤ 120 kB gz extra.
- Images: SVG/inline icons (lucide), no raster hero images; emoji are text.
- Prefetch on intent: `next/link` prefetch for bottom-nav destinations; hover/focus prefetch for envelope cards.
- Input responsiveness: money input and calculator are pure client; heavy work (search) debounced 250 ms and cancels in-flight requests.

### 8.2 Backend / DB
- Co-locate functions and DB region; use pooled connections; reuse `Pool` across invocations (module singleton), `max` small (≤ 5) per instance.
- Every list is keyset-paginated; all foreign keys and filter columns indexed (TD-01/05/09); partial indexes exclude soft-deleted rows.
- Dashboard: one read-only txn, six parallel queries on the same connection (or one multi-CTE); all aggregates from views over indexed predicates.
- `EXPLAIN (ANALYZE, BUFFERS)` regression tests for the five hottest queries (dashboard totals, envelope balances, transaction list, analytics category, timeline verifier) at 50k transactions: assert index usage (no seq scan on `transactions`) and runtime budget (CI soft-fail then hard-fail after baseline).
- Cache: analytics via `unstable_cache` + user tags (TD-09); **balances are never cached**; static assets immutable (`max-age=31536000, immutable`).
- Optimistic UI hides latency for writes (TD-10 §5.3); server actions return the minimal authoritative payload.

### 8.3 Measurement
Lighthouse CI on the dashboard, envelopes, transactions, analytics (mobile preset, throttled): **Performance, Accessibility, PWA ≥ 90** (DoD). Web Vitals reported to the structured log (no third-party). Synthetic 50k-row dataset generator (`pnpm seed:perf`) used for local/CI perf runs.

## 9. Browser support & compatibility notes
Last 2 versions of Safari iOS, Chrome Android, Chrome/Edge/Firefox/Safari desktop. Feature-detect (`navigator.vibrate`, `Intl.Segmenter`, `beforeinstallprompt`, `showSaveFilePicker` not used). iOS PWA quirks handled: no `beforeinstallprompt`, storage can be evicted after ~7 days of non-use → offline viewer must tolerate missing IDB (shows "Connect to load data"), cookies shared with standalone mode but `localStorage` is separate from Safari tab — the app never depends on cross-context storage.

## 10. Tests owned (URD 49–50)
49 (offline banner, writes disabled, no leak after logout, snapshot freshness label), 50 (dark/light, 320 px, 200 % zoom, SR labels — shared with TD-10), SW update flow (waiting → toast → reload; form-dirty confirmation), manifest validation (Lighthouse installability), IDB per-user isolation, bundle-size budgets, EXPLAIN assertions, LCP/INP lab thresholds in Lighthouse CI.

## 11. Acceptance
App installs on Android (prompt) and iOS (help card path); airplane-mode launch shows the offline viewer with last-updated time and no write controls; logging out wipes snapshots and caches; Lighthouse mobile ≥ 90 for Performance/Accessibility/PWA on the dashboard.
