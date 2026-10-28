/**
 * Recently deleted actions - TD-03 §4
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { NotFound } from '@/domain/errors';

export const listRecentlyDeleted = defineAction({
  name: 'data.listRecentlyDeleted',
  input: z.object({
    cursor: z.string().optional(),
    limit: z.number().min(1).max(30).default(30),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `SELECT id, type, amount_paisa, occurred_on, note, deleted_at,
              envelope_id, counterpart_envelope_id, category_id
       FROM transactions
       WHERE user_id = $1 AND deleted_at > $2
       ORDER BY deleted_at DESC
       LIMIT $3`,
      [userId, thirtyDaysAgo, input.limit]
    );

    return {
      transactions: result.rows.map((row: any) => ({
        id: row.id,
        type: row.type,
        amountPaisa: row.amount_paisa,
        occurredOn: row.occurred_on,
        note: row.note,
        deletedAt: row.deleted_at,
        envelopeId: row.envelope_id,
        counterpartEnvelopeId: row.counterpart_envelope_id,
        categoryId: row.category_id,
      })),
    };
  },
  revalidate: () => [],
});

export const restoreTransaction = defineAction({
  name: 'data.restoreTransaction',
  input: z.object({
    transactionId: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get transaction
      const txResult = await client.query(
        `SELECT id, deleted_at, deleted_by 
         FROM transactions 
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL`,
        [input.transactionId, userId]
      );

      if (txResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Transaction not found');
      }

      // Clear deleted_at and deleted_by
      await client.query(
        `UPDATE transactions 
         SET deleted_at = NULL, deleted_by = NULL 
         WHERE id = $1 AND user_id = $2`,
        [input.transactionId, userId]
      );

      // Timeline validation will be handled by the pipeline
      await client.query('COMMIT');

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/'],
});
