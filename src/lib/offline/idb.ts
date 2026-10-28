/**
 * Minimal IndexedDB helper - TD-12 §5.1. One database per user: `ef:{userId}`,
 * one store, one record (the latest snapshot). Every call tolerates IDB being
 * unavailable or evicted (iOS can evict after ~7 days; private mode may throw).
 */

const STORE = 'kv';
const KEY = 'snapshot';
const DB_LIST = 'ef-dbs'; // localStorage list so we can delete DBs without indexedDB.databases()
export const LAST_USER_KEY = 'ef-last-user';

const dbName = (userId: string) => `ef:${userId}`;

function open(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no idb'));
    const req = indexedDB.open(dbName(userId), 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb error'));
  });
}

function remember(userId: string) {
  try {
    const list = new Set<string>(JSON.parse(localStorage.getItem(DB_LIST) ?? '[]'));
    list.add(dbName(userId));
    localStorage.setItem(DB_LIST, JSON.stringify([...list]));
    localStorage.setItem(LAST_USER_KEY, userId);
  } catch {
    /* storage unavailable */
  }
}

export async function putSnapshot<T>(userId: string, value: T): Promise<void> {
  const db = await open(userId);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  remember(userId);
}

export async function getSnapshot<T>(userId: string): Promise<T | null> {
  try {
    const db = await open(userId);
    const v = await new Promise<T | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return v;
  } catch {
    return null;
  }
}

export function lastUserId(): string | null {
  try {
    return localStorage.getItem(LAST_USER_KEY);
  } catch {
    return null;
  }
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Delete every `ef:*` database (known list + indexedDB.databases() when available). */
export async function deleteAllUserDatabases(): Promise<void> {
  const names = new Set<string>();
  try {
    for (const n of JSON.parse(localStorage.getItem(DB_LIST) ?? '[]') as string[]) names.add(n);
  } catch {
    /* ignore */
  }
  try {
    const dbs = await indexedDB.databases?.();
    for (const d of dbs ?? []) if (d.name?.startsWith('ef:')) names.add(d.name);
  } catch {
    /* not supported */
  }
  await Promise.all([...names].map(deleteDb));
}
