/**
 * Loan read models - TD-06 §6
 */

import { getPool } from '@/server/db/client';

export interface LoanRow {
  id: string;
  lender: { id: string; name: string; icon: string };
  borrower: { id: string; name: string; icon: string };
  original: bigint;
  repaid: bigint;
  remaining: bigint;
  status: 'active' | 'paid';
  loanDate: string;
  paidOn: string | null;
  note: string | null;
}

export interface RepaymentRow {
  id: string;
  amountPaisa: bigint;
  occurredOn: string;
  occurredAt: string;
}

/**
 * List loans for a user
 */
export async function listLoans(
  userId: string,
  options: {
    status?: 'active' | 'paid';
    envelopeId?: string;
  } = {}
): Promise<LoanRow[]> {
  const pool = getPool();

  const whereConditions: string[] = ['ls.user_id = $1'];
  const params: any[] = [userId];
  let paramIndex = 2;

  if (options.status) {
    whereConditions.push(`ls.status = $${paramIndex++}`);
    params.push(options.status);
  }

  if (options.envelopeId) {
    whereConditions.push(`(ls.lender_envelope_id = $${paramIndex++} OR ls.borrower_envelope_id = $${paramIndex++})`);
    params.push(options.envelopeId, options.envelopeId);
  }

  const query = `
    SELECT 
      ls.loan_id as id,
      le.id as lender_id, le.name as lender_name, le.icon as lender_icon,
      be.id as borrower_id, be.name as borrower_name, be.icon as borrower_icon,
      ls.original_paisa, ls.repaid_paisa, ls.remaining_paisa,
      ls.status, ls.loan_date, ls.paid_on, ls.note
    FROM loan_state ls
    JOIN envelopes le ON le.id = ls.lender_envelope_id
    JOIN envelopes be ON be.id = ls.borrower_envelope_id
    WHERE ${whereConditions.join(' AND ')}
    ORDER BY ls.loan_date DESC, ls.created_at DESC
  `;

  const result = await pool.query(query, params);

  return result.rows.map((row: any) => ({
    id: row.id,
    lender: {
      id: row.lender_id,
      name: row.lender_name,
      icon: row.lender_icon,
    },
    borrower: {
      id: row.borrower_id,
      name: row.borrower_name,
      icon: row.borrower_icon,
    },
    original: BigInt(row.original_paisa),
    repaid: BigInt(row.repaid_paisa),
    remaining: BigInt(row.remaining_paisa),
    status: row.status,
    loanDate: row.loan_date,
    paidOn: row.paid_on,
    note: row.note,
  }));
}

/**
 * Get loan detail with repayments
 */
export async function getLoan(userId: string, loanId: string): Promise<{
  loan: LoanRow;
  repayments: RepaymentRow[];
  originTx: any;
}> {
  const pool = getPool();

  // Get loan
  const loanResult = await pool.query(
    `SELECT 
      ls.loan_id as id,
      le.id as lender_id, le.name as lender_name, le.icon as lender_icon,
      be.id as borrower_id, be.name as borrower_name, be.icon as borrower_icon,
      ls.original_paisa, ls.repaid_paisa, ls.remaining_paisa,
      ls.status, ls.loan_date, ls.paid_on, ls.note,
      ls.origin_tx_id
     FROM loan_state ls
     JOIN envelopes le ON le.id = ls.lender_envelope_id
     JOIN envelopes be ON be.id = ls.borrower_envelope_id
     WHERE ls.loan_id = $1 AND ls.user_id = $2`,
    [loanId, userId]
  );

  if (loanResult.rows.length === 0) {
    throw new Error('Loan not found');
  }

  const row = loanResult.rows[0];

  const loan: LoanRow = {
    id: row.id,
    lender: {
      id: row.lender_id,
      name: row.lender_name,
      icon: row.lender_icon,
    },
    borrower: {
      id: row.borrower_id,
      name: row.borrower_name,
      icon: row.borrower_icon,
    },
    original: BigInt(row.original_paisa),
    repaid: BigInt(row.repaid_paisa),
    remaining: BigInt(row.remaining_paisa),
    status: row.status,
    loanDate: row.loan_date,
    paidOn: row.paid_on,
    note: row.note,
  };

  // Get repayments
  const repaymentsResult = await pool.query(
    `SELECT id, amount_paisa, occurred_on, occurred_at
     FROM transactions
     WHERE loan_id = $1 AND type = 'loan_repayment' AND deleted_at IS NULL
     ORDER BY occurred_on DESC, occurred_at DESC`,
    [loanId]
  );

  const repayments: RepaymentRow[] = repaymentsResult.rows.map((r: any) => ({
    id: r.id,
    amountPaisa: BigInt(r.amount_paisa),
    occurredOn: r.occurred_on,
    occurredAt: r.occurred_at,
  }));

  // Get origin tx
  const originTxResult = await pool.query(
    `SELECT * FROM transactions WHERE id = $1`,
    [row.origin_tx_id]
  );

  const originTx = originTxResult.rows[0];

  return { loan, repayments, originTx };
}
