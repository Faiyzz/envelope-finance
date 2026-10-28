import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, stopEmbedded, type TestDb } from '../helpers/db';
import { createCategory, createEnvelope, createUser, insertTx, uid } from '../helpers/seed';
import { makeFixture, sealed, toBytes } from '../helpers/backup-fixture';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  Object.assign(process.env, { DATABASE_URL: db.url, DATABASE_URL_UNPOOLED: db.url, AUTH_URL: 'http://localhost:3000', AUTH_SECRET: 'x'.repeat(40), CRON_SECRET: 'y'.repeat(40) });
}, 120_000);
afterAll(async () => {
  await (await import('@/server/db/client')).closePool();
  await db?.stop();
  await stopEmbedded();
});

describe('integrity check (FR-INT-03): reports, never repairs', () => {
  it('is clean for a consistent ledger', async () => {
    const { runIntegrityCheck } = await import('@/server/db/integrity');
    const imp = await import('@/server/backup/import');
    const user = await createUser(db.admin);
    const v = imp.validateImportBytes(toBytes(sealed(makeFixture().body)), '2026-10-06');
    if (!v.ok) throw new Error('fixture');
    await imp.commitImport(user, v);
    expect(await runIntegrityCheck(user)).toMatchObject({ ok: true, findings: [] });
  });

  it('detects a broken timeline and an archived envelope that still holds money, without modifying anything', async () => {
    const { runIntegrityCheck } = await import('@/server/db/integrity');
    const user = await createUser(db.admin);
    const home = await createEnvelope(db.admin, user, 'Home');
    const old = await createEnvelope(db.admin, user, 'Old');
    const catE = await createCategory(db.admin, user, 'expense');
    await insertTx(db.admin, { userId: user, type: 'opening_balance', amount: 100_000n, at: '00:00:00' });
    const alloc = await insertTx(db.admin, { userId: user, type: 'allocation', amount: 50_000n, envelopeId: home, at: '00:00:01' });
    await insertTx(db.admin, { userId: user, type: 'expense', amount: 20_000n, envelopeId: home, categoryId: catE, on: '2026-10-02' });
    await insertTx(db.admin, { userId: user, type: 'allocation', amount: 1_000n, envelopeId: old, at: '00:00:02' });
    await db.admin.query(`UPDATE envelopes SET status = 'archived', archived_at = now() WHERE id = $1`, [old]);
    await db.admin.query(`UPDATE transactions SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [alloc, user]); // funding vanishes

    const before = (await db.admin.query(`SELECT count(*)::int AS n, max(version) AS v FROM transactions WHERE user_id = $1`, [user])).rows[0];
    const report = await runIntegrityCheck(user);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['I2', 'I7']));
    expect(report.findings.find((f) => f.id === 'I7')!.message).toMatch(/“Old” is archived but still holds 10 PKR/);
    const after = (await db.admin.query(`SELECT count(*)::int AS n, max(version) AS v FROM transactions WHERE user_id = $1`, [user])).rows[0];
    expect(after).toEqual(before); // never auto-fixed
  });
});

describe('nightly tasks are idempotent', () => {
  it('purges only transactions deleted more than 30 days ago', async () => {
    const { tasks } = await import('@/server/jobs/tasks');
    const user = await createUser(db.admin);
    await insertTx(db.admin, { userId: user, type: 'opening_balance', amount: 1n, at: '00:00:00' });
    const old = await insertTx(db.admin, { userId: user, type: 'adjustment', amount: 5n, on: '2026-09-01' });
    const recent = await insertTx(db.admin, { userId: user, type: 'adjustment', amount: 6n, on: '2026-09-02' });
    await db.admin.query(`UPDATE transactions SET deleted_at = now() - interval '31 days', deleted_by = $2 WHERE id = $1`, [old, user]);
    await db.admin.query(`UPDATE transactions SET deleted_at = now() - interval '29 days', deleted_by = $2 WHERE id = $1`, [recent, user]);
    expect((await tasks['deleted.purge']!()).count).toBeGreaterThanOrEqual(1);
    const ids = (await db.admin.query(`SELECT id FROM transactions WHERE user_id = $1`, [user])).rows.map((r) => r.id);
    expect(ids).not.toContain(old);
    expect(ids).toContain(recent);
    expect((await tasks['deleted.purge']!()).count).toBe(0); // second run: nothing left
  });

  it('expires idempotency keys after 24 h and cleans stale auth rows', async () => {
    const { tasks } = await import('@/server/jobs/tasks');
    const user = await createUser(db.admin);
    await db.admin.query(`INSERT INTO idempotency_keys (user_id, key, action, request_hash, response, expires_at) VALUES ($1,$2,'x','h','{}', now() - interval '1 minute')`, [user, uid()]);
    await db.admin.query(`INSERT INTO idempotency_keys (user_id, key, action, request_hash, response) VALUES ($1,$2,'x','h','{}')`, [user, uid()]);
    await db.admin.query(`INSERT INTO login_attempts (email, ip_hash, succeeded, at) VALUES ('a@b.c','h', false, now() - interval '3 days')`);
    expect((await tasks['idempotency.cleanup']!()).count).toBeGreaterThanOrEqual(1);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE user_id = $1`, [user])).rows[0].n).toBe(1);
    expect((await tasks['auth.cleanup']!()).count).toBeGreaterThanOrEqual(1);
  });

  it('integrity.check records a run per user and reports failures', async () => {
    const { tasks } = await import('@/server/jobs/tasks');
    const r = await tasks['integrity.check']!();
    expect(r.count).toBeGreaterThanOrEqual(1); // the corrupted user from above
    expect(Number((await db.admin.query(`SELECT count(*)::int AS n FROM integrity_runs`)).rows[0].n)).toBeGreaterThan(0);
  });
});
