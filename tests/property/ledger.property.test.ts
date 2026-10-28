import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { isValid, balances, totalEffect, type Env, type MTx } from './model';
import { balancesOf, timelinePostings, type LedgerTx, type TxType } from '@/domain/ledger/effects';
import { findFirstViolation, findFirstLoanViolation, type LocalDate, type LocalTime } from '@/domain/validation/timeline';
import { createTestDb, stopEmbedded, type TestDb } from '../helpers/db';
import { createCategory, createEnvelope, createUser, totals, uid } from '../helpers/seed';
import { verifyTimeline } from '@/server/backup/verify';
import type { Paisa } from '@/domain/money';

// ---- operations ------------------------------------------------------------
const DATES = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const TIMES = ['09:00:00', '12:00:00', '15:00:00'];
const amount = fc.bigInt({ min: 1n, max: 500n });
const mine = fc.constantFrom<Env>('H', 'P');
const any3 = fc.constantFrom<Env>('H', 'P', 'X');
const when = fc.record({ on: fc.constantFrom(...DATES), at: fc.constantFrom(...TIMES) });

type Op =
  | { k: 'income'; amount: bigint; sh: boolean; sp: boolean; on: string; at: string }
  | { k: 'expense'; env: Env; amount: bigint; on: string; at: string }
  | { k: 'allocate' | 'deallocate'; env: Env; amount: bigint; on: string; at: string }
  | { k: 'transfer'; from: Env; amount: bigint; on: string; at: string }
  | { k: 'extDeposit' | 'extWithdraw'; amount: bigint; on: string; at: string }
  | { k: 'loan'; from: Env; amount: bigint; on: string; at: string }
  | { k: 'repay'; idx: number; amount: bigint; on: string; at: string }
  | { k: 'delete' | 'restore'; idx: number }
  | { k: 'editAmount'; idx: number; amount: bigint }
  | { k: 'editDate'; idx: number; on: string; at: string };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ k: fc.constant('income' as const), amount: fc.bigInt({ min: 1n, max: 2000n }), sh: fc.boolean(), sp: fc.boolean() }).chain((r) => when.map((w) => ({ ...r, ...w }))) },
  { weight: 5, arbitrary: fc.record({ k: fc.constant('expense' as const), env: any3, amount }).chain((r) => when.map((w) => ({ ...r, ...w }))) },
  { weight: 3, arbitrary: fc.record({ k: fc.constantFrom('allocate' as const, 'deallocate' as const), env: any3, amount }).chain((r) => when.map((w) => ({ ...r, ...w }))) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('transfer' as const), from: mine, amount }).chain((r) => when.map((w) => ({ ...r, ...w }))) },
  { weight: 2, arbitrary: fc.record({ k: fc.constantFrom('extDeposit' as const, 'extWithdraw' as const), amount }).chain((r) => when.map((w) => ({ ...r, ...w }))) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('loan' as const), from: mine, amount }).chain((r) => when.map((w) => ({ ...r, ...w }))) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('repay' as const), idx: fc.nat(30), amount }).chain((r) => when.map((w) => ({ ...r, ...w }))) },
  { weight: 2, arbitrary: fc.record({ k: fc.constantFrom('delete' as const, 'restore' as const), idx: fc.nat(30) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('editAmount' as const), idx: fc.nat(30), amount }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('editDate' as const), idx: fc.nat(30) }).chain((r) => when.map((w) => ({ ...r, ...w }))) },
);
const seqArb = fc.array(opArb, { minLength: 1, maxLength: 30 });

const other = (e: Env): Env => (e === 'H' ? 'P' : 'H');
const MODEL_START: MTx = { id: 0, type: 'opening', amount: 0n, on: '2026-09-30', at: '00:00:00', seq: 0, deleted: false };

