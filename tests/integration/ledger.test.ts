import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createTestDb, stopEmbedded, type TestDb } from '../helpers/db';
import { createCategory, createEnvelope, createUser, envBalances, insertSplit, insertTx, totals, uid } from '../helpers/seed';
import { balancesOf, type LedgerTx, type TxType } from '@/domain/ledger/effects';
import { verifyTimeline } from '@/server/backup/verify';

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); }, 120_000);
afterAll(async () => { await db?.stop(); await stopEmbedded(); });

async function world() {
  const user = await createUser(db.admin);
  const home = await createEnvelope(db.admin, user, 'Home');
  const personal = await createEnvelope(db.admin, user, 'Personal');
  const ahmed = await createEnvelope(db.admin, user, 'Ahmed', 'other');
  const catE = await createCategory(db.admin, user, 'expense');
  const catI = await createCategory(db.admin, user, 'income');
  return { user, home, personal, ahmed, catE, catI };
}

describe('[URD-4] [URD-5] [URD-6] ledger_effects view', () => {
  it('reference scenario step 1-3 numbers', async () => {
    const w = await world();
    const T = (type: string, amount: bigint, extra: Record<string, unknown> = {}) => insertTx(db.admin, { userId: w.user, type, amount, ...extra } as never);
    await T('opening_balance', 20000000n, { at: '00:00:00' });
    await T('allocation', 5000000n, { envelopeId: w.home, at: '00:00:01' });
    await T('allocation', 8000000n, { envelopeId: w.personal, at: '00:00:02' });
    await T('allocation', 2000000n, { envelopeId: w.ahmed, at: '00:00:03' });
    let t = await totals(db.admin, w.user);
    expect(t.total).toBe(20000000n);
    expect(t.unallocated).toBe(5000000n); // 50,000 (no Savings envelope in this fixture)
    expect(t.other).toBe(2000000n);
    expect(t.unallocated + t.mine).toBe(18000000n); // Your Money 180,000

    await T('expense', 250000n, { envelopeId: w.home, categoryId: w.catE, on: '2026-10-02' });
    t = await totals(db.admin, w.user);
    expect(t.total).toBe(19750000n);
    expect((await envBalances(db.admin, w.user)).get(w.home)).toBe(4750000n);

    const inc = await T('income', 15000000n, { categoryId: w.catI, on: '2026-10-03' });
    await insertSplit(db.admin, w.user, inc, w.home, 5000000n);
    await insertSplit(db.admin, w.user, inc, w.personal, 5000000n);
    t = await totals(db.admin, w.user);
    expect(t.total).toBe(34750000n); // 347,500
    // no Savings envelope here: Unallocated was 50,000; salary 150,000 with 100,000 split out adds 50,000
    expect(t.unallocated).toBe(10000000n);
  });

  it('unallocated by construction equals the explicit postings (INV-1)', async () => {
    const w = await world();
    await insertTx(db.admin, { userId: w.user, type: 'opening_balance', amount: 1000n, at: '00:00:00' });
    await insertTx(db.admin, { userId: w.user, type: 'adjustment', amount: -300n, envelopeId: null, on: '2026-10-02' });
    await insertTx(db.admin, { userId: w.user, type: 'adjustment', amount: 50n, envelopeId: w.home, on: '2026-10-02' });
    const t = await totals(db.admin, w.user);
    expect(t.total).toBe(750n);
    expect(t.unallocated).toBe(t.unallocatedExplicit);
  });

  it('SQL view equals the TS mirror on random ledgers (differential)', async () => {
    const w = await world();
    const types: TxType[] = ['income', 'external_deposit', 'expense', 'external_withdrawal', 'allocation', 'deallocation', 'transfer', 'loan', 'loan_repayment', 'adjustment'];
    const arb = fc.array(
      fc.record({ type: fc.constantFrom(...types), amount: fc.bigInt({ min: 1n, max: 100_000n }), splitHome: fc.boolean(), adjSign: fc.boolean(), adjUnalloc: fc.boolean() }),
      { minLength: 1, maxLength: 25 }
    );
    await fc.assert(
      fc.asyncProperty(arb, async (ops) => {
        const user = await createUser(db.admin);
        const home = await createEnvelope(db.admin, user, 'Home');
        const personal = await createEnvelope(db.admin, user, 'Personal');
        const ahmed = await createEnvelope(db.admin, user, 'Ahmed', 'other');
        const catE = await createCategory(db.admin, user, 'expense');
        const catI = await createCategory(db.admin, user, 'income');
        let loan = uid();
        const newLoan = async () => {
          loan = uid();
          await db.admin.query(`INSERT INTO loans (id, user_id, lender_envelope_id, borrower_envelope_id) VALUES ($1,$2,$3,$4)`, [loan, user, personal, home]);
        };
        await newLoan();
        let usedOrigin = false;
        const mirror: LedgerTx[] = [];
        let i = 0;
        for (const op of ops) {
          const at = `00:00:${String(i++ % 60).padStart(2, '0')}`;
          const base = { userId: user, type: op.type, amount: op.amount, at, on: '2026-10-01' } as Record<string, unknown>;
          const m: LedgerTx = { id: '', type: op.type, amountPaisa: op.amount, occurredOn: '2026-10-01', occurredAt: at, createdAt: '', envelopeId: null, counterpartEnvelopeId: null };
          switch (op.type) {
            case 'income': base.categoryId = catI; break;
            case 'expense': base.categoryId = catE; base.envelopeId = home; m.envelopeId = home; break;
            case 'external_deposit': case 'external_withdrawal': base.envelopeId = ahmed; m.envelopeId = ahmed; break;
            case 'allocation': case 'deallocation': base.envelopeId = personal; m.envelopeId = personal; break;
            case 'transfer': base.envelopeId = home; base.counterpartId = personal; m.envelopeId = home; m.counterpartEnvelopeId = personal; break;
            case 'loan': if (usedOrigin) await newLoan(); usedOrigin = true; base.envelopeId = personal; base.counterpartId = home; base.loanId = loan; m.envelopeId = personal; m.counterpartEnvelopeId = home; break;
            case 'loan_repayment': base.envelopeId = home; base.counterpartId = personal; base.loanId = loan; m.envelopeId = home; m.counterpartEnvelopeId = personal; break;
            case 'adjustment': {
              const signed = op.adjSign ? op.amount : -op.amount;
              base.amount = signed; m.amountPaisa = signed;
              if (!op.adjUnalloc) { base.envelopeId = home; m.envelopeId = home; }
              break;
            }
          }
          const id = await insertTx(db.admin, base as never);
          m.id = id;
          if (op.type === 'income' && op.splitHome) {
            const part = op.amount / 2n;
            if (part > 0n) { await insertSplit(db.admin, user, id, home, part); m.splits = [{ envelopeId: home, amountPaisa: part }]; }
          }
          mirror.push(m);
        }
        const sql = await totals(db.admin, user);
        const bal = await envBalances(db.admin, user);
        const ts = balancesOf(mirror);
        expect(sql.total).toBe(ts.total);
        expect(sql.unallocated).toBe(ts.unallocated);
        expect(sql.unallocatedExplicit).toBe(ts.unallocatedExplicit); // INV-1
        for (const e of [home, personal, ahmed]) expect(bal.get(e) ?? 0n).toBe(ts.envelopes.get(e) ?? 0n);
      }),
      { numRuns: 60 }
    );
  }, 120_000);
});

