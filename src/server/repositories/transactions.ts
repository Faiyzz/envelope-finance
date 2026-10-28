/**
 * Transaction read models - TD-05 §6
 */

import { getPool } from '@/server/db/client';

export interface TxRow {
  id: string;
  type: string;
  amountPaisa: bigint;
  occurredOn: string;
  occurredAt: string;
  envelopeId: string | null;
  counterpartEnvelopeId: string | null;
  categoryId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ListTransactionsResult {
  items: TxRow[];
  nextCursor?: string;
  totals: {
    count: number;
    net: bigint;
    spent: bigint;
    income: bigint;
  };
}

/**
 * List transactions with cursor pagination
 */
export async function listTransactions(
  userId: string,
  query: {
    cursor?: string;
    limit?: number;
    text?: string;
    envelopeIds?: string[];
    categoryIds?: string[];
    types?: string[];
    from?: string;
    to?: string;
    amountMin?: string;
    amountMax?: string;
    ownerName?: string;
    recurring?: 'yes' | 'no' | 'generated';
    loanRelated?: boolean;
    sort?: 'newest' | 'oldest' | 'highest' | 'lowest';
  } = {}
): Promise<ListTransactionsResult> {
  const pool = getPool();
  const limit = Math.min(query.limit || 30, 100);

  const whereConditions: string[] = ['t.user_id = $1', 't.deleted_at IS NULL'];
  const params: any[] = [userId];
  let paramIndex = 2;

  // Text search
  if (query.text && query.text.length >= 2) {
    whereConditions.push(`(t.note ILIKE $${paramIndex++} OR c.name ILIKE $${paramIndex++} OR e.name ILIKE $${paramIndex++} OR e.owner_name ILIKE $${paramIndex++})`);
    const searchTerm = `%${query.text}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }

  // Envelope filter (matches envelope_id OR counterpart_envelope_id OR split envelope)
  if (query.envelopeIds && query.envelopeIds.length > 0) {
    whereConditions.push(`(t.envelope_id = ANY($${paramIndex++}) OR t.counterpart_envelope_id = ANY($${paramIndex++}) OR t.id IN (SELECT transaction_id FROM transaction_splits WHERE envelope_id = ANY($${paramIndex++})))`);
    params.push(query.envelopeIds, query.envelopeIds, query.envelopeIds);
  }

  // Category filter
  if (query.categoryIds && query.categoryIds.length > 0) {
    whereConditions.push(`t.category_id = ANY($${paramIndex++})`);
    params.push(query.categoryIds);
  }

  // Type filter
  if (query.types && query.types.length > 0) {
    if (query.types.includes('loan-related')) {
      whereConditions.push(`(t.type = ANY($${paramIndex++}) OR t.type = ANY($${paramIndex++}))`);
      const loanTypes = ['loan', 'loan_repayment'];
      const otherTypes = query.types.filter(t => t !== 'loan-related');
      params.push(loanTypes, otherTypes);
    } else {
      whereConditions.push(`t.type = ANY($${paramIndex++})`);
      params.push(query.types);
    }
  }

  // Date range
  if (query.from) {
    whereConditions.push(`t.occurred_on >= $${paramIndex++}`);
    params.push(query.from);
  }
  if (query.to) {
    whereConditions.push(`t.occurred_on <= $${paramIndex++}`);
    params.push(query.to);
  }

  // Amount range
  if (query.amountMin) {
    whereConditions.push(`t.amount_paisa >= $${paramIndex++}`);
    params.push(query.amountMin);
  }
  if (query.amountMax) {
    whereConditions.push(`t.amount_paisa <= $${paramIndex++}`);
    params.push(query.amountMax);
  }

  // Owner name filter
  if (query.ownerName) {
    whereConditions.push(`e.owner_name ILIKE $${paramIndex++}`);
    params.push(`%${query.ownerName}%`);
  }

  // Cursor pagination
  let cursorClause = '';
  if (query.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
      if (query.sort === 'newest') {
        cursorClause = `AND (t.occurred_on, t.occurred_at, t.created_at, t.id) < ($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`;
        params.push(cursor[0], cursor[1], cursor[2], cursor[3]);
      } else if (query.sort === 'oldest') {
        cursorClause = `AND (t.occurred_on, t.occurred_at, t.created_at, t.id) > ($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`;
        params.push(cursor[0], cursor[1], cursor[2], cursor[3]);
      } else if (query.sort === 'highest') {
        cursorClause = `AND (t.amount_paisa, t.occurred_on, t.occurred_at, t.created_at, t.id) > ($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`;
        params.push(cursor[0], cursor[1], cursor[2], cursor[3], cursor[4]);
      } else if (query.sort === 'lowest') {
        cursorClause = `AND (t.amount_paisa, t.occurred_on, t.occurred_at, t.created_at, t.id) < ($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`;
        params.push(cursor[0], cursor[1], cursor[2], cursor[3], cursor[4]);
      }
    } catch {
      throw new Error('Invalid cursor');
    }
  }

  // Sort order
  let orderBy = 'ORDER BY t.occurred_on DESC, t.occurred_at DESC, t.created_at DESC, t.id DESC';
  if (query.sort === 'oldest') {
    orderBy = 'ORDER BY t.occurred_on ASC, t.occurred_at ASC, t.created_at ASC, t.id ASC';
  } else if (query.sort === 'highest') {
    orderBy = 'ORDER BY t.amount_paisa DESC, t.occurred_on DESC, t.occurred_at DESC, t.created_at DESC, t.id DESC';
  } else if (query.sort === 'lowest') {
    orderBy = 'ORDER BY t.amount_paisa ASC, t.occurred_on DESC, t.occurred_at DESC, t.created_at DESC, t.id DESC';
  }

  const itemsQuery = `
    SELECT 
      t.id, t.type, t.amount_paisa, t.occurred_on, t.occurred_at,
      t.envelope_id, t.counterpart_envelope_id, t.category_id, t.note,
      t.created_at, t.updated_at, t.version
    FROM transactions t
    LEFT JOIN envelopes e ON e.id = t.envelope_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${whereConditions.join(' AND ')}
    ${cursorClause}
    ${orderBy}
    LIMIT $${paramIndex++}
  `;
  params.push(limit + 1); // Fetch one extra to determine if there's a next page

  const itemsResult = await pool.query(itemsQuery, params);
  const items = itemsResult.rows.slice(0, limit).map((row: any) => ({
    id: row.id,
    type: row.type,
    amountPaisa: BigInt(row.amount_paisa),
    occurredOn: row.occurred_on,
    occurredAt: row.occurred_at,
    envelopeId: row.envelope_id,
    counterpartEnvelopeId: row.counterpart_envelope_id,
    categoryId: row.category_id,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }));

  // Compute next cursor
  let nextCursor: string | undefined;
  const lastRow = items[items.length - 1];
  if (itemsResult.rows.length > limit && lastRow) {
    let cursorValue: any[];
    if (query.sort === 'highest' || query.sort === 'lowest') {
      cursorValue = [lastRow.amountPaisa.toString(), lastRow.occurredOn, lastRow.occurredAt, lastRow.createdAt, lastRow.id];
    } else {
      cursorValue = [lastRow.occurredOn, lastRow.occurredAt, lastRow.createdAt, lastRow.id];
    }
    nextCursor = Buffer.from(JSON.stringify(cursorValue)).toString('base64url');
  }

  // Compute totals (separate query over same filter)
  const totalsParams = params.slice(0, paramIndex - limit - 2); // Remove limit and cursor params
  const totalsQuery = `
    SELECT 
      COUNT(*) as count,
      COALESCE(SUM(CASE WHEN t.type IN ('income', 'external_deposit') THEN t.amount_paisa ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_paisa ELSE 0 END), 0) as spent
    FROM transactions t
    LEFT JOIN envelopes e ON e.id = t.envelope_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${whereConditions.join(' AND ')}
  `;

  const totalsResult = await pool.query(totalsQuery, totalsParams);
  const count = parseInt(totalsResult.rows[0].count);
  const income = BigInt(totalsResult.rows[0].income || '0');
  const spent = BigInt(totalsResult.rows[0].spent || '0');
  const net = income - spent;

  return {
    items,
    nextCursor,
    totals: { count, net, spent, income },
  };
}
