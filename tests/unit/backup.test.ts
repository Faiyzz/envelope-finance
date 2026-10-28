import { describe, expect, it } from 'vitest';
import { v5 as uuidv5 } from 'uuid';
import { validateSnapshot, MAX_PROBLEMS } from '@/domain/backup/validate-snapshot';
import { canonicalJson, jsonDepth, parseJsonSafe } from '@/domain/backup/canonical';
import { migrate, type Migrator } from '@/domain/backup/migrators';
import { remapDoc, allIds } from '@/domain/backup/remap';
import { BackupSchema } from '@/domain/backup/schema';
import { balancesOf, type LedgerTx } from '@/domain/ledger/effects';
import { validateImportBytes } from '@/server/backup/import';
import { makeFixture, sealed, sha, toBytes } from '../helpers/backup-fixture';

const TODAY = '2026-10-06';

const ledger = (b: ReturnType<typeof makeFixture>['body']): LedgerTx[] =>
  b.transactions.filter((t) => !t.deleted_at).map((t) => ({
    id: t.id, type: t.type, amountPaisa: BigInt(t.amount_paisa), occurredOn: t.occurred_on, occurredAt: t.occurred_at,
    createdAt: t.created_at, envelopeId: t.envelope_id, counterpartEnvelopeId: t.counterpart_envelope_id,
  }));

describe('[URD-48] snapshot validation', () => {
  it('accepts a consistent ledger (reference-scenario-like)', () => {
    const { body } = makeFixture();
    const r = validateSnapshot(body, TODAY);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    // Total 200,000; Unallocated 20,000 (200k - 50k - 80k - 20k - ... loans/expense net)
    const b = balancesOf(ledger(body));
    expect(b.total).toBe(20000000n - 250000n);
    expect(b.unallocated).toBe(20000000n - 250000n - (5000000n + 8000000n + 2000000n - 250000n));
  });

  it('rejects a negative running balance with the first violating date and envelope', () => {
    const { body, ids } = makeFixture();
    body.transactions.find((t) => t.id === ids.exp)!.amount_paisa = '9000000'; // more than Home holds
    const r = validateSnapshot(body, TODAY);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => /Home would be .* below zero on 2026-10-02/.test(p.message))).toBe(true);
  });

  it('rejects an orphan loan transaction and an orphan repayment', () => {
    const { body, ids } = makeFixture();
    body.loans = []; // loan txs now point at a loan that is not in the file
    const r = validateSnapshot(body, TODAY);
    expect(r.problems.some((p) => /loan that is not in the file/.test(p.message))).toBe(true);

    const f2 = makeFixture();
    f2.body.transactions = f2.body.transactions.filter((t) => t.id !== f2.ids.loanTx); // repayment with no origin
    const r2 = validateSnapshot(f2.body, TODAY);
    expect(r2.ok).toBe(false);
    expect(r2.problems.some((p) => /starting transactions|over-repaid/.test(p.message))).toBe(true);
    void ids;
  });

  it('rejects duplicate opening balances, bad FKs, future dates, and held-money rules', () => {
    const a = makeFixture();
    a.body.transactions.push({ ...a.body.transactions[0]!, id: '00000000-0000-4000-8000-0000000000aa' });
    expect(validateSnapshot(a.body, TODAY).problems.some((p) => /opening balances/.test(p.message))).toBe(true);

    const b = makeFixture();
    b.body.transactions.find((t) => t.id === b.ids.exp)!.envelope_id = '00000000-0000-4000-8000-0000000000bb';
    expect(validateSnapshot(b.body, TODAY).problems.some((p) => /envelope that is not in the file/.test(p.message))).toBe(true);

    const c = makeFixture();
    c.body.transactions.find((t) => t.id === c.ids.exp)!.occurred_on = '2026-12-01';
    expect(validateSnapshot(c.body, TODAY).problems.some((p) => /future/.test(p.message))).toBe(true);

    const d = makeFixture(); // lending Ahmed's money is not allowed
    d.body.loans[0]!.lender_envelope_id = d.ids.ahmed;
    d.body.transactions.find((t) => t.id === d.ids.loanTx)!.envelope_id = d.ids.ahmed;
    expect(validateSnapshot(d.body, TODAY).problems.some((p) => /held for others/i.test(p.message))).toBe(true);
  });

  it('caps the report at 20 problems but counts them all', () => {
    const { body } = makeFixture();
    for (let i = 0; i < 40; i++) body.transactions.push({ ...body.transactions[4]!, id: `00000000-0000-4000-8000-${(0x1000 + i).toString(16).padStart(12, '0')}`, envelope_id: '00000000-0000-4000-8000-0000000000cc' });
    const r = validateSnapshot(body, TODAY);
    expect(r.problems.length).toBe(MAX_PROBLEMS);
    expect(r.totalProblems).toBeGreaterThan(MAX_PROBLEMS);
  });
});

