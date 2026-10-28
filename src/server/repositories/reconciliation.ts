/**
 * Reconciliation read models - TD-08 §8
 */

import { getPool } from '@/server/db/client';

export interface ReconRow {
  id: string;
  checkedAt: string;
  checkedOn: string;
  expected: bigint;
  actual: bigint;
  difference: bigint;
  statusIcon: 'check' | 'warning';
  note: string | null;
  adjustment: string | null;
  changedSince: boolean;
}

/**
 * Get reconciliation history with cursor pagination
 */
export async function getReconciliationHistory(
  userId: string,
  options: {
    cursor?: string;
    limit?: number;
  } = {}
): Promise<{ items: ReconRow[]; nextCursor?: string }> {
  const pool = getPool();
  const limit = Math.min(options.limit || 20, 50);

  let cursorClause = '';
  const params: any[] = [userId];
  let paramIndex = 2;

  if (options.cursor) {
    try {
      const cursorDate = new Date(options.cursor);
      cursorClause = `AND checked_at < $${paramIndex++}`;
      params.push(cursorDate);
    } catch {
      throw new Error('Invalid cursor');
    }
  }

  const query = `
    SELECT id, checked_at, checked_on, expected_paisa, actual_paisa, difference_paisa,
           note, adjustment_transaction_id, ledger_hash
    FROM reconciliations
    WHERE user_id = $1 AND deleted_at IS NULL ${cursorClause}
    ORDER BY checked_at DESC
    LIMIT $${paramIndex++}
  `;
  params.push(limit + 1);

  const result = await pool.query(query, params);
  const items = result.rows.slice(0, limit);

  // Compute changedSince for each row
  const itemsWithStatus: ReconRow[] = [];

  for (const row of items) {
    // Recompute ledger_hash for the window
    const hashResult = await pool.query(
      `SELECT md5(COALESCE(string_agg(t.id::text || ':' || t.version, ',' ORDER BY t.occurred_on, t.occurred_at, t.created_at, t.id), '')) as hash
       FROM transactions t
       WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.occurred_on <= $2`,
      [userId, row.checked_on]
    );

    const currentHash = hashResult.rows[0].hash;
    const changedSince = currentHash !== row.ledger_hash;

    itemsWithStatus.push({
      id: row.id,
      checkedAt: row.checked_at,
      checkedOn: row.checked_on,
      expected: BigInt(row.expected_paisa),
      actual: BigInt(row.actual_paisa),
      difference: BigInt(row.difference_paisa),
      statusIcon: row.difference_paisa === '0' ? 'check' : 'warning',
      note: row.note,
      adjustment: row.adjustment_transaction_id,
      changedSince,
    });
  }

  // Compute next cursor
  let nextCursor: string | undefined;
  if (result.rows.length > limit) {
    const lastRow = result.rows[limit - 1];
    nextCursor = lastRow.checked_at;
  }

  return {
    items: itemsWithStatus,
    nextCursor,
  };
}

/**
 * Get latest reconciliation for a user
 */
export async function getLatestReconciliation(userId: string): Promise<ReconRow | null> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT id, checked_at, checked_on, expected_paisa, actual_paisa, difference_paisa,
           note, adjustment_transaction_id, ledger_hash
    FROM reconciliations
    WHERE user_id = $1 AND deleted_at IS NULL
    ORDER BY checked_at DESC
    LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  // Recompute ledger_hash
  const hashResult = await pool.query(
    `SELECT md5(COALESCE(string_agg(t.id::text || ':' || t.version, ',' ORDER BY t.occurred_on, t.occurred_at, t.created_at, t.id), '')) as hash
     FROM transactions t
     WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.occurred_on <= $2`,
    [userId, row.checked_on]
  );

  const currentHash = hashResult.rows[0].hash;
  const changedSince = currentHash !== row.ledger_hash;

  return {
    id: row.id,
    checkedAt: row.checked_at,
    checkedOn: row.checked_on,
    expected: BigInt(row.expected_paisa),
    actual: BigInt(row.actual_paisa),
    difference: BigInt(row.difference_paisa),
    statusIcon: row.difference_paisa === '0' ? 'check' : 'warning',
    note: row.note,
    adjustment: row.adjustment_transaction_id,
    changedSince,
  };
}
