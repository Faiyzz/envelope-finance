/**
 * Envelope read models - TD-04 §6
 */

import { getPool } from '@/server/db/client';

export interface EnvelopeCard {
  id: string;
  name: string;
  icon: string;
  color: string | null;
  ownerType: 'mine' | 'other';
  ownerName: string | null;
  kind: 'standard' | 'savings';
  status: 'active' | 'archived';
  balance: bigint;
  txCount: number;
  borrowed: bigint;
  loanedOut: bigint;
  ownFunds: bigint;
  loanChips: Array<{ direction: 'borrowed' | 'loaned'; counterpartName: string; amount: bigint }>;
  goal?: { amount: bigint; progress: number };
  sortOrder: number;
}

export interface EnvelopeDetail extends EnvelopeCard {
  month: {
    spent: bigint;
    added: bigint;
    returned: bigint;
    loansIn: bigint;
    loansOut: bigint;
    repaid: bigint;
  };
}

/**
 * Get envelope list for a user
 */
export async function getEnvelopeList(
  userId: string,
  options: {
    includeArchived?: boolean;
    owner?: 'mine' | 'other';
  } = {}
): Promise<EnvelopeCard[]> {
  const pool = getPool();

  const whereConditions: string[] = ['e.user_id = $1'];
  const params: any[] = [userId];
  let paramIndex = 2;

  if (!options.includeArchived) {
    whereConditions.push(`e.status = 'active'`);
  }

  if (options.owner) {
    whereConditions.push(`e.owner_type = $${paramIndex++}`);
    params.push(options.owner);
  }

  const query = `
    SELECT 
      e.id, e.name, e.icon, e.color, e.owner_type, e.owner_name, e.kind, e.status, e.sort_order,
      e.goal_amount_paisa,
      eb.balance_paisa,
      es.tx_count,
      0 as borrowed_paisa,
      0 as loaned_out_paisa
    FROM envelopes e
    LEFT JOIN envelope_balances eb ON eb.user_id = e.user_id AND eb.envelope_id = e.id
    LEFT JOIN envelope_stats es ON es.user_id = e.user_id AND es.envelope_id = e.id
    WHERE ${whereConditions.join(' AND ')}
    ORDER BY 
      CASE WHEN e.owner_type = 'mine' THEN 0 ELSE 1 END,
      e.sort_order
  `;

  const result = await pool.query(query, params);

  return result.rows.map((row: any) => {
    const balance = BigInt(row.balance_paisa || '0');
    const borrowed = BigInt(row.borrowed_paisa || '0');
    const loanedOut = BigInt(row.loaned_out_paisa || '0');
    const ownFunds = balance - borrowed;

    let goal: EnvelopeCard['goal'];
    if (row.kind === 'savings' && row.goal_amount_paisa) {
      const goalAmount = BigInt(row.goal_amount_paisa);
      const progress = Math.min(1, Math.max(0, Number(balance) / Number(goalAmount)));
      goal = { amount: goalAmount, progress };
    }

    return {
      id: row.id,
      name: row.name,
      icon: row.icon,
      color: row.color,
      ownerType: row.owner_type,
      ownerName: row.owner_name,
      kind: row.kind,
      status: row.status,
      balance,
      txCount: parseInt(row.tx_count || '0'),
      borrowed,
      loanedOut,
      ownFunds,
      loanChips: [], // TODO: Add loan chips when TD-06 is implemented
      goal,
      sortOrder: row.sort_order,
    };
  });
}

/**
 * Get envelope detail with monthly stats
 */
export async function getEnvelopeDetail(
  userId: string,
  envelopeId: string,
  options: {
    month?: string; // LocalDate (first day of month)
  } = {}
): Promise<EnvelopeDetail> {
  const pool = getPool();

  // Get envelope
  const envResult = await pool.query(
    `SELECT 
      e.id, e.name, e.icon, e.color, e.owner_type, e.owner_name, e.kind, e.status, e.sort_order,
      e.goal_amount_paisa,
      eb.balance_paisa,
      es.tx_count
    FROM envelopes e
    LEFT JOIN envelope_balances eb ON eb.user_id = e.user_id AND eb.envelope_id = e.id
    LEFT JOIN envelope_stats es ON es.user_id = e.user_id AND es.envelope_id = e.id
    WHERE e.id = $1 AND e.user_id = $2`,
      [envelopeId, userId]
  );

  if (envResult.rows.length === 0) {
    throw new Error('Envelope not found');
  }

  const row = envResult.rows[0];
  const balance = BigInt(row.balance_paisa || '0');
  const borrowed = BigInt('0'); // TODO: Add loan state when TD-06 is implemented
  const loanedOut = BigInt('0'); // TODO: Add loan state when TD-06 is implemented
  const ownFunds = balance - borrowed;

  let goal: EnvelopeCard['goal'];
  if (row.kind === 'savings' && row.goal_amount_paisa) {
    const goalAmount = BigInt(row.goal_amount_paisa);
    const progress = Math.min(1, Math.max(0, Number(balance) / Number(goalAmount)));
    goal = { amount: goalAmount, progress };
  }

  // Get monthly stats
  let monthStats = {
    spent: 0n,
    added: 0n,
    returned: 0n,
    loansIn: 0n,
    loansOut: 0n,
    repaid: 0n,
  };

  if (options.month) {
    const monthStart = options.month;
    const monthEnd = new Date(new Date(monthStart).getFullYear(), new Date(monthStart).getMonth() + 1, 0)
      .toISOString()
      .split('T')[0];

    const statsResult = await pool.query(
      `SELECT tx_type, SUM(delta) as total
       FROM ledger_effects
       WHERE user_id = $1 AND envelope_id = $2 AND occurred_on BETWEEN $3 AND $4
       GROUP BY tx_type`,
      [userId, envelopeId, monthStart, monthEnd]
    );

    for (const statRow of statsResult.rows) {
      const delta = BigInt(statRow.total || '0');
      const type = statRow.tx_type;

      if (type === 'expense') monthStats.spent += delta;
      if (type === 'external_withdrawal') monthStats.returned += delta;
      if (type === 'allocation' || type === 'income' || type === 'external_deposit' || type === 'transfer') {
        monthStats.added += delta;
      }
      if (type === 'loan') monthStats.loansIn += delta;
      if (type === 'loan_repayment') monthStats.repaid += delta;
    }
  }

  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    ownerType: row.owner_type,
    ownerName: row.owner_name,
    kind: row.kind,
    status: row.status,
    balance,
    txCount: parseInt(row.tx_count || '0'),
    borrowed,
    loanedOut,
    ownFunds,
    loanChips: [], // TODO: Add loan chips when TD-06 is implemented
    goal,
    sortOrder: row.sort_order,
    month: monthStats,
  };
}