describe('[URD-48] import bytes pipeline', () => {
  it('accepts a sealed valid backup and reports counts', () => {
    const { body } = makeFixture();
    const r = validateImportBytes(toBytes(sealed(body)), TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.counts.transactions).toBe(7);
  });

  it('rejects a tampered checksum, non-JSON, empty, deep nesting, and oversize', () => {
    const { body } = makeFixture();
    const doc = sealed(body);
    doc.transactions[0]!.amount_paisa = '20000001';
    const bad = validateImportBytes(toBytes(doc), TODAY);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/checksum|damaged/i);

    expect(validateImportBytes(new TextEncoder().encode('not json'), TODAY).ok).toBe(false);
    expect(validateImportBytes(new Uint8Array(0), TODAY).ok).toBe(false);
    expect(validateImportBytes(new TextEncoder().encode('['.repeat(50) + ']'.repeat(50)), TODAY).ok).toBe(false);
    const huge = validateImportBytes(new Uint8Array(20 * 1024 * 1024 + 1), TODAY);
    expect(huge.ok).toBe(false);
  });

  it('rejects future and malformed schema versions with readable messages', () => {
    const { body } = makeFixture();
    const future = validateImportBytes(toBytes({ ...sealed(body), schema_version: 99 }), TODAY);
    expect(!future.ok && future.message).toMatch(/newer version/);
    const junk = validateImportBytes(toBytes({ hello: 'world' }), TODAY);
    expect(!junk.ok && junk.message).toMatch(/Envelope Finance backup/);
  });

  it('rejects unknown keys and prototype-pollution keys via the strict schema', () => {
    const { body } = makeFixture();
    const doc = sealed(body) as unknown as Record<string, unknown>;
    doc.extra = 1;
    expect(BackupSchema.safeParse(doc).success).toBe(false);
    const text = JSON.stringify(sealed(body)).replace('"schema_version":1', '"schema_version":1,"__proto__":{"x":1}');
    const r = validateImportBytes(new TextEncoder().encode(text), TODAY);
    expect(r.ok).toBe(false);
  });

  it('rejects a corrupted ledger even when the checksum is valid (sealed after corruption)', () => {
    const { body, ids } = makeFixture();
    body.transactions.find((t) => t.id === ids.exp)!.amount_paisa = '9000000';
    const r = validateImportBytes(toBytes(sealed(body)), TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.totalProblems).toBeGreaterThan(0);
  });
});

describe('canonical json + safe parse', () => {
  it('is key-order independent and deterministic', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(sha(canonicalJson({ a: 1 }))).toBe(sha(canonicalJson({ a: 1 })));
  });
  it('measures depth string-aware', () => {
    expect(jsonDepth('{"a":"[[[[["}')).toBe(1);
    expect(jsonDepth('[[[1]]]')).toBe(3);
    expect(parseJsonSafe('['.repeat(30) + ']'.repeat(30)).ok).toBe(false);
  });
});

describe('migrators framework', () => {
  const steps: Record<number, Migrator> = {
    1: (d) => ({ ...d, added_in_v2: true }),
    2: (d) => ({ ...d, added_in_v3: true }),
  };
  it('chains n -> n+1 and stamps the version', () => {
    const r = migrate({ schema_version: 1 }, steps, 3);
    expect(r.ok && r.doc).toEqual({ schema_version: 3, added_in_v2: true, added_in_v3: true });
  });
  it('identity at the current version; rejects newer or missing steps', () => {
    expect(migrate({ schema_version: 1 }).ok).toBe(true);
    expect(migrate({ schema_version: 5 }, {}, 3).ok).toBe(false);
    expect(migrate({ schema_version: 1 }, {}, 2).ok).toBe(false);
  });
});

describe('id remap (TD-D9)', () => {
  it('is deterministic, consistent across FKs, and preserves balances', () => {
    const { body } = makeFixture();
    const user = '11111111-1111-4111-8111-111111111111';
    const v5 = (name: string, ns: string) => uuidv5(name, ns);
    const a = remapDoc(body, user, v5);
    const b = remapDoc(body, user, v5);
    expect(a).toEqual(b);
    expect(new Set(allIds(a)).size).toBe(allIds(body).length);
    expect(allIds(a).some((x) => allIds(body).includes(x))).toBe(false);
    expect(validateSnapshot(a, TODAY).problems).toEqual([]);
    expect(balancesOf(ledger(a)).total).toBe(balancesOf(ledger(body)).total);
    expect(a.loans[0]!.lender_envelope_id).toBe(a.envelopes.find((e) => e.name === 'Personal')!.id);
  });
});
