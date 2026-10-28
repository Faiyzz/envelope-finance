'use server';

/**
 * Single, allow-listed entry point for UI-driven mutations. Every action
 * validates its own input (zod) and derives the user from the session.
 */

import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import type { ActionResult } from '@/domain/errors';
import { createEnvelope, archiveEnvelope, unarchiveEnvelope } from '@/server/actions/envelopes';
import { allocate, deallocate, transfer } from '@/server/actions/allocations';
import { createIncome, deleteTransaction } from '@/server/actions/transactions';
import { restoreTransaction } from '@/server/actions/recently-deleted';
import { createLoan, repayLoan, repayAll, deleteLoan } from '@/server/actions/loans';
import { recordHeldMoney, returnHeldMoney } from '@/server/actions/held-money';
import { createRule, createCommittee, pauseRule, resumeRule, endRule, skipOccurrence, retryOccurrence } from '@/server/actions/recurring';
import { previewReconciliation, saveReconciliation } from '@/server/actions/reconciliation';
import { completeOnboarding, skipOnboarding } from '@/server/actions/onboarding';

const ACTIONS = {
  createEnvelope, archiveEnvelope, unarchiveEnvelope,
  allocate, deallocate, transfer,
  createIncome, deleteTransaction, restoreTransaction,
  createLoan, repayLoan, repayAll, deleteLoan,
  recordHeldMoney, returnHeldMoney,
  createRule, createCommittee, pauseRule, resumeRule, endRule, skipOccurrence, retryOccurrence,
  previewReconciliation, saveReconciliation,
  completeOnboarding, skipOnboarding,
} as const;

export type ActionName = keyof typeof ACTIONS;

export async function runAction(name: ActionName, input: unknown): Promise<ActionResult<any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const action = ACTIONS[name] as ((i: unknown) => Promise<ActionResult<unknown>>) | undefined;
  if (!action) return { ok: false, error: { code: 'VALIDATION', message: 'Unknown action.' } };
  return action(input);
}

export interface FormOptions {
  envelopes: Array<{ id: string; name: string; icon: string; ownerType: 'mine' | 'other'; balance: string }>;
  incomeCategories: Array<{ id: string; name: string }>;
  expenseCategories: Array<{ id: string; name: string }>;
  loans: Array<{ id: string; label: string; remaining: string }>;
}

export async function loadFormOptions(): Promise<ActionResult<FormOptions>> {
  try {
    const { userId } = await requireUser();
    const pool = getPool();
    const [envs, cats, loans] = await Promise.all([
      pool.query(
        `SELECT e.id, e.name, e.icon, e.owner_type, COALESCE(eb.balance_paisa, 0)::text AS balance
         FROM envelopes e LEFT JOIN envelope_balances eb ON eb.user_id = e.user_id AND eb.envelope_id = e.id
         WHERE e.user_id = $1 AND e.status = 'active'
         ORDER BY (e.owner_type = 'mine') DESC, e.sort_order`,
        [userId]
      ),
      pool.query(`SELECT id, name, kind FROM categories WHERE user_id = $1 AND status = 'active' ORDER BY name`, [userId]),
      pool.query(
        `SELECT ls.loan_id AS id, le.name AS lender, be.name AS borrower, ls.remaining_paisa::text AS remaining
         FROM loan_state ls
         JOIN envelopes le ON le.id = ls.lender_envelope_id
         JOIN envelopes be ON be.id = ls.borrower_envelope_id
         WHERE ls.user_id = $1 AND ls.status = 'active' ORDER BY ls.loan_date DESC`,
        [userId]
      ),
    ]);
    return {
      ok: true,
      data: {
        envelopes: envs.rows.map((r) => ({ id: r.id, name: r.name, icon: r.icon, ownerType: r.owner_type, balance: r.balance })),
        incomeCategories: cats.rows.filter((c) => c.kind === 'income').map((c) => ({ id: c.id, name: c.name })),
        expenseCategories: cats.rows.filter((c) => c.kind === 'expense').map((c) => ({ id: c.id, name: c.name })),
        loans: loans.rows.map((r) => ({ id: r.id, label: `${r.borrower} → ${r.lender}`, remaining: r.remaining })),
      },
    };
  } catch {
    return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.' } };
  }
}
