/**
 * Quick-add loader - TD-10 §5.2, TD-05 §9.3
 *
 * Defaults come from the DB (last-used envelope/category), so they follow the
 * user across devices.
 */

import { getPool } from '@/server/db/client';
import { todayIn } from '@/domain/dates';

export interface QuickAddData {
  today: string;
  lastEnvelopeId: string | null;
  envelopes: Array<{ id: string; name: string; icon: string; balance: string; ownerType: 'mine' | 'other'; ownerName: string | null }>;
  categories: Array<{ id: string; name: string; groupName: 'home' | 'personal' | 'other' | null; isSystem: boolean }>;
  /** envelopeId -> category ids, most recent first (max 5, distinct). */
  recentByEnvelope: Record<string, string[]>;
  unallocated: string;
}

export async function getQuickAddData(userId: string, timezone: string): Promise<QuickAddData> {
  const pool = getPool() as unknown as { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> };

  const [envs, cats, recent, last, totals] = await Promise.all([
    pool.query(
      `SELECT e.id, e.name, e.icon, e.owner_type, e.owner_name, COALESCE(eb.balance_paisa, 0) AS balance
       FROM envelopes e LEFT JOIN envelope_balances eb ON eb.user_id = e.user_id AND eb.envelope_id = e.id
       WHERE e.user_id = $1 AND e.status = 'active'
       ORDER BY CASE WHEN e.owner_type = 'mine' THEN 0 ELSE 1 END, e.sort_order`,
      [userId]
    ),
    pool.query(
      `SELECT id, name, group_name, is_system FROM categories
       WHERE user_id = $1 AND kind = 'expense' AND status = 'active'`,
      [userId]
    ),
    pool.query(
      `SELECT envelope_id, category_id FROM (
         SELECT envelope_id, category_id, created_at,
                row_number() OVER (PARTITION BY envelope_id, category_id ORDER BY created_at DESC) AS rn
         FROM transactions
         WHERE user_id = $1 AND type = 'expense' AND deleted_at IS NULL AND category_id IS NOT NULL
       ) x WHERE rn = 1
       ORDER BY created_at DESC LIMIT 200`,
      [userId]
    ),
    pool.query(
      `SELECT envelope_id FROM transactions
       WHERE user_id = $1 AND type = 'expense' AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    ),
    pool.query(`SELECT total_paisa, envelopes_paisa FROM ledger_totals WHERE user_id = $1`, [userId]),
  ]);

  const recentByEnvelope: Record<string, string[]> = {};
  for (const r of recent.rows) {
    const list = (recentByEnvelope[r.envelope_id] ??= []);
    if (list.length < 5) list.push(r.category_id);
  }

  const t = totals.rows[0];
  return {
    today: todayIn(timezone, Date.now()),
    lastEnvelopeId: last.rows[0]?.envelope_id ?? null,
    envelopes: envs.rows.map((e) => ({
      id: e.id,
      name: e.name,
      icon: e.icon,
      balance: String(e.balance),
      ownerType: e.owner_type,
      ownerName: e.owner_name,
    })),
    categories: cats.rows.map((c) => ({ id: c.id, name: c.name, groupName: c.group_name, isSystem: c.is_system })),
    recentByEnvelope,
    unallocated: (BigInt(t?.total_paisa ?? 0) - BigInt(t?.envelopes_paisa ?? 0)).toString(),
  };
}
