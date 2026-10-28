import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, stopEmbedded, type TestDb } from '../helpers/db';
import { createUser } from '../helpers/seed';
import { makeFixture, sealed, toBytes } from '../helpers/backup-fixture';

let db: TestDb;
let userId: string;

beforeAll(async () => {
  db = await createTestDb();
  Object.assign(process.env, { DATABASE_URL: db.url, DATABASE_URL_UNPOOLED: db.url, AUTH_URL: 'http://localhost:3000', AUTH_SECRET: 'x'.repeat(40), CRON_SECRET: 'y'.repeat(40) });
  const imp = await import('@/server/backup/import');
  userId = await createUser(db.admin);
  const v = imp.validateImportBytes(toBytes(sealed(makeFixture().body)), '2026-10-06');
  if (!v.ok) throw new Error(JSON.stringify(v));
  await imp.commitImport(userId, v);
}, 120_000);
afterAll(async () => {
  await (await import('@/server/db/client')).closePool();
  await db?.stop();
  await stopEmbedded();
});

describe('[URD-51] dashboard + quick-add read models on a live database', () => {
  it('computes Total / Your Money / Held / Unallocated from the ledger', async () => {
    const { getDashboard } = await import('@/server/queries/dashboard');
    const d = await getDashboard(userId, 'Asia/Karachi');
    expect(d.total).toBe('19750000'); // 200,000 - 2,500 expense
    expect(d.heldForOthers).toBe('2000000');
    // Unallocated = total - Σ envelopes; Your Money = Unallocated + mine envelopes
    const envSum = d.envelopes.reduce((s, e) => s + BigInt(e.balance), 0n);
    expect(BigInt(d.unallocated)).toBe(BigInt(d.total) - envSum);
    const mine = d.envelopes.filter((e) => e.ownerType === 'mine').reduce((s, e) => s + BigInt(e.balance), 0n);
    expect(BigInt(d.yourMoney)).toBe(BigInt(d.unallocated) + mine);
    expect(BigInt(d.yourMoney) + BigInt(d.heldForOthers)).toBe(BigInt(d.total)); // INV-1
    expect(d.setup).toEqual({ hasOpeningBalance: true, hasEnvelopes: true });
    expect(d.recon.status).toBe('never_verified');
    expect(d.recent.length).toBe(5);
    expect(d.recent[0]!.occurredOn >= d.recent[1]!.occurredOn).toBe(true);
    const home = d.envelopes.find((e) => e.name === 'Home')!;
    expect(home.balance).toBe((5000000n - 250000n + 500000n - 200000n).toString()); // alloc - expense + loan in - repaid
  });

  it('quick-add defaults come from the database', async () => {
    const { getQuickAddData } = await import('@/server/queries/quick-add');
    const q = await getQuickAddData(userId, 'Asia/Karachi');
    expect(q.envelopes.map((e) => e.name)).toEqual(['Home', 'Personal', 'Ahmed']); // mine first
    expect(q.lastEnvelopeId).toBe(q.envelopes.find((e) => e.name === 'Home')!.id);
    const groceries = q.categories.find((c) => c.name === 'Groceries')!;
    expect(q.recentByEnvelope[q.lastEnvelopeId!]).toEqual([groceries.id]);
    expect(q.categories.some((c) => c.isSystem)).toBe(true);
    expect(BigInt(q.unallocated)).toBeGreaterThanOrEqual(0n);
  });

  it('offline snapshot payload returns the latest transactions', async () => {
    const { getRecent100 } = await import('@/server/queries/snapshot');
    const rows = await getRecent100(userId);
    expect(rows.length).toBe(7);
  });
});
