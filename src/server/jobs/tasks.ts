/**
 * Cron / CLI task implementations - TD-00 §7. Every task is idempotent; the
 * daily dispatcher (api/cron/daily) and `pnpm job:run <task>` share these.
 */

import { v7 as uuidv7 } from 'uuid';
import { getPool } from '@/server/db/client';
import { runIntegrityCheck } from '@/server/db/integrity';

export interface TaskResult {
  count: number;
}

const q = async (sql: string, params?: unknown[]) => getPool().query(sql, params);

export const tasks: Record<string, () => Promise<TaskResult>> = {
  /**
   * Recurring generation needs the per-user write pipeline (TD-07 §5). Until that action is
   * callable without a session it runs lazily when the app is opened (RecurringSync), so a
   * missed cron never loses data; the dispatcher reports 0 here by design.
   */
  'recurring.generate': async () => ({ count: 0 }),

  'deleted.purge': async () => ({ count: Number((await q('SELECT job_purge_deleted() AS n')).rows[0]?.n ?? 0) }),
  'idempotency.cleanup': async () => ({ count: Number((await q('SELECT job_cleanup_idempotency() AS n')).rows[0]?.n ?? 0) }),
  'auth.cleanup': async () => ({ count: Number((await q('SELECT job_cleanup_auth() AS n')).rows[0]?.n ?? 0) }),

  'integrity.check': async () => {
    const users = (await q('SELECT job_list_user_ids() AS id')).rows.map((r) => String(r.id));
    let failing = 0;
    for (const userId of users) {
      const report = await runIntegrityCheck(userId);
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        await client.query('INSERT INTO integrity_runs (id, user_id, ok, findings) VALUES ($1,$2,$3,$4)', [uuidv7(), userId, report.ok, JSON.stringify(report.findings)]);
        await client.query("DELETE FROM integrity_runs WHERE user_id = $1 AND at < now() - interval '90 days'", [userId]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
      if (!report.ok) failing++;
    }
    return { count: failing };
  },
};

export type TaskName = keyof typeof tasks;
