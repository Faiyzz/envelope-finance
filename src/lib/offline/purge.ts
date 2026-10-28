/**
 * Logout / account-switch hygiene - TD-12 §7. Safe to call repeatedly and when
 * any storage API is missing.
 */

import { deleteAllUserDatabases, LAST_USER_KEY } from './idb';

const LOCAL_KEYS = [LAST_USER_KEY, 'ef-dbs', 'recent-searches', 'attn_recon_dismissed_until', 'pwa-install-dismissed', 'pwa-ios-help-seen', 'pwa-sessions'];

export async function purgeLocalData(): Promise<void> {
  // 1. IndexedDB snapshots
  await deleteAllUserDatabases();

  // 2. Cache Storage (non-precache) + tell the SW
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !n.includes('precache') && n !== 'static-assets').map((n) => caches.delete(n)));
    const reg = await navigator.serviceWorker?.getRegistration();
    (reg?.active ?? navigator.serviceWorker?.controller)?.postMessage({ type: 'CLEAR_USER_CACHES' });
  } catch {
    /* no caches / SW */
  }

  // 3. localStorage / sessionStorage keys (hide-balances cookie is non-sensitive and stays)
  try {
    for (const k of LOCAL_KEYS) localStorage.removeItem(k);
    sessionStorage.clear(); // pending intents etc.
  } catch {
    /* ignore */
  }
}
