import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { createTestDb, stopEmbedded, type TestDb } from '../helpers/db';
import { createCategory, createEnvelope, createUser, envBalances, insertTx, totals } from '../helpers/seed';

// The session layer pulls in next-auth (Next runtime); actions are exercised via `.as(userId, …)`.
vi.mock('@/server/auth/session', () => ({ requireUser: vi.fn(async () => { throw new Error('no session in tests'); }) }));

let db: TestDb;
let A: typeof import('@/server/actions/transactions');

beforeAll(async () => {
  db = await createTestDb();
  Object.assign(process.env, { DATABASE_URL: db.url, DATABASE_URL_UNPOOLED: db.url, AUTH_URL: 'http://localhost:3000', AUTH_SECRET: 'x'.repeat(40), CRON_SECRET: 'y'.repeat(40) });
  A = await import('@/server/actions/transactions');
}, 120_000);
afterAll(async () => {
  await (await import('@/server/db/client')).closePool();
  await db?.stop();
  await stopEmbedded();
});

const key = () => randomUUID();

async function world() {
  const user = await createUser(db.admin);
  const home = await createEnvelope(db.admin, user, 'Home');
  const personal = await createEnvelope(db.admin, user, 'Personal');
  const ahmed = await createEnvelope(db.admin, user, 'Ahmed', 'other');
  const catE = await createCategory(db.admin, user, 'expense');
  const catI = await createCategory(db.admin, user, 'income');
  await insertTx(db.admin, { userId: user, type: 'opening_balance', amount: 20_000_000n, on: '2026-01-01', at: '00:00:00' });
  await insertTx(db.admin, { userId: user, type: 'allocation', amount: 5_000_000n, envelopeId: home, on: '2026-01-01', at: '00:00:01' });
  await insertTx(db.admin, { userId: user, type: 'allocation', amount: 8_000_000n, envelopeId: personal, on: '2026-01-01', at: '00:00:02' });
  await insertTx(db.admin, { userId: user, type: 'allocation', amount: 2_000_000n, envelopeId: ahmed, on: '2026-01-01', at: '00:00:03' });
  return { user, home, personal, ahmed, catE, catI };
}

const expense = (w: { home: string; catE: string }, amount: string, extra: Record<string, unknown> = {}) => ({ idempotencyKey: key(), amount, envelopeId: w.home, categoryId: w.catE, ...extra });

