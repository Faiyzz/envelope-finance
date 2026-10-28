/// <reference lib="webworker" />
/**
 * Service worker - TD-12 §4.
 *
 * - static build assets + icons: CacheFirst (immutable, revisioned)
 * - /offline shell: precached; used as the fallback when a navigation fails
 * - navigations, /api/*, Server Actions (POST): NetworkOnly. Authenticated HTML
 *   is NEVER stored; offline data lives in per-user IndexedDB snapshots instead.
 * - skipWaiting is off: the page decides when to take over (never mid-form).
 */

import { CacheFirst, ExpirationPlugin, NetworkOnly, Serwist, type PrecacheEntry, type SerwistGlobalConfig } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ url }) => url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/'),
      handler: new CacheFirst({
        cacheName: 'static-assets',
        plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 365 * 24 * 60 * 60 })],
      }),
    },
    { matcher: ({ request }) => request.mode === 'navigate', handler: new NetworkOnly() },
    { matcher: ({ url }) => url.pathname.startsWith('/api/'), handler: new NetworkOnly() },
  ],
  fallbacks: {
    entries: [{ url: '/offline', matcher: ({ request }) => request.destination === 'document' }],
  },
});

/** Delete every cache except the precache + immutable static assets (logout hygiene, TD-12 §7). */
async function clearUserCaches() {
  const keep = (name: string) => name.includes('precache') || name === 'static-assets';
  const names = await caches.keys();
  await Promise.all(names.filter((n) => !keep(n)).map((n) => caches.delete(n)));
}

self.addEventListener('message', (event) => {
  const type = (event.data as { type?: string } | undefined)?.type;
  if (type === 'SKIP_WAITING') void self.skipWaiting();
  if (type === 'CLEAR_USER_CACHES') event.waitUntil(clearUserCaches());
});

serwist.addEventListeners();
