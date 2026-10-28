/**
 * Replace-import pipeline - TD-11 §4. Validation never writes; commit is one
 * transaction under the per-user advisory lock.
 */

import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import { getPool } from '@/server/db/client';
import { parseJsonSafe } from '@/domain/backup/canonical';
import { migrate } from '@/domain/backup/migrators';
import { BackupSchema, TABLE_ORDER, type BackupBody, type BackupDoc, type BackupTable } from '@/domain/backup/schema';
import { validateSnapshot, MAX_PROBLEMS, type Problem } from '@/domain/backup/validate-snapshot';
import { allIds, remapDoc } from '@/domain/backup/remap';
import { RateLimited } from '@/domain/errors';
import { checksumOf, sha256Hex } from './export';
import { verifyTimeline, type Queryable } from './verify';

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const IMPORTS_PER_HOUR = 3;

export type ValidateResult =
  | { ok: true; doc: BackupDoc; hash: string; schemaVersion: number; counts: Record<string, number> }
  | { ok: false; message: string; problems: Problem[]; totalProblems: number };

const fail = (message: string, problems: Problem[] = []): ValidateResult => ({
  ok: false,
  message,
  problems,
  totalProblems: problems.length,
});

/** Steps 1-4 of §4.3: size, JSON, version, shape, checksum, ledger rules. No writes. */
export function validateImportBytes(bytes: Uint8Array, today: string): ValidateResult {
  if (bytes.byteLength === 0) return fail('The file is empty.');
  if (bytes.byteLength > MAX_IMPORT_BYTES) return fail('This file is larger than 20 MB, so it can’t be a backup.');

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail("This file isn't text, so it can't be a backup.");
  }
  const parsed = parseJsonSafe(text.replace(/^﻿/, ''));
  if (!parsed.ok) return fail(parsed.message);

  const mig = migrate(parsed.value);
  if (!mig.ok) return fail(mig.message);

  const shape = BackupSchema.safeParse(mig.doc);
  if (!shape.success) {
    const problems = shape.error.issues.slice(0, MAX_PROBLEMS).map((i) => ({
      path: i.path.join('.') || '(file)',
      message: i.message,
    }));
    return { ok: false, message: 'The file is missing information or has unexpected content.', problems, totalProblems: shape.error.issues.length };
  }
  const doc = shape.data;

  if (checksumOf(doc) !== doc.checksum) {
    return fail('This backup has been changed or damaged since it was exported (checksum mismatch).');
  }

  const report = validateSnapshot(doc, today);
  if (!report.ok) {
    return { ok: false, message: 'The history in this file is not consistent, so nothing was imported.', problems: report.problems, totalProblems: report.totalProblems };
  }

  const counts: Record<string, number> = {};
  for (const t of TABLE_ORDER) counts[t] = doc[t].length;
  return { ok: true, doc, hash: sha256Hex(bytes as Buffer), schemaVersion: (parsed.value as { schema_version: number }).schema_version, counts };
}

// ---------------------------------------------------------------------------

interface Client extends Queryable {
  release: () => void;
}

const COLUMNS: Record<BackupTable, string[]> = {
  categories: ['id', 'name', 'kind', 'group_name', 'status', 'is_system', 'sort_order', 'created_at', 'updated_at'],
  envelopes: ['id', 'name', 'description', 'icon', 'color', 'owner_type', 'owner_name', 'kind', 'goal_amount_paisa', 'status', 'archived_at', 'sort_order', 'created_at', 'updated_at'],
  loans: ['id', 'lender_envelope_id', 'borrower_envelope_id', 'note', 'deleted_at', 'created_at', 'updated_at'],
  recurring_rules: ['id', 'name', 'type', 'amount_paisa', 'envelope_id', 'category_id', 'split_template', 'frequency', 'interval_n', 'anchor_day', 'start_date', 'end_date', 'max_occurrences', 'status', 'pause_reason', 'is_committee', 'next_slot_index', 'version', 'created_at', 'updated_at'],
  transactions: ['id', 'type', 'amount_paisa', 'occurred_on', 'occurred_at', 'envelope_id', 'counterpart_envelope_id', 'category_id', 'note', 'loan_id', 'recurring_id', 'is_generated', 'parent_transaction_id', 'deleted_at', 'version', 'created_at', 'updated_at'],
  transaction_splits: ['id', 'transaction_id', 'envelope_id', 'amount_paisa'],
  recurring_occurrences: ['id', 'rule_id', 'slot_index', 'due_date', 'status', 'transaction_id', 'note', 'created_at', 'updated_at'],
  reconciliations: ['id', 'checked_at', 'checked_on', 'expected_paisa', 'actual_paisa', 'difference_paisa', 'note', 'adjustment_transaction_id', 'tx_count_at_check', 'ledger_revision', 'ledger_hash', 'deleted_at', 'created_at', 'updated_at'],
  audit_log: ['id', 'entity', 'entity_id', 'action', 'before_json', 'after_json', 'at'],
};
const JSON_COLS = new Set(['split_template', 'before_json', 'after_json']);

/** Parents before children for the transactions self-FK. */
function orderTransactions(rows: BackupBody['transactions']): BackupBody['transactions'] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: typeof rows = [];
  const done = new Set<string>();
  const visit = (r: (typeof rows)[number]) => {
    if (done.has(r.id)) return;
    done.add(r.id);
    const parent = r.parent_transaction_id ? byId.get(r.parent_transaction_id) : undefined;
    if (parent) visit(parent);
    out.push(r);
  };
  rows.forEach(visit);
  return out;
}

