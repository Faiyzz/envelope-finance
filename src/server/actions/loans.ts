/**
 * Loan actions - TD-06 §3
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { uuidv7 } from 'uuidv7';
import { ValidationError, NotFound, Conflict, RuleViolation } from '@/domain/errors';
import type { Paisa } from '@/domain/money';
import { validateLoanInput, remaining, allocateRepayAll } from '@/domain/loans';

const CreateLoanSchema = z.object({
  idempotencyKey: z.string().uuid(),
  lenderEnvelopeId: z.string().uuid(),
  borrowerEnvelopeId: z.string().uuid(),
  amount: z.string(),
  date: z.string().optional(),
  note: z.string().max(500).optional(),
});

export const createLoan = defineAction({
  name: 'loans.create',
  input: CreateLoanSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Validate envelopes exist, are active, and are 'mine'
      const envsResult = await client.query(
        `SELECT id, name, owner_type FROM envelopes 
         WHERE id IN ($1, $2) AND user_id = $3 AND status = 'active'`,
        [input.lenderEnvelopeId, input.borrowerEnvelopeId, userId]
      );

      if (envsResult.rows.length !== 2) {
        await client.query('ROLLBACK');
        throw new NotFound('One or both envelopes not found');
      }

      const lender = envsResult.rows.find((r: any) => r.id === input.lenderEnvelopeId);
      const borrower = envsResult.rows.find((r: any) => r.id === input.borrowerEnvelopeId);

      if (lender.owner_type !== 'mine' || borrower.owner_type !== 'mine') {
        await client.query('ROLLBACK');
        throw new ValidationError({ lenderEnvelopeId: 'Money held for others can\'t be lent out' });
      }

      const date = (input.date || new Date().toISOString().split('T')[0]) as string;
      const amountPaisa = BigInt(input.amount) as Paisa;

      // Validate loan input
      const validation = validateLoanInput({
        lenderEnvelopeId: input.lenderEnvelopeId,
        borrowerEnvelopeId: input.borrowerEnvelopeId,
        amount: amountPaisa,
        date,
      });

      if (!validation.ok) {
        await client.query('ROLLBACK');
        throw new ValidationError({ _loan: validation.error });
      }

      // Insert loan row
      const loanId = uuidv7();
      await client.query(
        `INSERT INTO loans (id, user_id, lender_envelope_id, borrower_envelope_id, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [loanId, userId, input.lenderEnvelopeId, input.borrowerEnvelopeId, input.note || null]
      );

      // Insert loan transaction (lender -A, borrower +A)
      const txId = uuidv7();
      await client.query(
        `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, counterpart_envelope_id, loan_id, note, version)
         VALUES ($1, $2, 'loan', $3, $4, '00:00:00', $5, $6, $7, $8, 1)`,
        [txId, userId, amountPaisa.toString(), date, input.lenderEnvelopeId, input.borrowerEnvelopeId, loanId, input.note || null]
      );

      await client.query('COMMIT');

      return {
        loan: { id: loanId },
        effects: [
          { envelope: lender.name, delta: `-${input.amount}` },
          { envelope: borrower.name, delta: `+${input.amount}` },
        ],
        totalUnchanged: true,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/loans', '/'],
});

const RepayLoanSchema = z.object({
  idempotencyKey: z.string().uuid(),
  loanId: z.string().uuid(),
  amount: z.string(),
  date: z.string().optional(),
});

export const repayLoan = defineAction({
  name: 'loans.repay',
  input: RepayLoanSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load loan state
      const loanResult = await client.query(
        `SELECT ls.*, o.occurred_on as loan_date 
         FROM loan_state ls
         JOIN transactions o ON o.id = ls.origin_tx_id
         WHERE ls.loan_id = $1 AND ls.user_id = $2`,
        [input.loanId, userId]
      );

      if (loanResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Loan not found');
      }

      const loan = loanResult.rows[0];
      const amountPaisa = BigInt(input.amount);
      const date = input.date || new Date().toISOString().split('T')[0];

      // Validate amount ≤ remaining
      if (amountPaisa > BigInt(loan.remaining_paisa)) {
        await client.query('ROLLBACK');
        throw new ValidationError({ amount: `Only ${loan.remaining_paisa} is still owed on this loan` });
      }

      // Validate date ≥ loan_date and ≤ today
      const loanDate = new Date(loan.loan_date);
      const repaymentDate = new Date(date as string);
      const today = new Date();

      if (repaymentDate < loanDate) {
        await client.query('ROLLBACK');
        throw new ValidationError({ date: 'Repayment date cannot be before loan date' });
      }

      if (repaymentDate > today) {
        await client.query('ROLLBACK');
        throw new ValidationError({ date: 'Repayment date cannot be in the future' });
      }

      // Insert loan_repayment transaction (borrower -A, lender +A)
      const txId = uuidv7();
      await client.query(
        `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, counterpart_envelope_id, loan_id, version)
         VALUES ($1, $2, 'loan_repayment', $3, $4, '00:00:00', $5, $6, $7, 1)`,
        [txId, userId, amountPaisa.toString(), date, loan.borrower_envelope_id, loan.lender_envelope_id, input.loanId]
      );

      await client.query('COMMIT');

      // Check if loan is now settled
      const newRemaining = BigInt(loan.remaining_paisa) - amountPaisa;
      const settled = newRemaining === 0n;

      return { success: true, settled };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/loans', '/'],
});

const RepayAllSchema = z.object({
  idempotencyKey: z.string().uuid(),
  borrowerEnvelopeId: z.string().uuid(),
  lenderEnvelopeId: z.string().uuid(),
  date: z.string().optional(),
});

export const repayAll = defineAction({
  name: 'loans.repayAll',
  input: RepayAllSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load active loans for this ordered pair
      const loansResult = await client.query(
        `SELECT ls.loan_id, ls.loan_date, ls.remaining_paisa, e.balance_paisa
         FROM loan_state ls
         JOIN envelope_balances e ON e.user_id = ls.user_id AND e.envelope_id = ls.borrower_envelope_id
         WHERE ls.user_id = $1 
           AND ls.lender_envelope_id = $2 
           AND ls.borrower_envelope_id = $3 
           AND ls.status = 'active'
         ORDER BY ls.loan_date, ls.created_at`,
        [userId, input.lenderEnvelopeId, input.borrowerEnvelopeId]
      );

      if (loansResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: true, repayments: [] };
      }

      const borrowerBalance = BigInt(loansResult.rows[0].balance_paisa);

      if (borrowerBalance <= 0n) {
        await client.query('ROLLBACK');
        throw new ValidationError({ amount: 'Borrower has no balance to repay with' });
      }

      // Allocate repayments
      const loans = loansResult.rows.map((r: any) => ({
        id: r.loan_id,
        loanDate: String(r.loan_date).slice(0, 10),
        remaining: BigInt(r.remaining_paisa) as Paisa,
      }));

      const allocations = allocateRepayAll(loans, borrowerBalance as Paisa);
      const date = input.date || new Date().toISOString().split('T')[0];

      // Insert repayments
      const repaymentBreakdown: Array<{ loanId: string; amount: string }> = [];

      for (const alloc of allocations) {
        const txId = uuidv7();
        await client.query(
          `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, counterpart_envelope_id, loan_id, version)
           VALUES ($1, $2, 'loan_repayment', $3, $4, '00:00:00', $5, $6, $7, 1)`,
          [txId, userId, alloc.amount.toString(), date, input.borrowerEnvelopeId, input.lenderEnvelopeId, alloc.loanId]
        );
        repaymentBreakdown.push({ loanId: alloc.loanId, amount: alloc.amount.toString() });
      }

      await client.query('COMMIT');

      return { success: true, repayments: repaymentBreakdown };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/loans', '/'],
});

const UpdateLoanSchema = z.object({
  loanId: z.string().uuid(),
  version: z.number(),
  note: z.string().max(500).optional(),
  date: z.string().optional(),
  amount: z.string().optional(),
  lenderEnvelopeId: z.string().uuid().optional(),
  borrowerEnvelopeId: z.string().uuid().optional(),
});

export const updateLoan = defineAction({
  name: 'loans.update',
  input: UpdateLoanSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load loan with origin tx
      const loanResult = await client.query(
        `SELECT l.id, l.lender_envelope_id, l.borrower_envelope_id, l.note,
                o.id as origin_tx_id, o.version as tx_version, o.amount_paisa, o.occurred_on
         FROM loans l
         JOIN transactions o ON o.loan_id = l.id AND o.type = 'loan' AND o.deleted_at IS NULL
         WHERE l.id = $1 AND l.user_id = $2 AND l.deleted_at IS NULL`,
        [input.loanId, userId]
      );

      if (loanResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Loan not found');
      }

      const loan = loanResult.rows[0];

      // Version check (origin tx version)
      if (loan.tx_version !== input.version) {
        await client.query('ROLLBACK');
        throw new Conflict('This was changed on another device. Reload to see the latest.');
      }

      // Check if loan has repayments when changing lender/borrower
      if (input.lenderEnvelopeId || input.borrowerEnvelopeId) {
        const repaymentCheck = await client.query(
          `SELECT COUNT(*) as count FROM transactions 
           WHERE loan_id = $1 AND type = 'loan_repayment' AND deleted_at IS NULL`,
          [input.loanId]
        );

        if (parseInt(repaymentCheck.rows[0].count) > 0) {
          await client.query('ROLLBACK');
          throw new RuleViolation('Cannot change lender/borrower when loan has repayments');
        }
      }

      // Update loan note
      if (input.note !== undefined) {
        await client.query(
          'UPDATE loans SET note = $1 WHERE id = $2 AND user_id = $3',
          [input.note, input.loanId, userId]
        );
      }

      // Update origin tx
      const txUpdates: string[] = [];
      const txValues: any[] = [];
      let paramIndex = 1;

      if (input.date !== undefined) {
        txUpdates.push(`occurred_on = $${paramIndex++}`);
        txValues.push(input.date);
      }
      if (input.amount !== undefined) {
        txUpdates.push(`amount_paisa = $${paramIndex++}`);
        txValues.push(input.amount);
      }
      if (input.lenderEnvelopeId !== undefined) {
        txUpdates.push(`envelope_id = $${paramIndex++}`);
        txValues.push(input.lenderEnvelopeId);
      }
      if (input.borrowerEnvelopeId !== undefined) {
        txUpdates.push(`counterpart_envelope_id = $${paramIndex++}`);
        txValues.push(input.borrowerEnvelopeId);
      }

      if (txUpdates.length > 0) {
        txValues.push(loan.origin_tx_id, userId);
        await client.query(
          `UPDATE transactions SET ${txUpdates.join(', ')} WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}`,
          txValues
        );
      }

      await client.query('COMMIT');

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/loans', '/'],
});

export const deleteLoan = defineAction({
  name: 'loans.delete',
  input: z.object({
    loanId: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if loan has repayments
      const repaymentCheck = await client.query(
        `SELECT COUNT(*) as count FROM transactions 
         WHERE loan_id = $1 AND type = 'loan_repayment' AND deleted_at IS NULL`,
        [input.loanId]
      );

      if (parseInt(repaymentCheck.rows[0].count) > 0) {
        await client.query('ROLLBACK');
        throw new RuleViolation('This loan has repayments. Delete those first.');
      }

      // Load origin tx
      const txResult = await client.query(
        `SELECT id FROM transactions 
         WHERE loan_id = $1 AND type = 'loan' AND deleted_at IS NULL`,
        [input.loanId]
      );

      if (txResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Loan not found');
      }

      const originTxId = txResult.rows[0].id;

      // Soft delete loan row
      await client.query(
        `UPDATE loans SET deleted_at = now() WHERE id = $1 AND user_id = $2`,
        [input.loanId, userId]
      );

      // Soft delete origin tx
      await client.query(
        `UPDATE transactions SET deleted_at = now(), deleted_by = $1 WHERE id = $2 AND user_id = $3`,
        [userId, originTxId, userId]
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
  revalidate: () => ['/loans', '/'],
});

export const restoreLoan = defineAction({
  name: 'loans.restore',
  input: z.object({
    loanId: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Restore loan row
      await client.query(
        `UPDATE loans SET deleted_at = NULL WHERE id = $1 AND user_id = $2`,
        [input.loanId, userId]
      );

      // Restore origin tx
      await client.query(
        `UPDATE transactions SET deleted_at = NULL, deleted_by = NULL 
         WHERE loan_id = $1 AND type = 'loan' AND user_id = $2`,
        [input.loanId, userId]
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
  revalidate: () => ['/loans', '/'],
});
