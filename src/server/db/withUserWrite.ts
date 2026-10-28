/**
 * Per-user write lock - TD-01 §7.
 *
 * `runLocked` opens ONE transaction, takes the per-user transaction-scoped
 * advisory lock (released at COMMIT/ROLLBACK, safe under transaction pooling),
 * sets the RLS user, and runs `fn` on that client. All writers of a user are
 * serialised, so two concurrent writes cannot both pass validation and jointly
 * break an invariant (URD test 11).
 */

import { AsyncLocalStorage } from 'async_hooks';
import { getPool } from './client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tx = any;

interface Scope {
  userId: string;
  client: Tx;
}
const scope = new AsyncLocalStorage<Scope>();

/** The locked transaction client of the current action, if any. */
export const currentScope = () => scope.getStore();

export async function runLocked<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await scope.run({ userId, client }, () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Legacy entry point used by older actions that manage their own connections:
 * they receive the pool. When already inside a locked action for the same user
 * the lock is NOT taken again (a second connection would deadlock on it).
 */
export async function withUserWrite<T>(userId: string, fn: (pool: ReturnType<typeof getPool>) => Promise<T>): Promise<T> {
  const cur = scope.getStore();
  if (cur && cur.userId === userId) return fn(getPool());
  return runLocked(userId, () => fn(getPool()));
}
