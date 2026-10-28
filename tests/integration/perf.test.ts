import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, stopEmbedded, type TestDb } from '../helpers/db';
import { createCategory, createEnvelope, createUser } from '../helpers/seed';

/**
 * TD-12 §8.2: EXPLAIN regression for the hottest queries at ~50k transactions
 * (20 users x 2,500), asserting index use and a generous runtime budget.
 */
let db: TestDb;
let user: string;
let home: string;
let light: string;

beforeAll(async () => {
  db = await createTestDb();
  Object.assign(process.env, { DATABASE_URL: db.url, DATABASE_URL_UNPOOLED: db.url, AUTH_URL: 'http://localhost:3000', AUTH_SECRET: 'x'.repeat(40), CRON_SECRET: 'y'.repeat(40) });
  // one heavy user (25k rows) + 25 light users (1k rows each) ~ 50k total
  const seed = async (rows: number) => {
    const u = await createUser(db.admin);
    const h = await createEnvelope(db.admin, u, 'Home');
    const cat = await createCategory(db.admin, u, 'expense');
    await db.admin.query(`INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at) VALUES (gen_random_uuid(), $1, 'opening_balance', 9000000000, '2020-01-01', '00:00:00')`, [u]);
    await db.admin.query(`INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id) VALUES (gen_random_uuid(), $1, 'allocation', 9000000000, '2020-01-01', '00:00:01', $2)`, [u, h]);
    await db.admin.query(
      `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, category_id, created_at)
       SELECT gen_random_uuid(), $1, 'expense', 100 + (g % 900), DATE '2021-01-01' + (g % 1500), TIME '09:00:00' + (g % 600) * interval '1 second', $2, $3, now() - (g || ' seconds')::interval
       FROM generate_series(1, $4::int) g`,
      [u, h, cat, rows]
    );
    return { u, h };
  };
  ({ u: user, h: home } = await seed(25_000));
  for (let i = 0; i < 25; i++) {
    const l = await seed(1_000);
    if (i === 0) light = l.u;
  }
  await db.admin.query('ANALYZE');
}, 240_000);
afterAll(async () => {
  await (await import('@/server/db/client')).closePool();
  await db?.stop();
  await stopEmbedded();
});

async function plan(sql: string, params: unknown[]) {
  if (process.env.PLAN) console.log('PLANTXT', (await db.admin.query(`EXPLAIN (ANALYZE) ${sql}`, params)).rows.map((x) => x['QUERY PLAN']).join('\n'));
  const r = await db.admin.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
  const root = (r.rows[0]['QUERY PLAN'] as Array<{ Plan: unknown; 'Execution Time': number }>)[0]!;
  const text = JSON.stringify(root.Plan);
  return { ms: root['Execution Time'], seqScansOnTx: [...text.matchAll(/"Node Type":"Seq Scan","[^}]*?"Relation Name":"transactions"/g)].length };
}

describe('[perf] hot queries at ~50k transactions use indexes and stay fast', () => {
  it('dashboard totals (ledger_totals): indexed for a typical user, fast for the heaviest', async () => {
    const typical = await plan(`SELECT total_paisa FROM ledger_totals WHERE user_id = $1`, [light]);
    expect(typical.seqScansOnTx).toBe(0); // never scans other users' ledgers
    expect(typical.ms).toBeLessThan(100);
    const heavy = await plan(`SELECT total_paisa FROM ledger_totals WHERE user_id = $1`, [user]);
    expect(heavy.ms).toBeLessThan(300);
  });

  it('envelope balances and stats', async () => {
    for (const view of ['envelope_balances', 'envelope_stats']) {
      const typical = await plan(`SELECT * FROM ${view} WHERE user_id = $1`, [light]);
      expect(typical.seqScansOnTx, view).toBe(0);
      expect((await plan(`SELECT * FROM ${view} WHERE user_id = $1`, [user])).ms, view).toBeLessThan(300);
    }
  });

  it('recent / keyset transaction list', async () => {
    const p = await plan(
      `SELECT id FROM transactions WHERE user_id = $1 AND deleted_at IS NULL
         AND (occurred_on, occurred_at, created_at, id) < ($2::date, $3::time, now(), $4::uuid)
       ORDER BY occurred_on DESC, occurred_at DESC, created_at DESC, id DESC LIMIT 30`,
      [user, '2025-01-01', '12:00:00', '00000000-0000-0000-0000-000000000000']
    );
    expect(p.seqScansOnTx).toBe(0);
    expect(p.ms).toBeLessThan(100);
  });

  it('timeline verifier (all accounts) stays under budget', async () => {
    const { verifyTimeline } = await import('@/server/backup/verify');
    const t0 = performance.now();
    expect(await verifyTimeline(db.admin, user, [home])).toBeNull();  // the 25k-row user
    expect(performance.now() - t0).toBeLessThan(800);
  });

  it('analytics by category: < 300 ms', async () => {
    const { getAnalytics } = await import('@/server/repositories/analytics');
    const t0 = performance.now();
    const a = await getAnalytics(user, { from: '2021-01-01', to: '2025-12-31', includeHeld: false, includeDaily: false });
    expect(a.byCategory.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it('dashboard read model: < 300 ms', async () => {
    const { getDashboard } = await import('@/server/queries/dashboard');
    await getDashboard(user, 'Asia/Karachi'); // warm
    const t0 = performance.now();
    await getDashboard(user, 'Asia/Karachi');
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
