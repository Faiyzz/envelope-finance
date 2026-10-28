/**
 * Onboarding actions - TD-03 §1
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { uuidv7 } from 'uuidv7';
import { parseMoney } from '@/domain/money';
import { ValidationError, RuleViolation } from '@/domain/errors';

const EnvelopeInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().optional(),
  color: z.string().optional(),
  kind: z.enum(['standard', 'savings']),
  ownerType: z.enum(['mine', 'other']),
  ownerName: z.string().optional(),
  allocate: z.string(), // PaisaStr
});

const CompleteOnboardingSchema = z.object({
  idempotencyKey: z.string().uuid(),
  openingBalance: z.string(), // PositivePaisaStr or '0'
  openingDate: z.string().optional(), // LocalDate
  envelopes: z.array(EnvelopeInputSchema),
});

export const completeOnboarding = defineAction({
  name: 'onboarding.complete',
  input: CompleteOnboardingSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if user already has opening balance
      const existingOpening = await client.query(
        `SELECT id FROM transactions 
         WHERE user_id = $1 AND type = 'opening_balance' AND deleted_at IS NULL`,
        [userId]
      );

      if (existingOpening.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new RuleViolation("You've already set your opening balance — edit it in Settings → Finance");
      }

      // Parse opening balance
      const openingResult = parseMoney(input.openingBalance, { allowZero: true });
      if (!openingResult.ok) {
        await client.query('ROLLBACK');
        throw new ValidationError({ openingBalance: 'Invalid amount' });
      }

      const openingPaisa = openingResult.value;
      const openingDate = input.openingDate || new Date().toISOString().split('T')[0];

      // Validate envelopes
      const envelopeNames = new Set<string>();
      let totalAllocation = 0n;

      for (const env of input.envelopes) {
        // Check duplicate names (case-insensitive)
        const lowerName = env.name.toLowerCase();
        if (envelopeNames.has(lowerName)) {
          await client.query('ROLLBACK');
          throw new ValidationError({ envelopes: 'Duplicate envelope name' });
        }
        envelopeNames.add(lowerName);

        // Validate owner name for other-owned envelopes
        if (env.ownerType === 'other' && (!env.ownerName || env.ownerName.trim() === '')) {
          await client.query('ROLLBACK');
          throw new ValidationError({ ownerName: 'Owner name required for money held for others' });
        }

        // Parse allocation
        const allocResult = parseMoney(env.allocate, { allowZero: true });
        if (!allocResult.ok) {
          await client.query('ROLLBACK');
          throw new ValidationError({ allocate: 'Invalid allocation amount' });
        }

        totalAllocation += allocResult.value;
      }

      // Validate total allocation ≤ opening balance
      if (totalAllocation > openingPaisa) {
        await client.query('ROLLBACK');
        throw new ValidationError({ envelopes: "You've assigned more than your balance" });
      }

      // Insert opening balance transaction
      const openingTxId = uuidv7();
      await client.query(
        `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, note, version)
         VALUES ($1, $2, 'opening_balance', $3, $4, '00:00:00', 'Opening balance', 1)`,
        [openingTxId, userId, openingPaisa.toString(), openingDate]
      );

      // Create envelopes and allocation transactions
      const envelopeIds: string[] = [];
      let timeOffset = 1;

      for (const env of input.envelopes) {
        const allocResult = parseMoney(env.allocate, { allowZero: true });
        const allocPaisa = allocResult.ok ? allocResult.value : 0n;

        // Create envelope
        const envelopeId = uuidv7();
        await client.query(
          `INSERT INTO envelopes (id, user_id, name, icon, color, owner_type, owner_name, kind, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            envelopeId,
            userId,
            env.name.trim(),
            env.icon || '💼',
            env.color || null,
            env.ownerType,
            env.ownerName?.trim() || null,
            env.kind,
            envelopeIds.length,
          ]
        );

        envelopeIds.push(envelopeId);

        // Create allocation transaction if allocate > 0
        if (allocPaisa > 0n) {
          const allocTxId = uuidv7();
          const occurredAt = String(timeOffset).padStart(2, '0') + ':00:00';
          timeOffset++;

          await client.query(
            `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, version)
             VALUES ($1, $2, 'allocation', $3, $4, $5, $6, 1)`,
            [allocTxId, userId, allocPaisa.toString(), openingDate, occurredAt, envelopeId]
          );
        }
      }

      // Set onboarding completed
      await client.query(
        `UPDATE users SET onboarding_completed_at = now() WHERE id = $1`,
        [userId]
      );

      await client.query('COMMIT');

      return { envelopeIds };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => [],
});

export const skipOnboarding = defineAction({
  name: 'onboarding.skip',
  input: z.object({}),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    await pool.query(
      `UPDATE users SET onboarding_completed_at = now() WHERE id = $1`,
      [userId]
    );

    return { success: true };
  },
  revalidate: () => [],
});
