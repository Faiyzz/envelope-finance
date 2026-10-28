/**
 * Transaction actions - TD-05 §1-§4.
 *
 * All writes run on `ctx.tx` inside the per-user lock; envelopes touched by
 * the change are registered with `ctx.touch` and the pipeline then verifies the
 * whole timeline (apply -> verify -> rollback), so a transaction can never leave
 * any envelope or Unallocated negative at ANY point in time (INV-2/3/10).
 */

import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { defineAction, type WriteCtx } from '@/server/actions/pipeline';
import { Conflict, DuplicateSuspected, NotFound, RuleViolation, ValidationError } from '@/domain/errors';
import { assertDateAllowed, MIN_DATE, parseLocalDate, todayIn, defaultTimeFor, parseLocalTime, type LocalDate } from '@/domain/dates';
import { MAX_PAISA } from '@/domain/money';
import type { Tx } from '@/server/db/withUserWrite';
import { verifyTimeline } from '@/server/backup/verify';
import { violationToError } from '@/server/db/violation';

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

const Paisa = z.string().regex(/^\d{1,11}$/, 'Enter a valid amount').refine((v) => BigInt(v) >= 1n && BigInt(v) <= MAX_PAISA, 'Amount is out of range');
const Note = z.string().max(500).optional();
const DateStr = z.string().optional();
const TimeStr = z.string().optional();

/** strip control characters except \n and \t (FR-TXN-08) */
const cleanNote = (s?: string) => (s === undefined ? null : s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim() || null);

interface Env {
  id: string;
  name: string;
  owner_type: 'mine' | 'other';
  owner_name: string | null;
  status: 'active' | 'archived';
}

async function loadEnvelope(tx: Tx, userId: string, id: string, opts: { requireActive: boolean } = { requireActive: true }): Promise<Env> {
  const r = await tx.query(`SELECT id, name, owner_type, owner_name, status FROM envelopes WHERE id = $1 AND user_id = $2`, [id, userId]);
  const env = r.rows[0] as Env | undefined;
  if (!env) throw new NotFound('Envelope', id);
  if (opts.requireActive && env.status !== 'active') throw new RuleViolation('ARCHIVED_ENVELOPE', { message: `${env.name} is archived. Unarchive it to add transactions.` });
  return env;
}

async function dateAndTime(tx: Tx, userId: string, date?: string, time?: string) {
  const tz = String((await tx.query(`SELECT timezone FROM users WHERE id = $1`, [userId])).rows[0]?.timezone ?? 'Asia/Karachi');
  const now = Date.now();
  const today = todayIn(tz, now);
  const d = (date ? parseLocalDate(date) : today) as LocalDate | null;
  if (!d) throw new ValidationError({ date: 'Enter a valid date.' });
  try {
    assertDateAllowed(d, today);
  } catch (e) {
    const code = e instanceof Error ? e.message : '';
    throw new ValidationError({
      date: code === 'DATE_IN_FUTURE'
        ? "You can't record a transaction in the future. Use a recurring transaction for upcoming payments."
        : `Dates before ${MIN_DATE} aren't supported.`,
    });
  }
  const t = time ? parseLocalTime(time) : defaultTimeFor(d, today, tz, now);
  if (!t) throw new ValidationError({ time: 'Enter a valid time.' });
  return { date: d as string, time: t as string, today };
}

async function resolveCategory(tx: Tx, userId: string, kind: 'expense' | 'income', id?: string | null): Promise<string> {
  if (!id) {
    const r = await tx.query(`SELECT id FROM categories WHERE user_id = $1 AND kind = $2 AND is_system LIMIT 1`, [userId, kind]);
    if (!r.rows[0]) throw new ValidationError({ categoryId: 'Choose a category.' });
    return r.rows[0].id as string;
  }
  const r = await tx.query(`SELECT id, kind, status FROM categories WHERE id = $1 AND user_id = $2`, [id, userId]);
  const c = r.rows[0];
  if (!c) throw new NotFound('Category', id);
  if (c.kind !== kind) throw new ValidationError({ categoryId: `Pick an ${kind} category.` });
  return c.id as string;
}

