/**
 * Envelope actions - TD-04 §3
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { uuidv7 } from 'uuidv7';
import { parseMoney } from '@/domain/money';
import { ValidationError, RuleViolation, NotFound, Conflict } from '@/domain/errors';

const CreateEnvelopeSchema = z.object({
  idempotencyKey: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300).optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  ownerType: z.enum(['mine', 'other']),
  ownerName: z.string().max(60).optional(),
  kind: z.enum(['standard', 'savings']),
  goalAmount: z.string().optional(), // PositivePaisaStr
  initialFunding: z.object({
    amount: z.string(), // PositivePaisaStr
    source: z.enum(['unallocated', 'new_money']),
  }).optional(),
  date: z.string().optional(), // LocalDate
});

export const createEnvelope = defineAction({
  name: 'envelopes.create',
  input: CreateEnvelopeSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check active name uniqueness (case-insensitive)
      const existing = await client.query(
        `SELECT id FROM envelopes 
         WHERE user_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND status = 'active'`,
        [userId, input.name]
      );

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new ValidationError({ name: `You already have an envelope called "${input.name}".` });
      }

      // Validate owner name for other-owned
      if (input.ownerType === 'other' && (!input.ownerName || input.ownerName.trim() === '')) {
        await client.query('ROLLBACK');
        throw new ValidationError({ ownerName: 'Owner name required for money held for others' });
      }

      // Validate goal amount (savings only)
      if (input.kind === 'standard' && input.goalAmount) {
        await client.query('ROLLBACK');
        throw new ValidationError({ goalAmount: 'Goal amount only for savings envelopes' });
      }

      // Validate funding source
      if (input.initialFunding) {
        if (input.ownerType === 'mine' && input.initialFunding.source === 'new_money') {
          await client.query('ROLLBACK');
          throw new ValidationError({ source: 'new_money only for money held for others' });
        }
      }

      // Parse goal amount if provided
      let goalPaisa: bigint | null = null;
      if (input.goalAmount) {
        const goalResult = parseMoney(input.goalAmount, { allowZero: false });
        if (!goalResult.ok) {
          await client.query('ROLLBACK');
          throw new ValidationError({ goalAmount: 'Invalid goal amount' });
        }
        goalPaisa = goalResult.value;
      }

      // Get next sort_order for owner group
      const sortOrderResult = await client.query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order 
         FROM envelopes 
         WHERE user_id = $1 AND owner_type = $2 AND status = 'active'`,
        [userId, input.ownerType]
      );
      const sortOrder = sortOrderResult.rows[0].next_order;

      // Create envelope
      const envelopeId = uuidv7();
      await client.query(
        `INSERT INTO envelopes (id, user_id, name, description, icon, color, owner_type, owner_name, kind, goal_amount_paisa, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11)`,
        [
          envelopeId,
          userId,
          input.name.trim(),
          input.description?.trim() || null,
          input.icon || '💼',
          input.color || null,
          input.ownerType,
          input.ownerName?.trim() || null,
          input.kind,
          goalPaisa?.toString() || null,
          sortOrder,
        ]
      );

      // Handle initial funding
      const date = input.date || new Date().toISOString().split('T')[0];

      if (input.initialFunding) {
        const fundResult = parseMoney(input.initialFunding.amount, { allowZero: false });
        if (!fundResult.ok) {
          await client.query('ROLLBACK');
          throw new ValidationError({ amount: 'Invalid funding amount' });
        }

        const fundPaisa = fundResult.value;

        if (input.initialFunding.source === 'unallocated') {
          // Create allocation transaction
          const txId = uuidv7();
          await client.query(
            `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, note, version)
             VALUES ($1, $2, 'allocation', $3, $4, '00:00:00', $5, 'Initial funding', 1)`,
            [txId, userId, fundPaisa.toString(), date, envelopeId]
          );
        } else if (input.initialFunding.source === 'new_money') {
          // Create external_deposit transaction
          const txId = uuidv7();
          await client.query(
            `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, note, version)
             VALUES ($1, $2, 'external_deposit', $3, $4, '00:00:00', $5, 'Initial funding', 1)`,
            [txId, userId, fundPaisa.toString(), date, envelopeId]
          );
        }
      }

      // Check soft cap
      const countResult = await client.query(
        `SELECT COUNT(*) as count FROM envelopes WHERE user_id = $1 AND status = 'active'`,
        [userId]
      );
      const count = parseInt(countResult.rows[0].count);
      const warnings = count >= 200 ? ['SOFT_CAP'] : [];

      await client.query('COMMIT');

      return { envelopeId, warnings };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/envelopes', '/'],
});

const UpdateEnvelopeSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().optional(),
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().max(300).optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  ownerName: z.string().max(60).optional(),
  kind: z.enum(['standard', 'savings']).optional(),
  goalAmount: z.string().optional(),
});

export const updateEnvelope = defineAction({
  name: 'envelopes.update',
  input: UpdateEnvelopeSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load envelope
      const envResult = await client.query(
        `SELECT id, updated_at, owner_type, kind FROM envelopes 
         WHERE id = $1 AND user_id = $2`,
        [input.id, userId]
      );

      if (envResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Envelope not found');
      }

      const env = envResult.rows[0];

      // Optimistic concurrency check
      if (input.updatedAt && new Date(env.updated_at).getTime() !== new Date(input.updatedAt).getTime()) {
        await client.query('ROLLBACK');
        throw new Conflict('This was changed on another device. Reload to see the latest.');
      }

      // Validate goal amount (savings only)
      if (input.kind === 'standard' && input.goalAmount) {
        await client.query('ROLLBACK');
        throw new ValidationError({ goalAmount: 'Goal amount only for savings envelopes' });
      }

      // Parse goal amount if provided
      let goalPaisa: bigint | null = null;
      if (input.goalAmount) {
        const goalResult = parseMoney(input.goalAmount, { allowZero: false });
        if (!goalResult.ok) {
          await client.query('ROLLBACK');
          throw new ValidationError({ goalAmount: 'Invalid goal amount' });
        }
        goalPaisa = goalResult.value;
      }

      // Build update
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (input.name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(input.name.trim());
      }
      if (input.description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        values.push(input.description.trim() || null);
      }
      if (input.icon !== undefined) {
        updates.push(`icon = $${paramIndex++}`);
        values.push(input.icon);
      }
      if (input.color !== undefined) {
        updates.push(`color = $${paramIndex++}`);
        values.push(input.color);
      }
      if (input.ownerName !== undefined) {
        updates.push(`owner_name = $${paramIndex++}`);
        values.push(input.ownerName.trim() || null);
      }
      if (input.kind !== undefined) {
        updates.push(`kind = $${paramIndex++}`);
        values.push(input.kind);
      }
      if (input.goalAmount !== undefined) {
        updates.push(`goal_amount_paisa = $${paramIndex++}`);
        values.push(goalPaisa?.toString() || null);
      }

      if (updates.length === 0) {
        await client.query('ROLLBACK');
        return { success: true };
      }

      values.push(input.id, userId);

      await client.query(
        `UPDATE envelopes SET ${updates.join(', ')} WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}`,
        values
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

const ArchiveEnvelopeSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().optional(),
  resolution: z.enum(['to_unallocated', 'return_to_owner', 'give_to_me']).optional(),
});

export const archiveEnvelope = defineAction({
  name: 'envelopes.archive',
  input: ArchiveEnvelopeSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load envelope FOR UPDATE
      const envResult = await client.query(
        `SELECT id, status, owner_type, updated_at FROM envelopes 
         WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [input.id, userId]
      );

      if (envResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Envelope not found');
      }

      const env = envResult.rows[0];

      // Idempotent: already archived
      if (env.status === 'archived') {
        await client.query('ROLLBACK');
        return { success: true };
      }

      // Check for active loans (TD-06 integration point)
      // TODO: Add loan check when TD-06 is implemented

      // Get balance
      const balanceResult = await client.query(
        `SELECT balance_paisa FROM envelope_balances WHERE envelope_id = $1`,
        [input.id]
      );
      const balance = BigInt(balanceResult.rows[0]?.balance_paisa || '0');

      // Handle balance
      const date = new Date().toISOString().split('T')[0];

      if (balance > 0n) {
        if (!input.resolution) {
          await client.query('ROLLBACK');
          throw new RuleViolation({
            code: 'NEEDS_RESOLUTION',
            balance: balance.toString(),
            ownerType: env.owner_type,
          });
        }

        if (env.owner_type === 'mine' && input.resolution === 'to_unallocated') {
          const txId = uuidv7();
          await client.query(
            `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, note, version)
             VALUES ($1, $2, 'deallocation', $3, $4, '00:00:00', $5, 'Archive', 1)`,
            [txId, userId, balance.toString(), date, input.id]
          );
        } else if (env.owner_type === 'other' && input.resolution === 'return_to_owner') {
          const txId = uuidv7();
          await client.query(
            `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, note, version)
             VALUES ($1, $2, 'external_withdrawal', $3, $4, '00:00:00', $5, 'Archive', 1)`,
            [txId, userId, balance.toString(), date, input.id]
          );
        } else if (env.owner_type === 'other' && input.resolution === 'give_to_me') {
          const txId = uuidv7();
          await client.query(
            `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, note, version)
             VALUES ($1, $2, 'deallocation', $3, $4, '00:00:00', $5, 'Archive', 1)`,
            [txId, userId, balance.toString(), date, input.id]
          );
        }
      }

      // Set archived
      await client.query(
        `UPDATE envelopes 
         SET status = 'archived', archived_at = now() 
         WHERE id = $1 AND user_id = $2`,
        [input.id, userId]
      );

      // Pause dependent recurring rules (TD-07 integration point)
      // TODO: Add recurring rule pause when TD-07 is implemented

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

const UnarchiveEnvelopeSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().optional(),
  rename: z.string().optional(),
});

export const unarchiveEnvelope = defineAction({
  name: 'envelopes.unarchive',
  input: UnarchiveEnvelopeSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load envelope
      const envResult = await client.query(
        `SELECT id, status FROM envelopes WHERE id = $1 AND user_id = $2`,
        [input.id, userId]
      );

      if (envResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Envelope not found');
      }

      const env = envResult.rows[0];

      if (env.status !== 'archived') {
        await client.query('ROLLBACK');
        return { success: true };
      }

      // Check name conflict with active envelopes
      const newName = input.rename || (await client.query(
        'SELECT name FROM envelopes WHERE id = $1',
        [input.id]
      )).rows[0].name;

      const conflict = await client.query(
        `SELECT id FROM envelopes 
         WHERE user_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND status = 'active' AND id != $3`,
        [userId, newName, input.id]
      );

      if (conflict.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new ValidationError({ name: 'An active envelope already has this name. Rename it first.' });
      }

      // Unarchive
      await client.query(
        `UPDATE envelopes 
         SET status = 'active', archived_at = NULL 
         WHERE id = $1 AND user_id = $2`,
        [input.id, userId]
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

export const deleteEnvelope = defineAction({
  name: 'envelopes.delete',
  input: z.object({
    id: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if anything references this envelope
      const refCheck = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM transactions WHERE user_id = $1 AND (envelope_id = $2 OR counterpart_envelope_id = $2)
         ) OR EXISTS (
           SELECT 1 FROM transaction_splits WHERE user_id = $1 AND envelope_id = $2
         ) AS has_refs`,
        [userId, input.id]
      );

      if (refCheck.rows[0].has_refs) {
        await client.query('ROLLBACK');
        throw new RuleViolation('This envelope has history, so it can\'t be deleted. You can archive it instead.');
      }

      // Delete envelope
      await client.query(
        'DELETE FROM envelopes WHERE id = $1 AND user_id = $2',
        [input.id, userId]
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

const ReorderEnvelopesSchema = z.object({
  owner: z.enum(['mine', 'other']),
  orderedIds: z.array(z.string().uuid()),
});

export const reorderEnvelopes = defineAction({
  name: 'envelopes.reorder',
  input: ReorderEnvelopesSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    // Validate orderedIds matches active envelopes of this owner
    const existing = await pool.query(
      `SELECT id FROM envelopes 
       WHERE user_id = $1 AND owner_type = $2 AND status = 'active' 
       ORDER BY sort_order`,
      [userId, input.owner]
    );

    const existingIds = new Set(existing.rows.map((r: any) => r.id));
    const inputIds = new Set(input.orderedIds);

    if (existingIds.size !== inputIds.size || ![...existingIds].every((id) => inputIds.has(id))) {
      throw new ValidationError({ orderedIds: 'Envelope list does not match current state' });
    }

    // Update sort orders
    for (let i = 0; i < input.orderedIds.length; i++) {
      await pool.query(
        `UPDATE envelopes SET sort_order = $1 WHERE id = $2 AND user_id = $3`,
        [i, input.orderedIds[i], userId]
      );
    }

    return { success: true };
  },
  revalidate: () => ['/envelopes'],
});
