/**
 * Recurring rule actions - TD-07 §4
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { uuidv7 } from 'uuidv7';
import { ValidationError, NotFound, Conflict, RuleViolation } from '@/domain/errors';
import { dueDateForSlot, previewNext, slotsDue } from '@/domain/recurrence';

const CreateRuleSchema = z.object({
  idempotencyKey: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  type: z.enum(['expense', 'income']),
  amount: z.string(),
  envelopeId: z.string().uuid().optional(),
  categoryId: z.string().uuid(),
  splitTemplate: z.array(z.object({
    envelopeId: z.string().uuid(),
    amount: z.string(),
  })).optional(),
  frequency: z.enum(['weekly', 'monthly', 'yearly', 'custom_days']),
  intervalN: z.number().int().min(1).max(366).default(1),
  anchorDay: z.number().int().min(1).max(31).optional(),
  startDate: z.string(),
  endDate: z.string().optional(),
  maxOccurrences: z.number().int().positive().optional(),
  isCommittee: z.boolean().default(false),
  catchUp: z.enum(['backfill', 'from_next']).default('backfill'),
});

export const createRule = defineAction({
  name: 'recurring.create',
  input: CreateRuleSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Validate envelope exists and is active (for expense)
      if (input.type === 'expense') {
        if (!input.envelopeId) {
          await client.query('ROLLBACK');
          throw new ValidationError({ envelopeId: 'Envelope required for expense' });
        }

        const envResult = await client.query(
          `SELECT id, owner_type FROM envelopes 
           WHERE id = $1 AND user_id = $2 AND status = 'active'`,
          [input.envelopeId, userId]
        );

        if (envResult.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new NotFound('Envelope not found');
        }
      }

      // Validate category exists and kind matches
      const catResult = await client.query(
        `SELECT id, kind FROM categories 
         WHERE id = $1 AND user_id = $2`,
        [input.categoryId, userId]
      );

      if (catResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Category not found');
      }

      const category = catResult.rows[0];
      const expectedKind = input.type === 'expense' ? 'expense' : 'income';
      if (category.kind !== expectedKind) {
        await client.query('ROLLBACK');
        throw new ValidationError({ categoryId: `Category must be ${expectedKind}` });
      }

      // Validate income split template
      if (input.type === 'income' && input.splitTemplate) {
        for (const split of input.splitTemplate) {
          const envResult = await client.query(
            `SELECT id, owner_type FROM envelopes 
             WHERE id = $1 AND user_id = $2 AND status = 'active'`,
            [split.envelopeId, userId]
          );

          if (envResult.rows.length === 0) {
            await client.query('ROLLBACK');
            throw new ValidationError({ splitTemplate: 'Envelope not found in splits' });
          }

          if (envResult.rows[0].owner_type !== 'mine') {
            await client.query('ROLLBACK');
            throw new ValidationError({ splitTemplate: 'Income can only be split into your own envelopes' });
          }
        }
      }

      // Committee validation
      if (input.isCommittee) {
        if (input.type !== 'expense') {
          await client.query('ROLLBACK');
          throw new ValidationError({ isCommittee: 'Committee must be expense' });
        }
        if (!input.maxOccurrences) {
          await client.query('ROLLBACK');
          throw new ValidationError({ maxOccurrences: 'Committee requires max occurrences' });
        }
      }

      const amountPaisa = BigInt(input.amount);

      // Calculate next_slot_index based on catchUp
      let nextSlotIndex = 0;
      if (input.catchUp === 'from_next') {
        const today = new Date().toISOString().split('T')[0] as string;
        const schedule = {
          frequency: input.frequency,
          intervalN: input.intervalN ?? 1,
          anchorDay: input.anchorDay,
          startDate: input.startDate,
          endDate: input.endDate,
        };

        for (let k = 0; ; k++) {
          const dueDate = dueDateForSlot(schedule, k);
          if (dueDate > today) {
            nextSlotIndex = k;
            break;
          }
        }
      }

      // Insert rule
      const ruleId = uuidv7();
      await client.query(
        `INSERT INTO recurring_rules 
         (id, user_id, name, type, amount_paisa, envelope_id, category_id, split_template, 
          frequency, interval_n, anchor_day, start_date, end_date, max_occurrences, 
          is_committee, next_slot_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          ruleId,
          userId,
          input.name.trim(),
          input.type,
          amountPaisa.toString(),
          input.envelopeId || null,
          input.categoryId,
          input.splitTemplate ? JSON.stringify(input.splitTemplate) : null,
          input.frequency,
          input.intervalN,
          input.anchorDay || null,
          input.startDate,
          input.endDate || null,
          input.maxOccurrences || null,
          input.isCommittee,
          nextSlotIndex,
        ]
      );

      await client.query('COMMIT');

      // Preview next 3 dates
      const schedule = {
        frequency: input.frequency,
        intervalN: input.intervalN ?? 1,
        anchorDay: input.anchorDay,
        startDate: input.startDate,
        endDate: input.endDate,
      };
      const nextDates = previewNext(schedule, input.startDate, 3);

      return {
        rule: { id: ruleId },
        nextDates,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/recurring', '/'],
});

const CreateCommitteeSchema = z.object({
  idempotencyKey: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  monthlyAmount: z.string(),
  months: z.number().int().positive(),
  startDate: z.string(),
  envelopeId: z.string().uuid(),
  categoryId: z.string().uuid().optional(),
});

export const createCommittee = defineAction({
  name: 'recurring.createCommittee',
  input: CreateCommitteeSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Validate envelope exists and is active
      const envResult = await client.query(
        `SELECT id FROM envelopes 
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        [input.envelopeId, userId]
      );

      if (envResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Envelope not found');
      }

      // Validate category (use default if not provided)
      let categoryId = input.categoryId;
      if (!categoryId) {
        const defaultCatResult = await client.query(
          `SELECT id FROM categories 
           WHERE user_id = $1 AND kind = 'expense' AND is_system = true AND name = 'Uncategorized'`,
          [userId]
        );
        if (defaultCatResult.rows.length > 0) {
          categoryId = defaultCatResult.rows[0].id;
        } else {
          await client.query('ROLLBACK');
          throw new ValidationError({ categoryId: 'Default Uncategorized category not found' });
        }
      }

      const amountPaisa = BigInt(input.monthlyAmount);

      // Insert committee rule
      const ruleId = uuidv7();
      await client.query(
        `INSERT INTO recurring_rules 
         (id, user_id, name, type, amount_paisa, envelope_id, category_id, 
          frequency, interval_n, start_date, max_occurrences, is_committee, next_slot_index)
         VALUES ($1, $2, $3, 'expense', $4, $5, $6, 'monthly', 1, $7, $8, true, 0)`,
        [
          ruleId,
          userId,
          input.name.trim(),
          amountPaisa.toString(),
          input.envelopeId,
          categoryId,
          input.startDate,
          input.months,
        ]
      );

      await client.query('COMMIT');

      // Preview next 3 dates
      const schedule = {
        frequency: 'monthly' as const,
        intervalN: 1,
        anchorDay: undefined,
        startDate: input.startDate,
        endDate: undefined,
      };
      const nextDates = previewNext(schedule, input.startDate, 3);

      return {
        rule: { id: ruleId },
        nextDates,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/recurring', '/'],
});

const UpdateRuleSchema = z.object({
  ruleId: z.string().uuid(),
  version: z.number(),
  name: z.string().trim().min(1).max(60).optional(),
  amount: z.string().optional(),
  envelopeId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  splitTemplate: z.array(z.object({
    envelopeId: z.string().uuid(),
    amount: z.string(),
  })).optional(),
  endDate: z.string().optional(),
  maxOccurrences: z.number().int().positive().optional(),
});

export const updateRule = defineAction({
  name: 'recurring.update',
  input: UpdateRuleSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load rule
      const ruleResult = await client.query(
        `SELECT id, version, type, max_occurrences FROM recurring_rules 
         WHERE id = $1 AND user_id = $2`,
        [input.ruleId, userId]
      );

      if (ruleResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Rule not found');
      }

      const rule = ruleResult.rows[0];

      // Version check
      if (rule.version !== input.version) {
        await client.query('ROLLBACK');
        throw new Conflict('This was changed on another device. Reload to see the latest.');
      }

      // Check if rule has generated/needs_attention slots (frequency/start/anchor changes blocked)
      const slotCheck = await client.query(
        `SELECT COUNT(*) as count FROM recurring_occurrences 
         WHERE rule_id = $1 AND status IN ('generated', 'needs_attention')`,
        [input.ruleId]
      );

      if (parseInt(slotCheck.rows[0].count) > 0) {
        // Only allow amount/name/envelope/category/template/end/max changes
        // Frequency/start/anchor changes are rejected
        await client.query('ROLLBACK');
        throw new RuleViolation('To change frequency, start date, or anchor day, end this rule and create a new one');
      }

      // Validate max_occurrences cannot go below counted
      if (input.maxOccurrences !== undefined && rule.max_occurrences) {
        const counted = parseInt(slotCheck.rows[0].count);
        if (input.maxOccurrences < counted) {
          await client.query('ROLLBACK');
          throw new ValidationError({ maxOccurrences: `Cannot reduce below ${counted} already generated` });
        }
      }

      // Build update
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (input.name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(input.name.trim());
      }
      if (input.amount !== undefined) {
        updates.push(`amount_paisa = $${paramIndex++}`);
        values.push(input.amount);
      }
      if (input.envelopeId !== undefined) {
        updates.push(`envelope_id = $${paramIndex++}`);
        values.push(input.envelopeId);
      }
      if (input.categoryId !== undefined) {
        updates.push(`category_id = $${paramIndex++}`);
        values.push(input.categoryId);
      }
      if (input.splitTemplate !== undefined) {
        updates.push(`split_template = $${paramIndex++}`);
        values.push(JSON.stringify(input.splitTemplate));
      }
      if (input.endDate !== undefined) {
        updates.push(`end_date = $${paramIndex++}`);
        values.push(input.endDate);
      }
      if (input.maxOccurrences !== undefined) {
        updates.push(`max_occurrences = $${paramIndex++}`);
        values.push(input.maxOccurrences);
      }

      if (updates.length === 0) {
        await client.query('ROLLBACK');
        return { success: true };
      }

      values.push(input.ruleId, userId);

      await client.query(
        `UPDATE recurring_rules SET ${updates.join(', ')} WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}`,
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
  revalidate: () => ['/recurring', '/'],
});

export const pauseRule = defineAction({
  name: 'recurring.pause',
  input: z.object({
    ruleId: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    await pool.query(
      `UPDATE recurring_rules 
       SET status = 'paused', pause_reason = 'user' 
       WHERE id = $1 AND user_id = $2`,
      [input.ruleId, userId]
    );

    return { success: true };
  },
  revalidate: () => ['/recurring', '/'],
});

export const resumeRule = defineAction({
  name: 'recurring.resume',
  input: z.object({
    ruleId: z.string().uuid(),
    backfill: z.boolean().default(false),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      if (!input.backfill) {
        // Advance next_slot_index to first slot with dueDate > today
        const ruleResult = await client.query(
          `SELECT frequency, interval_n, anchor_day, start_date, end_date, next_slot_index 
           FROM recurring_rules 
           WHERE id = $1 AND user_id = $2`,
          [input.ruleId, userId]
        );

        if (ruleResult.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new NotFound('Rule not found');
        }

        const rule = ruleResult.rows[0];
        const today = new Date().toISOString().split('T')[0] as string;
        const schedule = {
          frequency: rule.frequency,
          intervalN: rule.interval_n,
          anchorDay: rule.anchor_day,
          startDate: rule.start_date,
          endDate: rule.end_date,
        };

        for (let k = rule.next_slot_index; ; k++) {
          const dueDate = dueDateForSlot(schedule, k);
          if (dueDate > today) {
            await client.query(
              'UPDATE recurring_rules SET next_slot_index = $1 WHERE id = $2 AND user_id = $3',
              [k, input.ruleId, userId]
            );
            break;
          }
        }
      }

      await client.query(
        `UPDATE recurring_rules 
         SET status = 'active', pause_reason = NULL 
         WHERE id = $1 AND user_id = $2`,
        [input.ruleId, userId]
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
  revalidate: () => ['/recurring', '/'],
});

export const endRule = defineAction({
  name: 'recurring.end',
  input: z.object({
    ruleId: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    await pool.query(
      `UPDATE recurring_rules SET status = 'ended' WHERE id = $1 AND user_id = $2`,
      [input.ruleId, userId]
    );

    return { success: true };
  },
  revalidate: () => ['/recurring', '/'],
});

export const skipOccurrence = defineAction({
  name: 'recurring.skipOccurrence',
  input: z.object({
    occurrenceId: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    await pool.query(
      `UPDATE recurring_occurrences 
       SET status = 'skipped', note = 'Skipped by user' 
       WHERE id = $1 AND user_id = $2`,
      [input.occurrenceId, userId]
    );

    return { success: true };
  },
  revalidate: () => ['/recurring', '/'],
});

export const retryOccurrence = defineAction({
  name: 'recurring.retryOccurrence',
  input: z.object({
    occurrenceId: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load occurrence with rule
      const occResult = await client.query(
        `SELECT ro.id, ro.rule_id, ro.slot_index, ro.due_date,
                rr.type, rr.amount_paisa, rr.envelope_id, rr.category_id, rr.split_template
         FROM recurring_occurrences ro
         JOIN recurring_rules rr ON rr.id = ro.rule_id
         WHERE ro.id = $1 AND ro.user_id = $2 AND ro.status = 'needs_attention'`,
        [input.occurrenceId, userId]
      );

      if (occResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Occurrence not found or not in needs_attention state');
      }

      const occ = occResult.rows[0];
      const txId = uuidv7();

      // Create transaction based on rule type
      if (occ.type === 'expense') {
        await client.query(
          `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, category_id, is_generated, recurring_id, version)
           VALUES ($1, $2, 'expense', $3, $4, '12:00:00', $5, $6, true, $7, 1)`,
          [txId, userId, occ.amount_paisa, occ.due_date, occ.envelope_id, occ.category_id, occ.rule_id]
        );
      } else {
        // Income with splits
        await client.query(
          `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, category_id, is_generated, recurring_id, version)
           VALUES ($1, $2, 'income', $3, $4, '00:01:00', $5, true, $6, 1)`,
          [txId, userId, occ.amount_paisa, occ.due_date, occ.category_id, occ.rule_id]
        );

        // Create splits
        if (occ.split_template) {
          const splits = JSON.parse(occ.split_template);
          for (const split of splits) {
            await client.query(
              `INSERT INTO transaction_splits (id, user_id, transaction_id, envelope_id, amount_paisa)
               VALUES ($1, $2, $3, $4, $5)`,
              [uuidv7(), userId, txId, split.envelopeId, split.amount]
            );
          }
        }
      }

      // Update occurrence
      await client.query(
        `UPDATE recurring_occurrences 
         SET status = 'generated', transaction_id = $1, note = NULL 
         WHERE id = $2 AND user_id = $3`,
        [txId, input.occurrenceId, userId]
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
  revalidate: () => ['/recurring', '/'],
});