/** Build the model transaction an op would create (null for non-creating ops / impossible ones). */
function build(op: Op, txs: MTx[], seq: number): MTx | null {
  const t = (p: Partial<MTx> & { type: string; amount: bigint }): MTx => ({ id: seq, on: '', at: '', seq, deleted: false, ...p } as MTx);
  switch (op.k) {
    case 'income': {
      const splits: MTx['splits'] = [];
      if (op.sh) splits.push({ env: 'H', amount: op.amount / 3n || 1n });
      if (op.sp) splits.push({ env: 'P', amount: op.amount / 4n || 1n });
      const sum = splits.reduce((s, x) => s + x.amount, 0n);
      if (sum > op.amount) return null; // would violate the splits <= income rule at the API layer
      return t({ type: 'income', amount: op.amount, on: op.on, at: op.at, splits });
    }
    case 'expense': return t({ type: 'expense', amount: op.amount, env: op.env, on: op.on, at: op.at });
    case 'allocate': return t({ type: 'allocate', amount: op.amount, env: op.env, on: op.on, at: op.at });
    case 'deallocate': return t({ type: 'deallocate', amount: op.amount, env: op.env, on: op.on, at: op.at });
    case 'transfer': return t({ type: 'transfer', amount: op.amount, env: op.from, cp: other(op.from), on: op.on, at: op.at });
    case 'extDeposit': return t({ type: 'extDeposit', amount: op.amount, env: 'X', on: op.on, at: op.at });
    case 'extWithdraw': return t({ type: 'extWithdraw', amount: op.amount, env: 'X', on: op.on, at: op.at });
    case 'loan': return t({ type: 'loan', amount: op.amount, env: op.from, cp: other(op.from), on: op.on, at: op.at, loan: seq });
    case 'repay': {
      const loans = txs.filter((x) => x.type === 'loan' && !x.deleted);
      const l = loans[op.idx % (loans.length || 1)];
      if (!l) return null;
      return t({ type: 'repay', amount: op.amount, env: l.cp, cp: l.env, on: op.on, at: op.at, loan: l.loan });
    }
    default: return null;
  }
}

/** Apply one op to a model list; returns the proposed list (caller checks validity). */
function proposeModel(op: Op, txs: MTx[], seq: number): { next: MTx[]; created: MTx | null; touched: MTx | null } | null {
  if (op.k === 'delete' || op.k === 'restore' || op.k === 'editAmount' || op.k === 'editDate') {
    const pool = txs.filter((x) => (op.k === 'restore' ? x.deleted : !x.deleted));
    if (pool.length === 0) return null;
    const target = pool[op.idx % pool.length]!;
    const edited: MTx = op.k === 'delete' ? { ...target, deleted: true } : op.k === 'restore' ? { ...target, deleted: false }
      : op.k === 'editAmount' ? { ...target, amount: op.amount } : op.k === 'editDate' ? { ...target, on: op.on, at: op.at } : target;
    if (op.k === 'editAmount' && target.type === 'income') return null; // splits depend on amount; skip
    return { next: txs.map((x) => (x.id === target.id ? edited : x)), created: null, touched: target };
  }
  const created = build(op, txs, seq);
  return created ? { next: [...txs, created], created, touched: null } : null;
}

// ---- pure path: model vs TS mirror verifier (>= 1000 sequences) -------------
function mirrorOf(txs: MTx[]): LedgerTx[] {
  const typeMap: Record<string, TxType> = { income: 'income', expense: 'expense', allocate: 'allocation', deallocate: 'deallocation', transfer: 'transfer', extDeposit: 'external_deposit', extWithdraw: 'external_withdrawal', loan: 'loan', repay: 'loan_repayment' };
  return txs.filter((t) => !t.deleted && typeMap[t.type]).map((t) => ({
    id: String(t.id).padStart(6, '0'), type: typeMap[t.type]!, amountPaisa: t.amount, occurredOn: t.on, occurredAt: t.at,
    createdAt: String(t.seq).padStart(6, '0'), envelopeId: t.env ?? null, counterpartEnvelopeId: t.cp ?? null,
    splits: t.splits?.map((s) => ({ envelopeId: s.env, amountPaisa: s.amount })),
  }));
}
function mirrorAccepts(txs: MTx[]): boolean {
  const m = mirrorOf(txs);
  if (findFirstViolation(timelinePostings(m))) return false;
  const lp = m.filter((t) => t.type === 'loan' || t.type === 'loan_repayment').map((t) => ({
    loanId: String(txs.find((x) => String(x.id).padStart(6, '0') === t.id)!.loan), txId: t.id, type: t.type as 'loan' | 'loan_repayment',
    amount: t.amountPaisa as Paisa, seq: [t.occurredOn as LocalDate, t.occurredAt as LocalTime, t.createdAt, t.id] as const,
  }));
  return !findFirstLoanViolation(lp);
}