describe('[URD-4] expense boundaries through the real action pipeline', () => {
  it('an expense equal to the full balance succeeds; one paisa more fails with "has only"', async () => {
    const w = await world();
    const ok = await A.createExpense.as(w.user, expense(w, '5000000'));
    expect(ok.ok).toBe(true);
    expect((await envBalances(db.admin, w.user)).get(w.home)).toBe(0n);

    const w2 = await world();
    const bad = await A.createExpense.as(w2.user, expense(w2, '5000001'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('INSUFFICIENT_FUNDS');
      expect(bad.error.message).toBe('Home has only 50,000 PKR available.');
      expect(bad.error.actions?.map((a) => a.kind)).toEqual(['add_money', 'borrow']);
    }
    expect((await totals(db.admin, w2.user)).total).toBe(20_000_000n); // nothing written
  });

  it('reference step 2: Home 50,000 - 2,500 -> 47,500; Total 197,500', async () => {
    const w = await world();
    const r = await A.createExpense.as(w.user, expense(w, '250000'));
    expect(r.ok && r.data.balances).toMatchObject({ envelope: '4750000', total: '19750000' });
  });
});

describe('[URD-5] [URD-6] income and splits', () => {
  it('splits summing to the amount leave Unallocated unchanged; none -> all to Unallocated; too many fails', async () => {
    const w = await world();
    const base = (await totals(db.admin, w.user)).unallocated;
    const full = await A.createIncome.as(w.user, { idempotencyKey: key(), amount: '1000000', categoryId: w.catI, splits: [{ envelopeId: w.home, amount: '600000' }, { envelopeId: w.personal, amount: '400000' }] });
    expect(full.ok && full.data.unallocatedRemainder).toBe('0');
    expect((await totals(db.admin, w.user)).unallocated).toBe(base);

    const none = await A.createIncome.as(w.user, { idempotencyKey: key(), amount: '1000000', categoryId: w.catI });
    expect(none.ok && none.data.unallocatedRemainder).toBe('1000000');
    expect((await totals(db.admin, w.user)).unallocated).toBe(base + 1_000_000n);

    const over = await A.createIncome.as(w.user, { idempotencyKey: key(), amount: '1000', categoryId: w.catI, splits: [{ envelopeId: w.home, amount: '1001' }] });
    expect(!over.ok && over.error.code).toBe('VALIDATION');

    const held = await A.createIncome.as(w.user, { idempotencyKey: key(), amount: '1000', categoryId: w.catI, splits: [{ envelopeId: w.ahmed, amount: '10' }] });
    expect(!held.ok && held.error.fieldErrors?.splits).toMatch(/held for Ahmed/);
    const dup = await A.createIncome.as(w.user, { idempotencyKey: key(), amount: '1000', categoryId: w.catI, splits: [{ envelopeId: w.home, amount: '10' }, { envelopeId: w.home, amount: '10' }] });
    expect(!dup.ok && dup.error.code).toBe('VALIDATION');
  });
});

describe('[URD-7] [URD-8] [URD-9] [URD-10] timeline validation on create / edit / delete', () => {
  it('rejects a backdated expense that would have been impossible then, naming the first violating date', async () => {
    const user = await createUser(db.admin);
    const home = await createEnvelope(db.admin, user, 'Home');
    const catE = await createCategory(db.admin, user, 'expense');
    await insertTx(db.admin, { userId: user, type: 'opening_balance', amount: 100_000n, on: '2026-09-01', at: '00:00:00' });
    await insertTx(db.admin, { userId: user, type: 'allocation', amount: 50_000n, envelopeId: home, on: '2026-10-05', at: '00:00:00' });
    const r = await A.createExpense.as(user, { idempotencyKey: key(), amount: '10000', envelopeId: home, categoryId: catE, date: '2026-10-03' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/Home has only 0 PKR available/);
  });

  it('deleting the income that funded later spending is rejected; after removing the spending it succeeds', async () => {
    const user = await createUser(db.admin);
    const home = await createEnvelope(db.admin, user, 'Home');
    const catE = await createCategory(db.admin, user, 'expense');
    const catI = await createCategory(db.admin, user, 'income');
    const inc = await A.createIncome.as(user, { idempotencyKey: key(), amount: '100000', categoryId: catI, splits: [{ envelopeId: home, amount: '100000' }], date: '2026-10-01' });
    const exp = await A.createExpense.as(user, { idempotencyKey: key(), amount: '30000', envelopeId: home, categoryId: catE, date: '2026-10-02' });
    expect(inc.ok && exp.ok).toBe(true);
    if (!inc.ok || !exp.ok) return;

    const preview = await A.previewDelete.as(user, { id: inc.data.transaction.id });
    expect(preview.ok && preview.data.wouldViolate).toMatch(/Home/);
    const blocked = await A.deleteTransaction.as(user, { id: inc.data.transaction.id });
    expect(!blocked.ok && blocked.error.code).toBe('TIMELINE_VIOLATION');
    expect((await totals(db.admin, user)).total).toBe(70_000n); // untouched

    expect((await A.deleteTransaction.as(user, { id: exp.data.transaction.id })).ok).toBe(true);
    expect((await A.deleteTransaction.as(user, { id: inc.data.transaction.id })).ok).toBe(true);
  });

  it('editing an expense amount up/down updates balances; up beyond balance fails; envelope change validates both', async () => {
    const w = await world();
    const e = await A.createExpense.as(w.user, expense(w, '100000'));
    if (!e.ok) throw new Error('setup');
    const id = e.data.transaction.id;
    const down = await A.updateTransaction.as(w.user, { id, version: 1, patch: { amount: '50000' } });
    expect(down.ok && down.data.balances.envelope).toBe('4950000');
    const up = await A.updateTransaction.as(w.user, { id, version: 2, patch: { amount: '9999999' } });
    expect(!up.ok && up.error.code).toBe('INSUFFICIENT_FUNDS');
    // move it to Personal (80,000): fine; Home returns to 50,000
    const moved = await A.updateTransaction.as(w.user, { id, version: 2, patch: { envelopeId: w.personal } });
    expect(moved.ok).toBe(true);
    const bal = await envBalances(db.admin, w.user);
    expect(bal.get(w.home)).toBe(5_000_000n);
    expect(bal.get(w.personal)).toBe(8_000_000n - 50_000n);
    // type cannot change; income splits can't be set on an expense
    const bad = await A.updateTransaction.as(w.user, { id, version: 3, patch: { splits: [] } });
    expect(bad.ok).toBe(false);
  });
});

describe('[URD-11] concurrency', () => {
  it('two simultaneous expenses that together exceed the balance: exactly one succeeds', async () => {
    const w = await world();
    const results = await Promise.all([
      A.createExpense.as(w.user, expense(w, '3000000')),
      A.createExpense.as(w.user, expense(w, '3000000')),
    ]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect((await envBalances(db.admin, w.user)).get(w.home)).toBe(2_000_000n);
  });

  it('20 parallel writers never break an invariant', async () => {
    const w = await world();
    const results = await Promise.all(Array.from({ length: 20 }, () => A.createExpense.as(w.user, expense(w, '600000', { confirmDuplicate: true }))));
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(8); // 50,000 / 6,000 = 8.33 -> exactly 8 fit
    const bal = (await envBalances(db.admin, w.user)).get(w.home)!;
    expect(bal).toBe(5_000_000n - 8n * 600_000n);
    expect(bal >= 0n).toBe(true);
  });
});

describe('[URD-12] [URD-13] idempotency and optimistic concurrency', () => {
  it('re-submitting the same key creates exactly one transaction and returns the original result', async () => {
    const w = await world();
    const input = expense(w, '100000');
    const [a, b] = await Promise.all([A.createExpense.as(w.user, input), A.createExpense.as(w.user, input)]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.data.transaction.id).toBe(b.data.transaction.id);
    const n = (await db.admin.query(`SELECT count(*)::int AS n FROM transactions WHERE user_id = $1 AND type = 'expense'`, [w.user])).rows[0].n;
    expect(n).toBe(1);
    // a different payload under the same key is a conflict, not a silent replay
    const clash = await A.createExpense.as(w.user, { ...input, amount: '200000' });
    expect(!clash.ok && clash.error.code).toBe('CONFLICT');
  });

  it('a stale version is rejected with CONFLICT and nothing is overwritten', async () => {
    const w = await world();
    const e = await A.createExpense.as(w.user, expense(w, '100000'));
    if (!e.ok) throw new Error('setup');
    const id = e.data.transaction.id;
    expect((await A.updateTransaction.as(w.user, { id, version: 1, patch: { note: 'first' } })).ok).toBe(true);
    const stale = await A.updateTransaction.as(w.user, { id, version: 1, patch: { note: 'second' } });
    expect(!stale.ok && stale.error.code).toBe('CONFLICT');
    expect(!stale.ok && stale.error.message).toBe('This was changed on another device. Reload to see the latest.');
    expect((await db.admin.query(`SELECT note FROM transactions WHERE id = $1`, [id])).rows[0].note).toBe('first');
  });

  it('the duplicate guard asks for confirmation within 2 minutes, but a deliberate retry goes through', async () => {
    const w = await world();
    expect((await A.createExpense.as(w.user, expense(w, '1000', { date: '2026-10-01' }))).ok).toBe(true);
    const again = await A.createExpense.as(w.user, expense(w, '1000', { date: '2026-10-01' }));
    expect(!again.ok && again.error.code).toBe('DUPLICATE_SUSPECTED');
    expect((await A.createExpense.as(w.user, expense(w, '1000', { date: '2026-10-01', confirmDuplicate: true }))).ok).toBe(true);
  });
});

describe('[URD-14] soft delete and restore re-validate', () => {
  it('soft-deleted rows never affect balances; restore re-runs the checks and bumps the ledger revision', async () => {
    const w = await world();
    const e = await A.createExpense.as(w.user, expense(w, '100000'));
    if (!e.ok) throw new Error('setup');
    const rev0 = Number((await db.admin.query(`SELECT ledger_revision::text AS r FROM users WHERE id = $1`, [w.user])).rows[0].r);
    expect((await A.deleteTransaction.as(w.user, { id: e.data.transaction.id })).ok).toBe(true);
    expect((await envBalances(db.admin, w.user)).get(w.home)).toBe(5_000_000n);
    // spend everything, then restoring the old expense must be refused (would overdraw)
    expect((await A.createExpense.as(w.user, expense(w, '5000000', { date: '2026-10-02' }))).ok).toBe(true);
    const r = await A.restoreTransaction.as(w.user, { id: e.data.transaction.id });
    expect(!r.ok && r.error.code).toBe('INSUFFICIENT_FUNDS');
    const rev1 = Number((await db.admin.query(`SELECT ledger_revision::text AS r FROM users WHERE id = $1`, [w.user])).rows[0].r);
    expect(rev1).toBeGreaterThan(rev0);
    const audit = (await db.admin.query(`SELECT action FROM audit_log WHERE user_id = $1 AND entity = 'transaction' ORDER BY at`, [w.user])).rows.map((r) => r.action);
    expect(audit).toContain('create');
    expect(audit).toContain('delete');
  });

  it('the opening balance cannot be deleted while other transactions exist; loans redirect to the Loans UI', async () => {
    const w = await world();
    const opening = (await db.admin.query(`SELECT id FROM transactions WHERE user_id = $1 AND type = 'opening_balance'`, [w.user])).rows[0].id;
    const r = await A.deleteTransaction.as(w.user, { id: opening });
    expect(!r.ok && r.error.code).toBe('RULE_VIOLATION');
  });
});

describe('[URD-52] dates', () => {
  it('rejects future dates and accepts today', async () => {
    const w = await world();
    const future = await A.createExpense.as(w.user, expense(w, '100', { date: '2099-01-01' }));
    expect(!future.ok && future.error.fieldErrors?.date).toMatch(/future/);
    expect((await A.createExpense.as(w.user, expense(w, '100'))).ok).toBe(true);
  });
});

describe('[URD-44] mass assignment and scoping', () => {
  it('rejects user_id in input and cannot touch another user’s envelope', async () => {
    const a = await world();
    const b = await world();
    const mass = await A.createExpense.as(a.user, { ...expense(a, '100'), user_id: b.user });
    expect(!mass.ok && mass.error.code).toBe('VALIDATION');
    const cross = await A.createExpense.as(b.user, expense(a, '100')); // a's envelope id, b's session
    expect(!cross.ok && cross.error.code).toBe('NOT_FOUND');
    const del = await A.deleteTransaction.as(b.user, { id: (await db.admin.query(`SELECT id FROM transactions WHERE user_id = $1 LIMIT 1`, [a.user])).rows[0].id });
    expect(!del.ok && del.error.code).toBe('NOT_FOUND');
  });
});
