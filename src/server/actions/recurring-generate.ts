/**
 * Recurring generation algorithm - TD-07 §5
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { withUserWrite } from '@/server/db/withUserWrite';
import { uuidv7 } from 'uuidv7';
import { dueDateForSlot, slotsDue } from '@/domain/recurrence';
import { ValidationError, NotFound } from '@/domain/errors';

/**
 * Generate recurring transactions for a user
 * Idempotent, order-correct, all inside one withUserWrite
 */
export const generateForUser = defineAction({
  name: 'recurring.generate',
  input: z.object({}), // No input needed
  async run(ctx, _input) {
    const { userId } = await requireUser();

    return withUserWrite(userId, async (pool) => {
      const client = await pool.connect();
      const today = new Date().toISOString().split('T')[0] as string;
      let generatedCount = 0;
      let needsAttentionCount = 0;

      try {
        await client.query('BEGIN');

        // Load active rules
        const rulesResult = await client.query(
          `SELECT id, name, type, amount_paisa, envelope_id, category_id, split_template,
                  frequency, interval_n, anchor_day, start_date, end_date, max_occurrences,
                  next_slot_index, is_committee, created_at
           FROM recurring_rules
           WHERE user_id = $1 AND status = 'active'
           ORDER BY created_at`,
          [userId]
        );

        const candidates: Array<{
          ruleId: string;
          slotIndex: number;
          dueDate: string;
          type: string;
          amountPaisa: string;
          envelopeId: string | null;
          categoryId: string;
          splitTemplate: string | null;
          createdAt: string;
        }> = [];

        // Collect slots due for each rule
        for (const rule of rulesResult.rows) {
          const schedule = {
            frequency: rule.frequency,
            intervalN: rule.interval_n,
            anchorDay: rule.anchor_day,
            startDate: rule.start_date,
            endDate: rule.end_date,
          };

          // Calculate budget remaining
          let budgetRemaining: number | null = null;
          if (rule.max_occurrences) {
            const countedResult = await client.query(
              `SELECT COUNT(*) as count FROM recurring_occurrences 
               WHERE rule_id = $1 AND status IN ('generated', 'needs_attention')`,
              [rule.id]
            );
            const counted = parseInt(countedResult.rows[0].count);
            budgetRemaining = rule.max_occurrences - counted;
          }

          const dueSlots = slotsDue(schedule, rule.next_slot_index, today, budgetRemaining, 24);

          for (const slot of dueSlots) {
            candidates.push({
              ruleId: rule.id,
              slotIndex: slot.slotIndex,
              dueDate: slot.dueDate,
              type: rule.type,
              amountPaisa: rule.amount_paisa,
              envelopeId: rule.envelope_id,
              categoryId: rule.category_id,
              splitTemplate: rule.split_template,
              createdAt: rule.created_at,
            });
          }
        }

        // Sort globally by (dueDate, type: income first, rule.created_at, slotIndex)
        candidates.sort((a, b) => {
          if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
          if (a.type !== b.type) return a.type === 'income' ? -1 : 1;
          if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
          return a.slotIndex - b.slotIndex;
        });

        // Process each candidate
        for (const candidate of candidates) {
          // Insert occurrence (skip if already exists)
          const occResult = await client.query(
            `INSERT INTO recurring_occurrences (id, user_id, rule_id, slot_index, due_date, status)
             VALUES ($1, $2, $3, $4, $5, 'needs_attention')
             ON CONFLICT (rule_id, due_date) DO NOTHING RETURNING id`,
            [uuidv7(), userId, candidate.ruleId, candidate.slotIndex, candidate.dueDate]
          );

          if (occResult.rows.length === 0) {
            // Already exists, skip
            continue;
          }

          const occurrenceId = occResult.rows[0].id;

          // Try to create transaction with savepoint
          try {
            await client.query('SAVEPOINT s');

            const txId = uuidv7();

            if (candidate.type === 'expense') {
              await client.query(
                `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, category_id, is_generated, recurring_id, version)
                 VALUES ($1, $2, 'expense', $3, $4, '12:00:00', $5, $6, true, $7, 1)`,
                [txId, userId, candidate.amountPaisa, candidate.dueDate, candidate.envelopeId, candidate.categoryId, candidate.ruleId]
              );
            } else {
              // Income with splits
              await client.query(
                `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, category_id, is_generated, recurring_id, version)
                 VALUES ($1, $2, 'income', $3, $4, '00:01:00', $5, true, $6, 1)`,
                [txId, userId, candidate.amountPaisa, candidate.dueDate, candidate.categoryId, candidate.ruleId]
              );

              // Create splits
              if (candidate.splitTemplate) {
                const splits = JSON.parse(candidate.splitTemplate);
                for (const split of splits) {
                  await client.query(
                    `INSERT INTO transaction_splits (id, user_id, transaction_id, envelope_id, amount_paisa)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [uuidv7(), userId, txId, split.envelopeId, split.amount]
                  );
                }
              }
            }

            await client.query('RELEASE s');

            // Success - mark as generated
            await client.query(
              `UPDATE recurring_occurrences 
               SET status = 'generated', transaction_id = $1 
               WHERE id = $2 AND user_id = $3`,
              [txId, occurrenceId, userId]
            );

            generatedCount++;
          } catch (error) {
            await client.query('ROLLBACK TO s');

            // Mark as needs_attention
            await client.query(
              `UPDATE recurring_occurrences 
               SET note = 'Insufficient funds or validation error' 
               WHERE id = $1 AND user_id = $2`,
              [occurrenceId, userId]
            );

            needsAttentionCount++;
          }
        }

        // Advance next_slot_index for processed rules
        for (const candidate of candidates) {
          await client.query(
            `UPDATE recurring_rules 
             SET next_slot_index = GREATEST(next_slot_index, $1 + 1) 
             WHERE id = $2 AND user_id = $3`,
            [candidate.slotIndex, candidate.ruleId, userId]
          );
        }

        // Check for completion
        for (const rule of rulesResult.rows) {
          if (rule.max_occurrences || rule.end_date) {
            const countedResult = await client.query(
              `SELECT COUNT(*) as count FROM recurring_occurrences 
               WHERE rule_id = $1 AND status IN ('generated', 'needs_attention')`,
              [rule.id]
            );
            const counted = parseInt(countedResult.rows[0].count);

            if (rule.max_occurrences && counted >= rule.max_occurrences) {
              await client.query(
                `UPDATE recurring_rules SET status = 'completed' WHERE id = $1 AND user_id = $2`,
                [rule.id, userId]
              );
            }

            if (rule.end_date) {
              const endDate = new Date(rule.end_date);
              if (endDate < new Date(today)) {
                await client.query(
                  `UPDATE recurring_rules SET status = 'ended' WHERE id = $1 AND user_id = $2`,
                  [rule.id, userId]
                );
              }
            }
          }
        }

        await client.query('COMMIT');

        return {
          generated: generatedCount,
          needsAttention: needsAttentionCount,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  },
  revalidate: () => ['/recurring', '/'],
});

/**
 * Lazy sync for client-side trigger
 */
/**
 * Lazy sync for the client-side trigger (TD-07 §5.2). Same action: calling
 * generateForUser from inside another action would re-take the per-user
 * advisory lock on a second connection and deadlock.
 */
export const syncRecurring = generateForUser;