describe('[URD-4] [URD-7] [URD-8] [URD-9] [URD-10] property: model == TS verifier, INV-1…5', () => {
  it('accept/reject agrees, rejected ops change nothing, invariants hold (1,000 sequences)', () => {
    let accepted = 0, rejected = 0;
    fc.assert(
      fc.property(seqArb, (ops) => {
        let txs: MTx[] = [];
        let seq = 1;
        for (const op of ops) {
          const p = proposeModel(op, txs, seq++);
          if (!p) continue;
          const modelOk = isValid(p.next);
          expect(mirrorAccepts(p.next)).toBe(modelOk); // decision equivalence
          if (!modelOk) { rejected++; continue; } // state unchanged
          accepted++;
          const before = balances(txs);
          txs = p.next;
          const b = balances(txs);
          // INV-2/3: balances non-negative now (and, by isValid, at every point)
          for (const v of [b.H, b.P, b.X, b.unallocated]) expect(v >= 0n).toBe(true);
          // INV-1: total = Σ envelopes + unallocated
          expect(b.total).toBe(b.H + b.P + b.X + b.unallocated);
          // TS mirror agrees on every balance
          const mb = balancesOf(mirrorOf(txs));
          expect(mb.total).toBe(b.total);
          expect(mb.unallocated).toBe(b.unallocated);
          expect(mb.unallocatedExplicit).toBe(b.unallocated);
          // INV-5: only income/expense/held-money/adjustment change Total
          if (p.created && !['income', 'expense', 'extDeposit', 'extWithdraw'].includes(p.created.type)) expect(b.total).toBe(before.total);
          if (p.created) expect(b.total - before.total).toBe(totalEffect(p.created));
        }
        return true;
      }),
      { numRuns: 1000 }
    );
    expect(accepted).toBeGreaterThan(200);
    expect(rejected).toBeGreaterThan(50); // the property is not vacuous
  });
});

