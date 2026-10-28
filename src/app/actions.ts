'use server';

/**
 * Server Actions used by the app shell / quick-add (TD-10).
 *
 * Thin glue: derive everything user-specific from the session (never from
 * input), resolve defaults (time, Uncategorized), then delegate to the domain
 * actions in server/actions. Money crosses as paisa strings.
 */

import { z } from 'zod';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { getQuickAddData, type QuickAddData } from '@/server/queries/quick-add';
import { createExpense, deleteTransaction } from '@/server/actions/transactions';
import { todayIn, defaultTimeFor, parseLocalDate, type LocalDate } from '@/domain/dates';
import type { ActionResult } from '@/domain/errors';
import { revokeSession } from '@/server/auth/session';
import { signOut } from '@/server/auth/config';

export async function loadQuickAdd(): Promise<ActionResult<QuickAddData>> {
  try {
    const { userId, user } = await requireUser();
    return { ok: true, data: await getQuickAddData(userId, user.timezone) };
  } catch {
    return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.' } };
  }
}

const ExpenseInput = z
  .object({
    idempotencyKey: z.string().uuid(),
    amount: z.string().regex(/^\d{1,11}$/), // integer paisa
    envelopeId: z.string().uuid(),
    categoryId: z.string().uuid().nullable(),
    note: z.string().max(500).optional(),
    date: z.string().optional(),
    confirmDuplicate: z.boolean().optional(),
  })
  .strict();

export type ExpenseInputT = z.infer<typeof ExpenseInput>;

export async function submitExpense(raw: ExpenseInputT): Promise<ActionResult<{ id: string; onBehalfOf: string | null }>> {
  const parsed = ExpenseInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: { code: 'VALIDATION', message: 'Check the amount and try again.' } };
  }
  const input = parsed.data;

  let userId: string;
  let tz: string;
  try {
    const u = await requireUser();
    userId = u.userId;
    tz = u.user.timezone;
  } catch {
    return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.' } };
  }

  const now = Date.now();
  const today = todayIn(tz, now);
  const date = (input.date ? parseLocalDate(input.date) : today) as LocalDate | null;
  if (!date) return { ok: false, error: { code: 'VALIDATION', message: 'Invalid date.', fieldErrors: { date: 'Invalid date.' } } };
  if (date > today) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: "You can't record a transaction in the future. Use a recurring transaction for upcoming payments.",
        fieldErrors: { date: 'future' },
      },
    };
  }

  // Missing category -> the system "Uncategorized" expense category (FR-CAT-06)
  let categoryId = input.categoryId;
  if (!categoryId) {
    const pool = getPool() as unknown as { query: (s: string, p?: unknown[]) => Promise<{ rows: Array<{ id: string }> }> };
    const r = await pool.query(
      `SELECT id FROM categories WHERE user_id = $1 AND kind = 'expense' AND is_system LIMIT 1`,
      [userId]
    );
    categoryId = r.rows[0]?.id ?? null;
  }

  const res = await createExpense({
    idempotencyKey: input.idempotencyKey,
    amount: input.amount,
    envelopeId: input.envelopeId,
    categoryId: categoryId ?? undefined,
    note: input.note?.trim() || undefined,
    date,
    time: defaultTimeFor(date, today, tz, now),
    confirmDuplicate: input.confirmDuplicate,
  });

  if (!res.ok) {
    // Normalise the duplicate guard into its dedicated soft error (TD-05 §2)
    if (res.error.fieldErrors?._duplicate) {
      return { ok: false, error: { code: 'DUPLICATE_SUSPECTED', message: res.error.fieldErrors._duplicate } };
    }
    return res;
  }
  return { ok: true, data: { id: res.data.transaction.id, onBehalfOf: res.data.onBehalfOf ?? null } };
}

export async function undoTransaction(id: string): Promise<ActionResult<{ success: true }>> {
  if (!z.string().uuid().safeParse(id).success) {
    return { ok: false, error: { code: 'VALIDATION', message: 'Invalid transaction.' } };
  }
  const res = await deleteTransaction({ id });
  return res as ActionResult<{ success: true }>;
}

/**
 * Revoke the current session, then sign out. The client has already purged
 * local snapshots/caches (purgeLocalData); `loggedout=1` makes middleware add
 * Clear-Site-Data as a backstop (TD-12 §7).
 */
export async function logoutAction(): Promise<void> {
  try {
    const { sid } = await requireUser();
    await revokeSession(sid);
  } catch {
    /* already signed out */
  }
  await signOut({ redirectTo: '/login?loggedout=1' });
}
