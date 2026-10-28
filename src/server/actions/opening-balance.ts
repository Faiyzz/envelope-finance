/**
 * Opening balance management - TD-03 §2
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { uuidv7 } from 'uuidv7';
import { parseMoney } from '@/domain/money';
import { ValidationError, RuleViolation, NotFound, Conflict } from '@/domain/errors';

const SetOpeningBalanceSchema = z.object({
  amount: z.string(), // PositivePaisaStr or '0'
  date: z.string().optional(), // LocalDate
  version: z.number().optional(),
});

export const setOpeningBalance = defineAction({
  name: 'finance.setOpeningBalance',
  input: SetOpeningBalanceSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Parse amount
      const amountResult = parseMoney(input.amount, { allowZero: true });
      if (!amountResult.ok) {
        await client.query('ROLLBACK');
        throw new ValidationError({ amount: 'Invalid amount' });
      }

      const amountPaisa = amountResult.value;
      const date = input.date || new Date().toISOString().split('T')[0];

      // Check if opening balance exists
      const existing = await client.query(
        `SELECT id, version, amount_paisa, occurred_on 
         FROM transactions 
         WHERE user_id = $1 AND type = 'opening_balance' AND deleted_at IS NULL`,
        [userId]
      );

      if (existing.rows.length === 0) {
        // Insert new opening balance
        const txId = uuidv7();
        await client.query(
          `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, note, version)
           VALUES ($1, $2, 'opening_balance', $3, $4, '00:00:00', 'Opening balance', 1)`,
          [txId, userId, amountPaisa.toString(), date]
        );
      } else {
        // Edit existing opening balance
        const row = existing.rows[0];

        // Optimistic concurrency check
        if (input.version !== undefined && row.version !== input.version) {
          await client.query('ROLLBACK');
          throw new Conflict('This was changed on another device. Reload to see the latest.');
        }

        // Update with version bump (trigger handles version increment)
        await client.query(
          `UPDATE transactions 
           SET amount_paisa = $1, occurred_on = $2 
           WHERE id = $3 AND user_id = $4 AND version = $5`,
          [amountPaisa.toString(), date, row.id, userId, row.version]
        );
      }

      // Timeline validation will be handled by the pipeline's revalidation
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

export const deleteOpeningBalance = defineAction({
  name: 'finance.deleteOpeningBalance',
  input: z.object({}),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if opening balance exists
      const existing = await client.query(
        `SELECT id FROM transactions 
         WHERE user_id = $1 AND type = 'opening_balance' AND deleted_at IS NULL`,
        [userId]
      );

      if (existing.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Opening balance not found');
      }

      // Check if there are other non-deleted transactions
      const otherTxCount = await client.query(
        `SELECT COUNT(*) as count FROM transactions 
         WHERE user_id = $1 AND type != 'opening_balance' AND deleted_at IS NULL`,
        [userId]
      );

      if (parseInt(otherTxCount.rows[0].count) > 0) {
        await client.query('ROLLBACK');
        throw new RuleViolation("You can't delete your opening balance while you have other transactions. Edit the amount instead.");
      }

      // Soft delete opening balance
      await client.query(
        `UPDATE transactions 
         SET deleted_at = now(), deleted_by = $1 
         WHERE id = $2 AND user_id = $3`,
        [userId, existing.rows[0].id, userId]
      );

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
