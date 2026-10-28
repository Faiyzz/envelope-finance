/**
 * Global search action - TD-05 §8
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';

export interface EnvelopeHit {
  id: string;
  name: string;
  ownerType: 'mine' | 'other';
}

export interface TxHit {
  id: string;
  type: string;
  amountPaisa: bigint;
  occurredOn: string;
  note: string | null;
  envelopeName: string | null;
  categoryName: string | null;
}

export interface LoanHit {
  id: string;
  note: string | null;
  amountPaisa: bigint;
}

export interface RuleHit {
  id: string;
  name: string;
}

export interface GlobalSearchResult {
  envelopes: EnvelopeHit[];
  transactions: TxHit[];
  loans: LoanHit[];
  recurring: RuleHit[];
  counts: {
    envelopesBeforeCap: number;
    transactionsBeforeCap: number;
    loansBeforeCap: number;
    recurringBeforeCap: number;
  };
}

export const globalSearch = defineAction({
  name: 'search.global',
  input: z.object({
    q: z.string().trim().min(2).max(80),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    const q = input.q.trim();
    const searchTerm = `%${q}%`;

    // Check if query is a pure number (amount match)
    const isNumeric = /^\d+(\.\d{1,2})?$/.test(q.replace(/,/g, ''));
    let amountMatch: bigint | null = null;
    if (isNumeric) {
      // Parse as money - simplified version
      const parts = q.replace(/,/g, '').split('.');
      const whole = BigInt(parts[0] ?? '0');
      const paisa = parts.length === 2 ? whole * 100n + BigInt((parts[1] ?? '').padEnd(2, '0')) : whole * 100n;
      amountMatch = paisa;
    }

    // Search envelopes (capped at 50)
    const envelopesResult = await pool.query(
      `SELECT id, name, owner_type 
       FROM envelopes 
       WHERE user_id = $1 
         AND (name ILIKE $2 OR description ILIKE $2 OR owner_name ILIKE $2)
         AND status = 'active'
       LIMIT 51`,
      [userId, searchTerm]
    );

    const envelopes = envelopesResult.rows.slice(0, 50).map((row: any) => ({
      id: row.id,
      name: row.name,
      ownerType: row.owner_type,
    }));

    // Search transactions (capped at 50)
    let txQuery = `
      SELECT t.id, t.type, t.amount_paisa, t.occurred_on, t.note,
             e.name as envelope_name, c.name as category_name
      FROM transactions t
      LEFT JOIN envelopes e ON e.id = t.envelope_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.user_id = $1 AND t.deleted_at IS NULL
        AND (t.note ILIKE $2 OR c.name ILIKE $2 OR e.name ILIKE $2 OR e.owner_name ILIKE $2
    `;
    const txParams: any[] = [userId, searchTerm];
    let paramIndex = 3;

    if (amountMatch !== null) {
      txQuery += ` OR t.amount_paisa = $${paramIndex++}`;
      txParams.push(amountMatch.toString());
    }

    txQuery += `) LIMIT 51`;

    const transactionsResult = await pool.query(txQuery, txParams);

    const transactions = transactionsResult.rows.slice(0, 50).map((row: any) => ({
      id: row.id,
      type: row.type,
      amountPaisa: BigInt(row.amount_paisa),
      occurredOn: row.occurred_on,
      note: row.note,
      envelopeName: row.envelope_name,
      categoryName: row.category_name,
    }));

    // Search loans (capped at 50) - placeholder for TD-06
    const loans: LoanHit[] = [];

    // Search recurring rules (capped at 50) - placeholder for TD-07
    const recurring: RuleHit[] = [];

    return {
      envelopes,
      transactions,
      loans,
      recurring,
      counts: {
        envelopesBeforeCap: envelopesResult.rows.length,
        transactionsBeforeCap: transactionsResult.rows.length,
        loansBeforeCap: 0,
        recurringBeforeCap: 0,
      },
    };
  },
  revalidate: () => [],
});
