/** Offline snapshot payload - TD-12 §5.1: last 100 transactions (dashboard comes from the page itself). */

import { getPool } from '@/server/db/client';
import { toRecent } from './dashboard';
import type { RecentTxDTO } from '@/domain/dashboard/types';

export async function getRecent100(userId: string): Promise<RecentTxDTO[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.amount_paisa, t.occurred_on, t.note,
            e.name AS env_name, e.owner_type, e.owner_name, c.name AS cat_name, ce.name AS cp_name
     FROM transactions t
     LEFT JOIN envelopes e ON e.id = t.envelope_id
     LEFT JOIN envelopes ce ON ce.id = t.counterpart_envelope_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.user_id = $1 AND t.deleted_at IS NULL
     ORDER BY t.occurred_on DESC, t.occurred_at DESC, t.created_at DESC, t.id DESC
     LIMIT 100`,
    [userId]
  );
  return rows.map(toRecent);
}