describe('[URD-7] [URD-8] [URD-10] SQL timeline verifier', () => {
  it('detects the first violating date for a backdated expense', async () => {
    const w = await world();
    await insertTx(db.admin, { userId: w.user, type: 'opening_balance', amount: 100_000n, on: '2026-10-01', at: '00:00:00' });
    await insertTx(db.admin, { userId: w.user, type: 'allocation', amount: 50_000n, envelopeId: w.home, on: '2026-10-05', at: '00:00:00' });
    expect(await verifyTimeline(db.admin, w.user, null)).toBeNull();
    // an expense backdated to before Home was funded
    await insertTx(db.admin, { userId: w.user, type: 'expense', amount: 10_000n, envelopeId: w.home, categoryId: w.catE, on: '2026-10-03' });
    const v = await verifyTimeline(db.admin, w.user, null);
    expect(v).toMatchObject({ kind: 'envelope', id: w.home, on: '2026-10-03', shortfallPaisa: '10000' });
  });

  it('removing funding after spending is a violation; removing the spending first is fine', async () => {
    const w = await world();
    await insertTx(db.admin, { userId: w.user, type: 'opening_balance', amount: 100_000n, at: '00:00:00' });
    const alloc = await insertTx(db.admin, { userId: w.user, type: 'allocation', amount: 50_000n, envelopeId: w.home, at: '00:00:01' });
    const exp = await insertTx(db.admin, { userId: w.user, type: 'expense', amount: 20_000n, envelopeId: w.home, categoryId: w.catE, on: '2026-10-02' });
    await db.admin.query(`UPDATE transactions SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [alloc, w.user]);
    expect((await verifyTimeline(db.admin, w.user, null))?.kind).toBe('envelope');
    await db.admin.query(`UPDATE transactions SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`, [alloc]);
    await db.admin.query(`UPDATE transactions SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [exp, w.user]);
    await db.admin.query(`UPDATE transactions SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [alloc, w.user]);
    expect(await verifyTimeline(db.admin, w.user, null)).toBeNull();
  });

  it('same-day ordering follows time then created_at', async () => {
    const w = await world();
    await insertTx(db.admin, { userId: w.user, type: 'opening_balance', amount: 100_000n, at: '00:00:00' });
    await insertTx(db.admin, { userId: w.user, type: 'allocation', amount: 1_000n, envelopeId: w.home, at: '12:00:00', createdAt: '2026-10-01T10:00:00Z' });
    await insertTx(db.admin, { userId: w.user, type: 'expense', amount: 1_000n, envelopeId: w.home, categoryId: w.catE, at: '12:00:00', createdAt: '2026-10-01T10:00:01Z' });
    expect(await verifyTimeline(db.admin, w.user, null)).toBeNull();
    await insertTx(db.admin, { userId: w.user, type: 'expense', amount: 1n, envelopeId: w.home, categoryId: w.catE, at: '11:59:59' });
    expect((await verifyTimeline(db.admin, w.user, null))?.kind).toBe('envelope');
  });

  it('loan verifier: repayment before the loan or over-repayment', async () => {
    const w = await world();
    const loan = uid();
    await db.admin.query(`INSERT INTO loans (id, user_id, lender_envelope_id, borrower_envelope_id) VALUES ($1,$2,$3,$4)`, [loan, w.user, w.personal, w.home]);
    await insertTx(db.admin, { userId: w.user, type: 'opening_balance', amount: 100_000n, at: '00:00:00', on: '2026-09-01' });
    await insertTx(db.admin, { userId: w.user, type: 'allocation', amount: 50_000n, envelopeId: w.personal, at: '00:00:01', on: '2026-09-01' });
    await insertTx(db.admin, { userId: w.user, type: 'allocation', amount: 50_000n, envelopeId: w.home, at: '00:00:02', on: '2026-09-01' });
    await insertTx(db.admin, { userId: w.user, type: 'loan', amount: 5_000n, envelopeId: w.personal, counterpartId: w.home, loanId: loan, on: '2026-10-03' });
    expect(await verifyTimeline(db.admin, w.user, null)).toBeNull();
    await insertTx(db.admin, { userId: w.user, type: 'loan_repayment', amount: 6_000n, envelopeId: w.home, counterpartId: w.personal, loanId: loan, on: '2026-10-04' });
    expect(await verifyTimeline(db.admin, w.user, null)).toMatchObject({ kind: 'loan', id: loan, shortfallPaisa: '1000' });
  });
});

describe('DB constraints and triggers (defence in depth)', () => {
  it('rejects wrong shapes, bad amounts, and cross-owner rules', async () => {
    const w = await world();
    const bad = (input: Record<string, unknown>) => insertTx(db.admin, { userId: w.user, ...input } as never);
    await expect(bad({ type: 'expense', amount: 100n, envelopeId: w.home })).rejects.toThrow(); // needs a category
    await expect(bad({ type: 'income', amount: 100n, categoryId: w.catI, envelopeId: w.home })).rejects.toThrow(); // income has no envelope
    await expect(bad({ type: 'expense', amount: 0n, envelopeId: w.home, categoryId: w.catE })).rejects.toThrow(); // zero
    await expect(bad({ type: 'transfer', amount: 5n, envelopeId: w.home, counterpartId: w.home })).rejects.toThrow(); // same envelope
    await expect(bad({ type: 'external_deposit', amount: 5n, envelopeId: w.home })).rejects.toThrow(); // mine envelope
    await expect(bad({ type: 'transfer', amount: 5n, envelopeId: w.home, counterpartId: w.ahmed })).rejects.toThrow(); // others'
    await expect(bad({ type: 'expense', amount: 5n, envelopeId: w.home, categoryId: w.catI })).rejects.toThrow(); // wrong category kind
    await expect(bad({ type: 'opening_balance', amount: 5n, on: '1999-12-31' })).rejects.toThrow(); // before 2000-01-01
  });

  it('allows a zero opening balance but only one live opening balance', async () => {
    const w = await world();
    await insertTx(db.admin, { userId: w.user, type: 'opening_balance', amount: 0n });
    await expect(insertTx(db.admin, { userId: w.user, type: 'opening_balance', amount: 5n })).rejects.toThrow();
  });

  it('owner_type is immutable once an envelope has transactions; splits cannot exceed income', async () => {
    const w = await world();
    const fresh = await createEnvelope(db.admin, w.user, 'Fresh');
    await db.admin.query(`UPDATE envelopes SET owner_type = 'other', owner_name = 'X' WHERE id = $1`, [fresh]); // allowed: unreferenced
    await insertTx(db.admin, { userId: w.user, type: 'opening_balance', amount: 1000n });
    await insertTx(db.admin, { userId: w.user, type: 'allocation', amount: 10n, envelopeId: w.home });
    await expect(db.admin.query(`UPDATE envelopes SET owner_type = 'other', owner_name = 'X' WHERE id = $1`, [w.home])).rejects.toThrow();
    const inc = await insertTx(db.admin, { userId: w.user, type: 'income', amount: 100n, categoryId: w.catI });
    await expect(insertSplit(db.admin, w.user, inc, w.home, 101n)).rejects.toThrow();
  });

  it('bumps version on update (optimistic concurrency)', async () => {
    const w = await world();
    const id = await insertTx(db.admin, { userId: w.user, type: 'opening_balance', amount: 5n });
    await db.admin.query(`UPDATE transactions SET note = 'x' WHERE id = $1`, [id]);
    expect((await db.admin.query(`SELECT version FROM transactions WHERE id = $1`, [id])).rows[0].version).toBe(2);
  });
});

describe('[URD-44] row-level security (app role)', () => {
  it('a non-owner role sees nothing without app.user_id and only its own rows with it', async () => {
    const a = await world();
    const b = await world();
    await insertTx(db.admin, { userId: a.user, type: 'opening_balance', amount: 111n });
    await insertTx(db.admin, { userId: b.user, type: 'opening_balance', amount: 222n });
    await db.admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_rw') THEN CREATE ROLE app_rw LOGIN PASSWORD 'pw' NOBYPASSRLS; END IF; END $$`);
    await db.admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw`);
    const { Client } = await import('pg');
    const app = new Client({ connectionString: db.url.replace('postgres:pw', 'app_rw:pw') });
    await app.connect();
    try {
      expect((await app.query(`SELECT count(*)::int AS n FROM transactions`)).rows[0].n).toBe(0);
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.user_id', $1, true)`, [a.user]);
      const rows = (await app.query(`SELECT user_id, amount_paisa::text AS a FROM transactions`)).rows;
      expect(rows).toEqual([{ user_id: a.user, a: '111' }]);
      // cannot write another user's row either
      await expect(app.query(`INSERT INTO envelopes (id, user_id, name) VALUES ($1,$2,'Evil')`, [uid(), b.user])).rejects.toThrow();
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });
});