async function insertRows(q: Queryable, table: BackupTable, userId: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;
  const cols = ['user_id', ...COLUMNS[table]];
  const batch = Math.max(1, Math.min(1000, Math.floor(60000 / cols.length)));
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const ph: string[] = [];
      params.push(userId);
      ph.push(`$${params.length}`);
      for (const c of COLUMNS[table]) {
        const v = row[c] ?? null;
        params.push(JSON_COLS.has(c) ? (v === null ? null : JSON.stringify(v)) : v);
        ph.push(`$${params.length}`);
      }
      return `(${ph.join(',')})`;
    });
    await q.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
  }
}

export interface ImportResult {
  counts: Record<string, number>;
  remapped: boolean;
  sameAsPrevious: boolean;
  before: { total: string; unallocated: string };
  after: { total: string; unallocated: string };
}

async function totalsOf(q: Queryable, userId: string) {
  const { rows } = await q.query(`SELECT total_paisa::text AS t, envelopes_paisa::text AS e FROM ledger_totals WHERE user_id = $1`, [userId]);
  const t = BigInt(String(rows[0]?.t ?? 0));
  const e = BigInt(String(rows[0]?.e ?? 0));
  return { total: t.toString(), unallocated: (t - e).toString() };
}

export class ImportIntegrityError extends Error {}

export async function commitImport(userId: string, valid: Extract<ValidateResult, { ok: true }>): Promise<ImportResult> {
  const client = (await (getPool() as unknown as { connect: () => Promise<Client> }).connect()) as Client;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    // rate limit: 3 imports / hour (§4.2)
    const recent = await client.query(`SELECT count(*)::int AS n FROM import_runs WHERE user_id = $1 AND imported_at > now() - interval '1 hour'`, [userId]);
    if (Number(recent.rows[0]?.n ?? 0) >= IMPORTS_PER_HOUR) throw new RateLimited(3600);

    const prev = await client.query(`SELECT file_hash FROM import_runs WHERE user_id = $1 ORDER BY imported_at DESC LIMIT 1`, [userId]);
    const sameAsPrevious = prev.rows[0]?.file_hash === valid.hash;
    const before = await totalsOf(client, userId);

    // wipe (FK-safe order); keep users + sessions
    for (const t of ['audit_log', 'reconciliations', 'recurring_occurrences', 'transaction_splits', 'transactions', 'loans', 'recurring_rules', 'envelopes', 'categories', 'idempotency_keys']) {
      await client.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    }

    // id strategy: preserve unless any id collides with ANOTHER user's row
    let doc: BackupBody = valid.doc;
    const ids = allIds(doc);
    const collision = Boolean((await client.query('SELECT import_id_collision($1::uuid[], $2::uuid) AS c', [ids, userId])).rows[0]?.c);
    if (collision) doc = remapDoc(doc, userId, (name, ns) => uuidv5(name, ns));

    const tables: Record<BackupTable, Array<Record<string, unknown>>> = {
      categories: doc.categories,
      envelopes: doc.envelopes,
      loans: doc.loans,
      recurring_rules: doc.recurring_rules,
      transactions: orderTransactions(doc.transactions),
      transaction_splits: doc.transaction_splits,
      recurring_occurrences: doc.recurring_occurrences,
      reconciliations: doc.reconciliations,
      audit_log: doc.audit_log,
    };
    for (const t of TABLE_ORDER) await insertRows(client, t, userId, tables[t]);

    // preferences from the profile (never email/password/name)
    const p = doc.profile;
    await client.query(
      `UPDATE users SET timezone = $2, theme = $3, number_grouping = $4, week_start = $5, hide_balances_default = $6,
              ledger_revision = ledger_revision + 1, onboarding_completed_at = COALESCE(onboarding_completed_at, now())
       WHERE id = $1`,
      [userId, p.timezone, p.theme, p.number_grouping, p.week_start, p.hide_balances_default]
    );

    // belt and braces: the live verifier on the imported state
    const violation = await verifyTimeline(client, userId, null);
    if (violation) throw new ImportIntegrityError(`Import failed integrity check (${violation.kind} on ${violation.on}); nothing was changed.`);
    const tot = await client.query(`SELECT total_paisa::text AS t, envelopes_paisa::text AS e FROM ledger_totals WHERE user_id = $1`, [userId]);
    const explicit = await client.query(`SELECT COALESCE(SUM(delta),0)::text AS u FROM ledger_effects WHERE user_id = $1 AND account = 'UNALLOCATED'`, [userId]);
    const derivedU = BigInt(String(tot.rows[0]?.t ?? 0)) - BigInt(String(tot.rows[0]?.e ?? 0));
    if (derivedU !== BigInt(String(explicit.rows[0]?.u ?? 0))) throw new ImportIntegrityError('Import failed integrity check (Unallocated mismatch); nothing was changed.');

    await client.query(
      `INSERT INTO import_runs (id, user_id, file_hash, schema_version, counts) VALUES ($1,$2,$3,$4,$5)`,
      [uuidv7(), userId, valid.hash, valid.schemaVersion, JSON.stringify(valid.counts)]
    );
    const after = await totalsOf(client, userId);
    await client.query('COMMIT');
    return { counts: valid.counts, remapped: collision, sameAsPrevious, before, after };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
