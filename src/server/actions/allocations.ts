/**
 * Allocation, deallocation, transfer actions - TD-04 §4
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

export const allocate = defineAction({
  name: 'allocations.allocate',
  input: CommonTxInput.extend({
    toEnvelopeId: z.string().uuid(),
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

      // Validate envelope exists and is active
      const envResult = await client.query(
        `SELECT id, owner_type FROM envelopes 
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        [input.toEnvelopeId, userId]
      );

      if (envResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Envelope not found');
      }

      const date = input.date || new Date().toISOString().split('T')[0];
      const time = input.time || '12:00:00';

      // Create allocation transaction
      const txId = uuidv7();
      await client.query(
        `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, note, version)
         VALUES ($1, $2, 'allocation', $3, $4, $5, $6, $7, 1)`,
        [txId, userId, amountPaisa.toString(), date, time, input.toEnvelopeId, input.note || null]
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

export const deallocate = defineAction({
  name: 'allocations.deallocate',
  input: CommonTxInput.extend({
    fromEnvelopeId: z.string().uuid(),
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

      // Validate envelope exists and is active
      const envResult = await client.query(
        `SELECT id FROM envelopes 
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        [input.fromEnvelopeId, userId]
      );

      if (envResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Envelope not found');
      }

      const date = input.date || new Date().toISOString().split('T')[0];
      const time = input.time || '12:00:00';

      // Create deallocation transaction
      const txId = uuidv7();
      await client.query(
        `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, note, version)
         VALUES ($1, $2, 'deallocation', $3, $4, $5, $6, $7, 1)`,
        [txId, userId, amountPaisa.toString(), date, time, input.fromEnvelopeId, input.note || null]
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

export const transfer = defineAction({
  name: 'allocations.transfer',
  input: CommonTxInput.extend({
    fromEnvelopeId: z.string().uuid(),
    toEnvelopeId: z.string().uuid(),
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

      // Validate envelopes exist, are active, are different, and are both 'mine'
      const envsResult = await client.query(
        `SELECT id, owner_type FROM envelopes 
         WHERE id IN ($1, $2) AND user_id = $3 AND status = 'active'`,
        [input.fromEnvelopeId, input.toEnvelopeId, userId]
      );

      if (envsResult.rows.length !== 2) {
        await client.query('ROLLBACK');
        throw new NotFound('One or both envelopes not found');
      }

      const fromEnv = envsResult.rows.find((r: any) => r.id === input.fromEnvelopeId);
      const toEnv = envsResult.rows.find((r: any) => r.id === input.toEnvelopeId);

      if (fromEnv.owner_type !== 'mine' || toEnv.owner_type !== 'mine') {
        await client.query('ROLLBACK');
        throw new ValidationError({ transfer: 'Transfer only allowed between your own envelopes' });
      }

      if (input.fromEnvelopeId === input.toEnvelopeId) {
        await client.query('ROLLBACK');
        throw new ValidationError({ transfer: 'Cannot transfer to the same envelope' });
      }

      const date = input.date || new Date().toISOString().split('T')[0];
      const time = input.time || '12:00:00';

      // Create transfer transaction
      const txId = uuidv7();
      await client.query(
        `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, counterpart_envelope_id, note, version)
         VALUES ($1, $2, 'transfer', $3, $4, $5, $6, $7, $8, 1)`,
        [txId, userId, amountPaisa.toString(), date, time, input.fromEnvelopeId, input.toEnvelopeId, input.note || null]
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