async function balancesSnapshot(tx: Tx, userId: string, envelopeId?: string | null) {
  const t = (await tx.query(`SELECT total_paisa::text AS t, envelopes_paisa::text AS e FROM ledger_totals WHERE user_id = $1`, [userId])).rows[0];
  const total = BigInt(t?.t ?? 0);
  const env = envelopeId
    ? BigInt((await tx.query(`SELECT balance_paisa::text AS b FROM envelope_balances WHERE user_id = $2 AND envelope_id = $1`, [envelopeId, userId])).rows[0]?.b ?? 0)
    : null;
  return { total: total.toString(), unallocated: (total - BigInt(t?.e ?? 0)).toString(), envelope: env?.toString() ?? null };
}

async function splitEnvelopeIds(tx: Tx, txId: string): Promise<string[]> {
  return (await tx.query(`SELECT envelope_id FROM transaction_splits WHERE transaction_id = $1`, [txId])).rows.map((r: { envelope_id: string }) => r.envelope_id);
}

async function audit(ctx: WriteCtx, id: string, action: string, before?: unknown) {
  const after = (await ctx.tx.query(`SELECT * FROM transactions WHERE id = $1`, [id])).rows[0];
  ctx.audit('transaction', id, action, before, after);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

const CreateExpenseSchema = z.object({
  idempotencyKey: z.string().uuid(),
  amount: Paisa,
  envelopeId: z.string().uuid(),
  categoryId: z.string().uuid().nullish(),
  note: Note,
  date: DateStr,
  time: TimeStr,
  confirmDuplicate: z.boolean().optional(),
}).strict();

export const createExpense = defineAction({
  name: 'transactions.createExpense',
  input: CreateExpenseSchema,
  async run(ctx, input) {
    const { tx, userId } = ctx;
    const env = await loadEnvelope(tx, userId, input.envelopeId);
    const { date, time } = await dateAndTime(tx, userId, input.date, input.time);
    const categoryId = await resolveCategory(tx, userId, 'expense', input.categoryId);

    // duplicate guard (FR-TXN-09): identical expense created in the last 2 minutes
    if (!input.confirmDuplicate) {
      const dup = await tx.query(
        `SELECT 1 FROM transactions WHERE user_id = $1 AND type = 'expense' AND amount_paisa = $2 AND envelope_id = $3
           AND category_id = $4 AND occurred_on = $5 AND deleted_at IS NULL AND created_at > now() - interval '2 minutes' LIMIT 1`,
        [userId, input.amount, input.envelopeId, categoryId, date]
      );
      if (dup.rows.length) throw new DuplicateSuspected({ duplicate: true });
    }

    const id = uuidv7();
    await tx.query(
      `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, category_id, note)
       VALUES ($1,$2,'expense',$3,$4,$5,$6,$7,$8)`,
      [id, userId, input.amount, date, time, input.envelopeId, categoryId, cleanNote(input.note)]
    );
    ctx.touch(input.envelopeId);
    ctx.setSubject(id, 'create');
    await audit(ctx, id, 'create');

    return {
      transaction: { id },
      onBehalfOf: env.owner_type === 'other' ? env.owner_name : null,
      balances: await balancesSnapshot(tx, userId, input.envelopeId),
    };
  },
  revalidate: () => ['/'],
});

const CreateIncomeSchema = z.object({
  idempotencyKey: z.string().uuid(),
  amount: Paisa,
  categoryId: z.string().uuid().nullish(),
  note: Note,
  date: DateStr,
  time: TimeStr,
  splits: z.array(z.object({ envelopeId: z.string().uuid(), amount: Paisa }).strict()).max(50).optional(),
}).strict();

async function validateSplits(tx: Tx, userId: string, total: bigint, splits: Array<{ envelopeId: string; amount: string }>) {
  const seen = new Set<string>();
  let sum = 0n;
  for (const s of splits) {
    if (seen.has(s.envelopeId)) throw new ValidationError({ splits: 'Each envelope can only appear once in a split.' });
    seen.add(s.envelopeId);
    const env = await loadEnvelope(tx, userId, s.envelopeId);
    if (env.owner_type !== 'mine') throw new ValidationError({ splits: `Income can't be split into money held for ${env.owner_name ?? 'someone else'}.` });
    sum += BigInt(s.amount);
  }
  if (sum > total) throw new ValidationError({ splits: 'The split adds up to more than the income amount.' });
  return sum;
}

export const createIncome = defineAction({
  name: 'transactions.createIncome',
  input: CreateIncomeSchema,
  async run(ctx, input) {
    const { tx, userId } = ctx;
    const { date, time } = await dateAndTime(tx, userId, input.date, input.time);
    const categoryId = await resolveCategory(tx, userId, 'income', input.categoryId);
    const splits = input.splits ?? [];
    const splitSum = await validateSplits(tx, userId, BigInt(input.amount), splits);

    const id = uuidv7();
    await tx.query(
      `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, category_id, note)
       VALUES ($1,$2,'income',$3,$4,$5,$6,$7)`,
      [id, userId, input.amount, date, time, categoryId, cleanNote(input.note)]
    );
    for (const s of splits) {
      await tx.query(`INSERT INTO transaction_splits (id, user_id, transaction_id, envelope_id, amount_paisa) VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), userId, id, s.envelopeId, s.amount]);
    }
    ctx.touch(...splits.map((s) => s.envelopeId));
    ctx.setSubject(id, 'create');
    await audit(ctx, id, 'create');

    return {
      transaction: { id },
      unallocatedRemainder: (BigInt(input.amount) - splitSum).toString(),
      balances: await balancesSnapshot(tx, userId),
    };
  },
  revalidate: () => ['/'],
});

// ---------------------------------------------------------------------------
// edit (type is immutable: D10)
// ---------------------------------------------------------------------------

const UpdateTransactionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().min(1),
  patch: z.object({
    amount: Paisa.optional(),
    envelopeId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    date: z.string().optional(),
    time: z.string().optional(),
    note: Note,
    splits: z.array(z.object({ envelopeId: z.string().uuid(), amount: Paisa }).strict()).max(50).optional(),
  }).strict(),
}).strict();

const EDITABLE: Record<string, Array<keyof z.infer<typeof UpdateTransactionSchema>['patch']>> = {
  expense: ['amount', 'envelopeId', 'categoryId', 'date', 'time', 'note'],
  income: ['amount', 'categoryId', 'date', 'time', 'note', 'splits'],
  allocation: ['amount', 'envelopeId', 'date', 'time', 'note'],
  deallocation: ['amount', 'envelopeId', 'date', 'time', 'note'],
  external_deposit: ['amount', 'envelopeId', 'date', 'time', 'note'],
  external_withdrawal: ['amount', 'envelopeId', 'date', 'time', 'note'],
  opening_balance: ['amount', 'date', 'time'],
  adjustment: ['note'],
};

export const updateTransaction = defineAction({
  name: 'transactions.update',
  input: UpdateTransactionSchema,
  idempotent: false,
  async run(ctx, input) {
    const { tx, userId } = ctx;
    const cur = (await tx.query(`SELECT * FROM transactions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, [input.id, userId])).rows[0];
    if (!cur) throw new NotFound('Transaction', input.id);
    if (cur.version !== input.version) throw new Conflict('This was changed on another device. Reload to see the latest.');

    if (cur.type === 'loan' || cur.type === 'loan_repayment') throw new RuleViolation('USE_LOANS_UI', { loanId: cur.loan_id, message: 'Loans are edited from the Loans screen.' });
    if (cur.type === 'transfer') throw new RuleViolation('TRANSFER_EDIT_UNSUPPORTED', { message: 'To change a transfer, delete it and add a new one.' });
    const allowed = EDITABLE[cur.type] ?? [];
    for (const key of Object.keys(input.patch) as Array<keyof typeof input.patch>) {
      if (input.patch[key] !== undefined && !allowed.includes(key)) {
        throw new ValidationError({ [key]: key === 'amount' || key === 'note' ? 'This field cannot be changed for this type.' : 'To change the type, delete this and add a new one.' });
      }
    }

    const before = { ...cur };
    const oldSplitEnvs = cur.type === 'income' ? await splitEnvelopeIds(tx, cur.id) : [];
    const p = input.patch;

    const amount = p.amount ?? String(cur.amount_paisa);
    const envelopeId = p.envelopeId ?? cur.envelope_id;
    if (p.envelopeId && p.envelopeId !== cur.envelope_id) await loadEnvelope(tx, userId, p.envelopeId);
    if (cur.type === 'external_deposit' || cur.type === 'external_withdrawal') {
      const e = await loadEnvelope(tx, userId, envelopeId, { requireActive: false });
      if (e.owner_type !== 'other') throw new ValidationError({ envelopeId: 'Pick an envelope held for someone else.' });
    }

    let date = String(cur.occurred_on instanceof Date ? cur.occurred_on.toISOString().slice(0, 10) : cur.occurred_on).slice(0, 10);
    let time = String(cur.occurred_at);
    if (p.date !== undefined || p.time !== undefined) {
      const dt = await dateAndTime(tx, userId, p.date ?? date, p.time ?? time);
      date = dt.date;
      time = dt.time;
    }
    const categoryId = cur.type === 'expense' || cur.type === 'income'
      ? p.categoryId ? await resolveCategory(tx, userId, cur.type, p.categoryId) : cur.category_id
      : cur.category_id;
    const note = p.note !== undefined ? cleanNote(p.note) : cur.note;

    await tx.query(
      `UPDATE transactions SET amount_paisa = $2, envelope_id = $3, category_id = $4, occurred_on = $5, occurred_at = $6, note = $7
       WHERE id = $1 AND user_id = $8`,
      [cur.id, amount, envelopeId, categoryId, date, time, note, userId]
    );

    let newSplitEnvs: string[] = oldSplitEnvs;
    if (cur.type === 'income') {
      const splits = p.splits ?? (await tx.query(`SELECT envelope_id AS "envelopeId", amount_paisa::text AS amount FROM transaction_splits WHERE transaction_id = $1`, [cur.id])).rows;
      await validateSplits(tx, userId, BigInt(amount), splits);
      if (p.splits) {
        await tx.query(`DELETE FROM transaction_splits WHERE transaction_id = $1`, [cur.id]);
        for (const s of p.splits) await tx.query(`INSERT INTO transaction_splits (id, user_id, transaction_id, envelope_id, amount_paisa) VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), userId, cur.id, s.envelopeId, s.amount]);
        newSplitEnvs = p.splits.map((s) => s.envelopeId);
        // bump the parent version so reconciliation hashes notice a splits-only change
        await tx.query(`UPDATE transactions SET updated_at = now(), note = note WHERE id = $1`, [cur.id]);
      }
    }

    // edit == delete old + insert new: verify BOTH versions' accounts
    ctx.touch(cur.envelope_id, envelopeId, ...oldSplitEnvs, ...newSplitEnvs);
    ctx.setSubject(cur.id, 'edit');
    await audit(ctx, cur.id, 'update', before);

    const fresh = (await tx.query(`SELECT version FROM transactions WHERE id = $1`, [cur.id])).rows[0];
    return { transaction: { id: cur.id, version: fresh.version as number }, balances: await balancesSnapshot(tx, userId, envelopeId) };
  },
  revalidate: () => ['/'],
});

// ---------------------------------------------------------------------------
// delete / restore / preview
// ---------------------------------------------------------------------------

async function envelopesOf(tx: Tx, row: { id: string; type: string; envelope_id: string | null; counterpart_envelope_id: string | null }) {
  return [row.envelope_id, row.counterpart_envelope_id, ...(row.type === 'income' ? await splitEnvelopeIds(tx, row.id) : [])];
}

async function guardDelete(tx: Tx, userId: string, row: { id: string; type: string; version: number }, version?: number) {
  if (version !== undefined && row.version !== version) throw new Conflict('This was changed on another device. Reload to see the latest.');
  if (row.type === 'loan' || row.type === 'loan_repayment') throw new RuleViolation('USE_LOANS_UI', { message: 'Loans are edited from the Loans screen.' });
  if (row.type === 'opening_balance') {
    const others = await tx.query(`SELECT 1 FROM transactions WHERE user_id = $1 AND deleted_at IS NULL AND type <> 'opening_balance' LIMIT 1`, [userId]);
    if (others.rows.length) throw new RuleViolation('OPENING_BALANCE_IN_USE', { message: "You can't delete your opening balance while you have other transactions. Edit the amount instead." });
  }
}

export const deleteTransaction = defineAction({
  name: 'transactions.delete',
  input: z.object({ id: z.string().uuid(), version: z.number().int().optional() }).strict(),
  idempotent: false,
  async run(ctx, input) {
    const { tx, userId } = ctx;
    const row = (await tx.query(`SELECT id, type::text AS type, version, envelope_id, counterpart_envelope_id FROM transactions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, [input.id, userId])).rows[0];
    if (!row) throw new NotFound('Transaction', input.id);
    await guardDelete(tx, userId, row, input.version);

    await tx.query(`UPDATE transactions SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND user_id = $2`, [row.id, userId]);
    ctx.touch(...(await envelopesOf(tx, row)));
    ctx.setSubject(row.id, 'delete');
    await audit(ctx, row.id, 'delete');
    return { success: true as const, balances: await balancesSnapshot(tx, userId) };
  },
  revalidate: () => ['/'],
});

export const restoreTransaction = defineAction({
  name: 'transactions.restore',
  input: z.object({ id: z.string().uuid() }).strict(),
  idempotent: false,
  async run(ctx, input) {
    const { tx, userId } = ctx;
    const row = (await tx.query(`SELECT id, type::text AS type, version, envelope_id, counterpart_envelope_id, deleted_at FROM transactions WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL FOR UPDATE`, [input.id, userId])).rows[0];
    if (!row) throw new NotFound('Transaction', input.id);
    if (Date.now() - new Date(row.deleted_at).getTime() > 30 * 24 * 3600 * 1000) throw new RuleViolation('RESTORE_EXPIRED', { message: 'This was deleted more than 30 days ago and can no longer be restored.' });
    if (row.type === 'loan' || row.type === 'loan_repayment') throw new RuleViolation('USE_LOANS_UI', { message: 'Loans are restored from the Loans screen.' });
    for (const id of [row.envelope_id, row.counterpart_envelope_id]) if (id) await loadEnvelope(tx, userId, id); // archived -> "Unarchive X first"

    await tx.query(`UPDATE transactions SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND user_id = $2`, [row.id, userId]);
    ctx.touch(...(await envelopesOf(tx, row)));
    ctx.setSubject(row.id, 'restore');
    await audit(ctx, row.id, 'restore');
    return { success: true as const, balances: await balancesSnapshot(tx, userId) };
  },
  revalidate: () => ['/'],
});

/** Dry run: apply the delete, verify, then roll the savepoint back (TD-05 §4). */
export const previewDelete = defineAction({
  name: 'transactions.previewDelete',
  input: z.object({ id: z.string().uuid() }).strict(),
  idempotent: false,
  async run(ctx, input) {
    const { tx, userId } = ctx;
    const row = (await tx.query(`SELECT id, type::text AS type, version, envelope_id, counterpart_envelope_id FROM transactions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [input.id, userId])).rows[0];
    if (!row) throw new NotFound('Transaction', input.id);
    await guardDelete(tx, userId, row);

    const effects = (await tx.query(
      `SELECT le.account, e.name, SUM(le.delta)::text AS delta FROM ledger_effects le LEFT JOIN envelopes e ON e.id = le.envelope_id
       WHERE le.transaction_id = $1 AND le.user_id = $2 GROUP BY le.account, e.name`,
      [row.id, userId]
    )).rows as Array<{ account: string; name: string | null; delta: string }>;
    // deleting reverses each posting
    const impact = effects
      .filter((e) => e.account !== 'UNALLOCATED')
      .map((e) => ({ label: e.account === 'TOTAL' ? 'Total' : `${e.name} balance`, delta: (-BigInt(e.delta)).toString() }));

    await tx.query('SAVEPOINT preview');
    let wouldViolate: string | null = null;
    try {
      await tx.query(`UPDATE transactions SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [row.id, userId]);
      const v = await verifyTimeline(tx, userId, (await envelopesOf(tx, row)).filter((x): x is string => !!x));
      if (v) wouldViolate = (await violationToError(tx, userId, v, { op: 'delete' })).message;
    } finally {
      await tx.query('ROLLBACK TO SAVEPOINT preview');
    }
    return { impact, wouldViolate };
  },
  revalidate: () => [],
});
