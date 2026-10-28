import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, stopEmbedded, type TestDb } from '../helpers/db';
import { createUser, envBalances, totals } from '../helpers/seed';
import { makeFixture, sealed, toBytes } from '../helpers/backup-fixture';
import { canonicalJson } from '@/domain/backup/canonical';
import type { BackupDoc } from '@/domain/backup/schema';

let db: TestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let imp: typeof import('@/server/backup/import');
let exp: typeof import('@/server/backup/export');
const TODAY = '2026-10-06';

beforeAll(async () => {
  db = await createTestDb();
  Object.assign(process.env, {
    DATABASE_URL: db.url, DATABASE_URL_UNPOOLED: db.url, AUTH_URL: 'http://localhost:3000',
    AUTH_SECRET: 'x'.repeat(40), CRON_SECRET: 'y'.repeat(40),
  });
  imp = await import('@/server/backup/import');
  exp = await import('@/server/backup/export');
}, 120_000);
afterAll(async () => {
  await (await import('@/server/db/client')).closePool();
  await db?.stop();
  await stopEmbedded();
});

/** Normalised view of a backup for equality checks (drops volatile fields). */
function canon(doc: BackupDoc, { ids = true }: { ids?: boolean } = {}) {
  const { exported_at: _e, checksum: _c, app_version: _a, audit_log: _l, profile, ...rest } = doc;
  const fix = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(/\.(\d{3})000Z/g, '.$1Z'));
  const sorted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) sorted[k] = Array.isArray(v) ? [...(fix(v) as Array<{ id?: string }>)].sort((a, b) => String(a.id).localeCompare(String(b.id))) : v;
  void ids;
  return canonicalJson({ ...sorted, profile: { ...profile, email: '', name: '' } });
}

async function importFor(userId: string, doc: BackupDoc) {
  const valid = imp.validateImportBytes(toBytes(doc), TODAY);
  expect(valid.ok, JSON.stringify(valid)).toBe(true);
  if (!valid.ok) throw new Error('invalid');
  return imp.commitImport(userId, valid);
}

describe('[URD-48] export -> import round trip (live database)', () => {
  it('imports a fixture, exports it back identically, and re-import is idempotent', async () => {
    const { body } = makeFixture();
    const doc = sealed(body);
    const user = await createUser(db.admin);

    const res = await importFor(user, doc);
    expect(res.counts.transactions).toBe(7);
    expect(res.remapped).toBe(false);
    expect(res.after.total).toBe('19750000'); // 200,000 - 2,500

    const out = await exp.buildBackup(user);
    expect(canon(out)).toBe(canon(doc));
    expect(out.checksum).toMatch(/^[0-9a-f]{64}$/);

    // exported file passes our own validator (self-consistent format)
    expect(imp.validateImportBytes(toBytes(out), TODAY).ok).toBe(true);

    // same file again -> identical data, and the UI is told it's identical
    const again = await importFor(user, doc);
    expect(again.sameAsPrevious).toBe(true);
    expect(canon(await exp.buildBackup(user))).toBe(canon(doc));
  });

  it('into a second account: ids collide -> deterministic remap, balances identical', async () => {
    const { body } = makeFixture();
    const doc = sealed(body);
    const a = await createUser(db.admin);
    const b = await createUser(db.admin);
    await importFor(a, doc);
    const res = await importFor(b, doc);
    expect(res.remapped).toBe(true);

    const ta = await totals(db.admin, a);
    const tb = await totals(db.admin, b);
    expect(tb).toEqual(ta);
    const ba = [...(await envBalances(db.admin, a)).values()].sort();
    const bb = [...(await envBalances(db.admin, b)).values()].sort();
    expect(bb).toEqual(ba);

    // user A's data is untouched by B's import
    expect(canon(await exp.buildBackup(a))).toBe(canon(doc));
    // ids differ, and re-importing into B is stable (deterministic v5)
    const ids1 = (await exp.buildBackup(b)).transactions.map((t) => t.id).sort();
    await importFor(b, doc);
    expect((await exp.buildBackup(b)).transactions.map((t) => t.id).sort()).toEqual(ids1);
  });

  it('a corrupted ledger is rejected before any write; the account is untouched', async () => {
    const good = sealed(makeFixture().body);
    const user = await createUser(db.admin);
    await importFor(user, good);
    const before = canon(await exp.buildBackup(user));

    const { body, ids } = makeFixture();
    body.transactions.find((t) => t.id === ids.exp)!.amount_paisa = '9000000';
    const r = imp.validateImportBytes(toBytes(sealed(body)), TODAY);
    expect(r.ok).toBe(false);
    expect(canon(await exp.buildBackup(user))).toBe(before);
  });

  it('a failure inside the commit rolls everything back (atomic)', async () => {
    const good = sealed(makeFixture().body);
    const user = await createUser(db.admin);
    await importFor(user, good);
    const before = canon(await exp.buildBackup(user));

    // bypass validation with a row the DB itself rejects (expense without a category)
    const bad = makeFixture();
    const tx = bad.body.transactions.find((t) => t.id === bad.ids.exp)!;
    tx.category_id = null;
    const valid = { ok: true as const, doc: sealed(bad.body), hash: 'h', schemaVersion: 1, counts: {} };
    await expect(imp.commitImport(user, valid)).rejects.toThrow();
    expect(canon(await exp.buildBackup(user))).toBe(before);
    expect((await totals(db.admin, user)).total).toBe(19750000n);
  });

  it('allows at most 3 imports per hour', async () => {
    const doc = sealed(makeFixture().body);
    const user = await createUser(db.admin);
    await importFor(user, doc);
    await importFor(user, doc);
    await importFor(user, doc);
    await expect(importFor(user, doc)).rejects.toThrow(/Rate limited/i);
  });
});

describe('CSV export from the live database', () => {
  it('exports signed effects, neutralises hostile text, and honours the date range', async () => {
    const { body, ids } = makeFixture();
    body.envelopes.find((e) => e.id === ids.home)!.name = '=HYPERLINK("http://evil")';
    const user = await createUser(db.admin);
    await importFor(user, sealed(body));

    const all = await exp.buildCsv(user, 'transactions', {});
    expect(all.startsWith('﻿')).toBe(true);
    expect(all).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(all).toContain('-2500.00'); // the expense
    const only = await exp.buildCsv(user, 'expenses', {});
    expect(only.split('\r\n').filter(Boolean).length).toBe(2); // header + 1 expense
    const ranged = await exp.buildCsv(user, 'transactions', { from: '2026-10-03', to: '2026-10-03' });
    expect(ranged.split('\r\n').filter(Boolean).length).toBe(2); // header + the loan
    expect(await exp.buildCsv(user, 'reconciliations', {})).toContain('checked_at');
  });
});