// ---- DB path: model vs the real SQL verifier -------------------------------
describe('[URD-4] [URD-11] property: model == SQL verifier on Postgres (apply -> verify -> rollback)', () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); }, 120_000);
  afterAll(async () => { await db?.stop(); await stopEmbedded(); });

  it('decisions and balances match for random operation sequences', async () => {
    let accepted = 0, rejected = 0;
    await fc.assert(
      fc.asyncProperty(seqArb, async (ops) => {
        await db.admin.query('BEGIN');
        try {
        const user = await createUser(db.admin);
        const E: Record<Env, string> = { H: await createEnvelope(db.admin, user, 'Home'), P: await createEnvelope(db.admin, user, 'Personal'), X: await createEnvelope(db.admin, user, 'Ahmed', 'other') };
        const catE = await createCategory(db.admin, user, 'expense');
        const catI = await createCategory(db.admin, user, 'income');
        const created = (seq: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString();
        const SQLTYPE: Record<string, string> = { income: 'income', expense: 'expense', allocate: 'allocation', deallocate: 'deallocation', transfer: 'transfer', extDeposit: 'external_deposit', extWithdraw: 'external_withdrawal', loan: 'loan', repay: 'loan_repayment' };
        const loanRows = new Map<number, string>();
        const dbId = new Map<number, string>();
        let txs: MTx[] = [];
        let seq = 1;

        // opening balance + generous base so many ops are valid
        await db.admin.query(`INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, created_at) VALUES ($1,$2,'opening_balance',5000,'2026-09-30','00:00:00',$3)`, [uid(), user, created(0)]);
        txs = [{ ...MODEL_START, type: 'income', amount: 5000n }];

        for (const op of ops) {
          const s = seq++;
          const p = proposeModel(op, txs, s);
          if (!p) continue;
          const modelOk = isValid(p.next);

          await db.admin.query('SAVEPOINT op');
          if (p.created) {
            const c = p.created;
            let loanId: string | null = null;
            if (c.type === 'loan') {
              loanId = uid();
              loanRows.set(c.loan!, loanId);
              await db.admin.query(`INSERT INTO loans (id, user_id, lender_envelope_id, borrower_envelope_id) VALUES ($1,$2,$3,$4)`, [loanId, user, E[c.env!], E[c.cp!]]);
            } else if (c.type === 'repay') loanId = loanRows.get(c.loan!)!;
            const id = uid();
            dbId.set(c.id, id);
            const hasCat = c.type === 'expense' ? catE : c.type === 'income' ? catI : null;
            await db.admin.query(
              `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, counterpart_envelope_id, category_id, loan_id, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [id, user, SQLTYPE[c.type], c.amount.toString(), c.on, c.at, c.env ? E[c.env] : null, c.cp ? E[c.cp] : null, hasCat, loanId, created(s)]
            );
            for (const sp of c.splits ?? []) await db.admin.query(`INSERT INTO transaction_splits (id, user_id, transaction_id, envelope_id, amount_paisa) VALUES ($1,$2,$3,$4,$5)`, [uid(), user, id, E[sp.env], sp.amount.toString()]);
          } else if (p.touched) {
            const id = dbId.get(p.touched.id) ?? null;
            if (!id) { await db.admin.query('ROLLBACK TO SAVEPOINT op'); continue; }
            const after = p.next.find((x) => x.id === p.touched!.id)!;
            await db.admin.query(`UPDATE transactions SET amount_paisa = $2, occurred_on = $3, occurred_at = $4, deleted_at = $5, deleted_by = $6 WHERE id = $1`,
              [id, after.amount.toString(), after.on, after.at, after.deleted ? new Date().toISOString() : null, after.deleted ? user : null]);
          }
          const violation = await verifyTimeline(db.admin, user, null);
          expect(violation === null, `op ${JSON.stringify(op, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`).toBe(modelOk);

          if (violation) { await db.admin.query('ROLLBACK TO SAVEPOINT op'); rejected++; continue; }
          await db.admin.query('RELEASE SAVEPOINT op');
          accepted++;
          txs = p.next;
        }

        // final state: SQL balances == model balances; INV-1 on the real view
        const t = await totals(db.admin, user);
        const b = balances(txs);
        expect(t.total).toBe(b.total);
        expect(t.unallocated).toBe(b.unallocated);
        expect(t.unallocatedExplicit).toBe(t.unallocated);
        const rows = (await db.admin.query(`SELECT e.name, eb.balance_paisa::text AS b FROM envelope_balances eb JOIN envelopes e ON e.id = eb.envelope_id WHERE eb.user_id = $1`, [user])).rows;
        const byName = Object.fromEntries(rows.map((r) => [r.name, BigInt(r.b)]));
        expect(byName['Home']).toBe(b.H);
        expect(byName['Personal']).toBe(b.P);
        expect(byName['Ahmed']).toBe(b.X);
        await db.admin.query('COMMIT');
        return true;
        } catch (e) {
          await db.admin.query('ROLLBACK');
          throw e;
        }
      }),
      { numRuns: 60 }
    );
    expect(accepted).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(10);
  }, 280_000);
});
