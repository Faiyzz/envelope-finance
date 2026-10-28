/**
 * Held money (external deposit/withdrawal) actions - TD-04 §5
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { uuidv7 } from 'uuidv7';
import { parseMoney } from '@/domain/money';
import { ValidationError, NotFound } from '@/domain/errors';

const CommonTxInput = z.object({
  idempotencyKey: z.string().uuid(),
  amount: z.string(), // PositivePaisaStr
  date: z.string().optional(), // LocalDate
  time: z.string().optional(), // LocalTime
  note: z.string().max(500).optional(),
});

export const recordHeldMoney = defineAction({
  name: 'heldMoney.record',
  input: CommonTxInput.extend({
    envelopeId: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Parse amount
      const amountResult = parseMoney(input.amount, { allowZero: false });
      if (!amountResult.ok) {
        await client.query('ROLLBACK');
        throw new ValidationError({ amount: 'Invalid amount' });
      }

      const amountPaisa = amountResult.value;

      // Validate envelope exists, is active, and is 'other'
      const envResult = await client.query(
        `SELECT id, owner_type FROM envelopes 
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        [input.envelopeId, userId]
      );

      if (envResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Envelope not found');
      }

      if (envResult.rows[0].owner_type !== 'other') {
        await client.query('ROLLBACK');
        throw new ValidationError({ envelopeId: 'Record held money only for money held for others' });
      }

      const date = input.date || new Date().toISOString().split('T')[0];
      const time = input.time || '12:00:00';

      // Create external_deposit transaction
      const txId = uuidv7();
      await client.query(
        `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, note, version)
         VALUES ($1, $2, 'external_deposit', $3, $4, $5, $6, $7, 1)`,
        [txId, userId, amountPaisa.toString(), date, time, input.envelopeId, input.note || null]
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
  revalidate: () => ['/envelopes', '/'],
});

export const returnHeldMoney = defineAction({
  name: 'heldMoney.return',
  input: CommonTxInput.extend({
    envelopeId: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Parse amount
      const amountResult = parseMoney(input.amount, { allowZero: false });
      if (!amountResult.ok) {
        await client.query('ROLLBACK');
        throw new ValidationError({ amount: 'Invalid amount' });
      }

      const amountPaisa = amountResult.value;

      // Validate envelope exists, is active, and is 'other'
      const envResult = await client.query(
        `SELECT id, owner_type FROM envelopes 
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        [input.envelopeId, userId]
      );

      if (envResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Envelope not found');
      }

      if (envResult.rows[0].owner_type !== 'other') {
        await client.query('ROLLBACK');
        throw new ValidationError({ envelopeId: 'Return held money only for money held for others' });
      }

      const date = input.date || new Date().toISOString().split('T')[0];
      const time = input.time || '12:00:00';

      // Create external_withdrawal transaction
      const txId = uuidv7();
      await client.query(
        `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, note, version)
         VALUES ($1, $2, 'external_withdrawal', $3, $4, $5, $6, $7, 1)`,
        [txId, userId, amountPaisa.toString(), date, time, input.envelopeId, input.note || null]
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
  revalidate: () => ['/envelopes', '/'],
});
