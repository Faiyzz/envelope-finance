/**
 * Reconciliation actions - TD-08 §4
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { withUserWrite } from '@/server/db/withUserWrite';
import { uuidv7 } from 'uuidv7';
import { ValidationError, NotFound, RuleViolation } from '@/domain/errors';
import { reconciliationStatus } from '@/domain/reconciliation';

const PreviewReconciliationSchema = z.object({
  actual: z.string(),
});

export const previewReconciliation = defineAction({
  name: 'reconciliation.preview',
  input: PreviewReconciliationSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    // Get current expected balance from ledger_totals
    const totalsResult = await pool.query(
      `SELECT total_paisa FROM ledger_totals WHERE user_id = $1`,
      [userId]
    );

    if (totalsResult.rows.length === 0) {
      throw new Error('Ledger totals not found');
    }

    const expected = BigInt(totalsResult.rows[0].total_paisa);
    const actual = BigInt(input.actual);
    const difference = actual - expected;

    // Validate actual >= 0
    if (actual < 0n) {
      throw new ValidationError({ actual: 'Negative balances aren\'t supported in V1' });
    }

    // Determine status
    let status: 'match' | 'more' | 'less';
    if (difference === 0n) {
      status = 'match';
    } else if (difference > 0n) {
      status = 'more';
    } else {
      status = 'less';
    }

    // Large mismatch warning
    const warnings: string[] = [];
    const tenPercent = expected / 10n;
    const fiftyThousand = 50000n;
    
    if (difference < 0n ? -difference > tenPercent : difference > tenPercent || difference > fiftyThousand) {
      warnings.push('LARGE_MISMATCH');
    }

    // Compute hints (SHOULD - Tier 3, placeholder for now)
    const hints: string[] = [];

    return {
      expected: expected.toString(),
      actual: actual.toString(),
      difference: difference.toString(),
      status,
      warnings,
      hints,
    };
  },
  revalidate: () => [],
});

const AdjustmentRequestSchema = z.object({
  target: z.union([
    z.literal('unallocated'),
    z.object({ envelopeId: z.string().uuid() }),
  ]),
  note: z.string().min(1).max(500),
  confirmation: z.literal(true),
});

const SaveReconciliationSchema = z.object({
  idempotencyKey: z.string().uuid(),
  actual: z.string(),
  note: z.string().max(500).optional(),
  adjustment: AdjustmentRequestSchema.optional(),
});

export const saveReconciliation = defineAction({
  name: 'reconciliation.save',
  input: SaveReconciliationSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();

    return withUserWrite(userId, async (pool) => {
      const client = await pool.connect();
      const today = new Date().toISOString().split('T')[0];

      try {
        await client.query('BEGIN');

        // Validate actual >= 0
        const actual = BigInt(input.actual);
        if (actual < 0n) {
          await client.query('ROLLBACK');
          throw new ValidationError({ actual: 'Negative balances aren\'t supported in V1' });
        }

        // Get current expected balance from ledger_totals
        const totalsResult = await client.query(
          `SELECT total_paisa FROM ledger_totals WHERE user_id = $1`,
          [userId]
        );

        if (totalsResult.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new Error('Ledger totals not found');
        }

        const expected = BigInt(totalsResult.rows[0].total_paisa);
        const difference = actual - expected;

        // Get user's ledger_revision
        const userResult = await client.query(
          `SELECT ledger_revision FROM users WHERE id = $1`,
          [userId]
        );

        if (userResult.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new NotFound('User not found');
        }

        const ledgerRevision = BigInt(userResult.rows[0].ledger_revision);

        // Compute ledger_hash for window <= today
        const hashResult = await client.query(
          `SELECT md5(COALESCE(string_agg(t.id::text || ':' || t.version, ',' ORDER BY t.occurred_on, t.occurred_at, t.created_at, t.id), '')) as hash
           FROM transactions t
           WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.occurred_on <= $2`,
          [userId, today]
        );

        const ledgerHash = hashResult.rows[0].hash;

        // Get tx_count
        const txCountResult = await client.query(
          `SELECT COUNT(*) as count FROM transactions WHERE user_id = $1 AND deleted_at IS NULL`,
          [userId]
        );
        const txCount = parseInt(txCountResult.rows[0].count);

        let adjustmentTransactionId: string | null = null;

        // If adjustment requested, create it
        if (input.adjustment) {
          const amount = difference; // Signed: actual - expected
          const envelopeId = input.adjustment.target === 'unallocated' 
            ? null 
            : (input.adjustment.target as any).envelopeId;

          // Validate envelope exists if specified
          if (envelopeId) {
            const envResult = await client.query(
              `SELECT id, owner_type FROM envelopes WHERE id = $1 AND user_id = $2`,
              [envelopeId, userId]
            );

            if (envResult.rows.length === 0) {
              await client.query('ROLLBACK');
              throw new NotFound('Envelope not found');
            }
          }

          // Create adjustment transaction
          const txId = uuidv7();
          await client.query(
            `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, note, version)
             VALUES ($1, $2, 'adjustment', $3, $4, now(), $5, $6, 1)`,
            [txId, userId, amount.toString(), today, envelopeId, input.adjustment.note]
          );

          adjustmentTransactionId = txId;

          // Recompute ledger_revision and hash after adjustment
          const userAfterResult = await client.query(
            `SELECT ledger_revision FROM users WHERE id = $1`,
            [userId]
          );
          const ledgerRevisionAfter = BigInt(userAfterResult.rows[0].ledger_revision);

          const hashAfterResult = await client.query(
            `SELECT md5(COALESCE(string_agg(t.id::text || ':' || t.version, ',' ORDER BY t.occurred_on, t.occurred_at, t.created_at, t.id), '')) as hash
             FROM transactions t
             WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.occurred_on <= $2`,
            [userId, today]
          );

          // Use post-adjustment values
          // Note: expected_paisa and difference_paisa keep pre-adjustment values
        }

        // Insert reconciliation row
        const reconId = uuidv7();
        await client.query(
          `INSERT INTO reconciliations 
           (id, user_id, checked_at, checked_on, expected_paisa, actual_paisa, difference_paisa, 
            note, adjustment_transaction_id, tx_count_at_check, ledger_revision, ledger_hash)
           VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            reconId,
            userId,
            today,
            expected.toString(),
            actual.toString(),
            difference.toString(),
            input.note || null,
            adjustmentTransactionId,
            txCount,
            ledgerRevision.toString(),
            ledgerHash,
          ]
        );

        await client.query('COMMIT');

        // Compute status for response
        const statusResult = reconciliationStatus({
          latest: {
            checkedAt: new Date().toISOString(),
            checkedOn: today as string,
            actual,
            difference,
            ledgerRevision,
          },
          currentExpected: input.adjustment ? actual : expected,
          currentRevision: ledgerRevision,
          changeCountSince: 0,
          now: new Date().toISOString(),
        });

        return {
          reconciliation: { id: reconId },
          status: statusResult.status,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  },
  revalidate: () => ['/reconciliation', '/'],
});

export const updateReconciliationNote = defineAction({
  name: 'reconciliation.updateNote',
  input: z.object({
    id: z.string().uuid(),
    note: z.string().max(500),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    await pool.query(
      `UPDATE reconciliations SET note = $1 WHERE id = $2 AND user_id = $3`,
      [input.note, input.id, userId]
    );

    return { success: true };
  },
  revalidate: () => ['/reconciliation'],
});

export const deleteReconciliation = defineAction({
  name: 'reconciliation.delete',
  input: z.object({
    id: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    await pool.query(
      `UPDATE reconciliations SET deleted_at = now() WHERE id = $1 AND user_id = $2`,
      [input.id, userId]
    );

    return { success: true };
  },
  revalidate: () => ['/reconciliation'],
});
