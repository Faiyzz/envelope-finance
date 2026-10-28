/**
 * Backup + CSV export - TD-11 §2, §3.
 * One REPEATABLE READ read-only transaction so all tables are mutually consistent.
 */

import { createHash } from 'crypto';
import { getPool } from '@/server/db/client';
import { canonicalJson } from '@/domain/backup/canonical';
import { CURRENT_SCHEMA_VERSION, type BackupBody, type BackupDoc } from '@/domain/backup/schema';
import { transactionsCsv, reconciliationsCsv, type CsvKind, type CsvTxRow } from '@/domain/backup/csv';
import { getEnv } from '@/lib/env';

type Row = Record<string, unknown>;
interface Q {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  release: () => void;
}

const D = (c: string) => `to_char(${c}, 'YYYY-MM-DD')`;
const T = (c: string) => `to_char(${c}, 'HH24:MI:SS')`;
const TS = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function withSnapshot<R>(userId: string, fn: (q: Q) => Promise<R>): Promise<R> {
  const client = (await (getPool() as unknown as { connect: () => Promise<Q> }).connect()) as Q;
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function buildBackup(userId: string): Promise<BackupDoc> {
  const body = await withSnapshot(userId, async (q) => {
    const sel = async (sql: string) => (await q.query(sql, [userId])).rows;

    const [profile] = await sel(`SELECT name, email::text AS email, currency, timezone, theme, number_grouping, week_start, hide_balances_default FROM users WHERE id = $1`);
    const envelopes = await sel(`SELECT id, name, description, icon, color, owner_type, owner_name, kind, goal_amount_paisa::text AS goal_amount_paisa, status, ${TS('archived_at')} AS archived_at, sort_order, ${TS('created_at')} AS created_at, ${TS('updated_at')} AS updated_at FROM envelopes WHERE user_id = $1 ORDER BY sort_order, id`);
    const categories = await sel(`SELECT id, name, kind, group_name, status, is_system, sort_order, ${TS('created_at')} AS created_at, ${TS('updated_at')} AS updated_at FROM categories WHERE user_id = $1 ORDER BY kind, sort_order, id`);
    const transactions = await sel(`SELECT id, type::text AS type, amount_paisa::text AS amount_paisa, ${D('occurred_on')} AS occurred_on, ${T('occurred_at')} AS occurred_at, envelope_id, counterpart_envelope_id, category_id, note, loan_id, recurring_id, is_generated, parent_transaction_id, ${TS('deleted_at')} AS deleted_at, version, ${TS('created_at')} AS created_at, ${TS('updated_at')} AS updated_at FROM transactions WHERE user_id = $1 ORDER BY occurred_on, occurred_at, created_at, id`);
    const splits = await sel(`SELECT id, transaction_id, envelope_id, amount_paisa::text AS amount_paisa FROM transaction_splits WHERE user_id = $1 ORDER BY id`);
    const loans = await sel(`SELECT id, lender_envelope_id, borrower_envelope_id, note, ${TS('deleted_at')} AS deleted_at, ${TS('created_at')} AS created_at, ${TS('updated_at')} AS updated_at FROM loans WHERE user_id = $1 ORDER BY created_at, id`);
    const rules = await sel(`SELECT id, name, type, amount_paisa::text AS amount_paisa, envelope_id, category_id, split_template, frequency::text AS frequency, interval_n, anchor_day, ${D('start_date')} AS start_date, ${D('end_date')} AS end_date, max_occurrences, status, pause_reason, is_committee, next_slot_index, version, ${TS('created_at')} AS created_at, ${TS('updated_at')} AS updated_at FROM recurring_rules WHERE user_id = $1 ORDER BY created_at, id`);
    const occurrences = await sel(`SELECT id, rule_id, slot_index, ${D('due_date')} AS due_date, status, transaction_id, note, ${TS('created_at')} AS created_at, ${TS('updated_at')} AS updated_at FROM recurring_occurrences WHERE user_id = $1 ORDER BY rule_id, slot_index`);
    const recons = await sel(`SELECT id, ${TS('checked_at')} AS checked_at, ${D('checked_on')} AS checked_on, expected_paisa::text AS expected_paisa, actual_paisa::text AS actual_paisa, difference_paisa::text AS difference_paisa, note, adjustment_transaction_id, tx_count_at_check, ledger_revision::text AS ledger_revision, ledger_hash, ${TS('deleted_at')} AS deleted_at, ${TS('created_at')} AS created_at, ${TS('updated_at')} AS updated_at FROM reconciliations WHERE user_id = $1 ORDER BY checked_at, id`);
    const audit = (await sel(`SELECT id, entity, entity_id, action, before_json, after_json, ${TS('at')} AS at FROM audit_log WHERE user_id = $1 ORDER BY at DESC, id DESC LIMIT 20000`)).reverse();

    // jsonb split_template arrives parsed; money inside is already string
    return {
      schema_version: CURRENT_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      app_version: getEnv().APP_VERSION,
      timezone: String(profile?.timezone ?? 'Asia/Karachi'),
      profile,
      envelopes,
      categories,
      transactions,
      transaction_splits: splits,
      loans,
      recurring_rules: rules,
      recurring_occurrences: occurrences,
      reconciliations: recons,
      audit_log: audit,
    } as unknown as BackupBody;
  });

  return { ...body, checksum: sha256Hex(canonicalJson(body)) };
}

/** Checksum over everything except the checksum itself. */
export function checksumOf(doc: BackupDoc | BackupBody): string {
  const { checksum: _c, ...body } = doc as BackupDoc;
  return sha256Hex(canonicalJson(body));
}

export interface CsvRange {
  from?: string;
  to?: string;
}

export async function buildCsv(userId: string, kind: CsvKind, range: CsvRange): Promise<string> {
  return withSnapshot(userId, async (q) => {
    if (kind === 'reconciliations') {
      const params: unknown[] = [userId];
      let where = 'r.user_id = $1 AND r.deleted_at IS NULL';
      if (range.from) { params.push(range.from); where += ` AND r.checked_on >= $${params.length}`; }
      if (range.to) { params.push(range.to); where += ` AND r.checked_on <= $${params.length}`; }
      const { rows } = await q.query(
        `SELECT ${TS('r.checked_at')} AS checked_at, r.expected_paisa::text AS e, r.actual_paisa::text AS a, r.difference_paisa::text AS d, r.note,
                CASE WHEN r.adjustment_transaction_id IS NOT NULL THEN 'adjustment' END AS adjustment
         FROM reconciliations r WHERE ${where} ORDER BY r.checked_at`,
        params
      );
      return reconciliationsCsv(rows.map((r) => ({
        checkedAt: String(r.checked_at), expected: BigInt(String(r.e)), actual: BigInt(String(r.a)), difference: BigInt(String(r.d)),
        note: (r.note as string | null) ?? null, adjustment: (r.adjustment as string | null) ?? null,
      })));
    }

    const params: unknown[] = [userId];
    let where = 't.user_id = $1 AND t.deleted_at IS NULL';
    if (kind === 'expenses') where += " AND t.type = 'expense'";
    if (kind === 'income') where += " AND t.type = 'income'";
    if (range.from) { params.push(range.from); where += ` AND t.occurred_on >= $${params.length}`; }
    if (range.to) { params.push(range.to); where += ` AND t.occurred_on <= $${params.length}`; }
    const { rows } = await q.query(
      `SELECT t.id, t.type::text AS type, ${D('t.occurred_on')} AS occurred_on, ${T('t.occurred_at')} AS occurred_at, t.amount_paisa::text AS amount,
              e.name AS env, ce.name AS to_env, c.name AS cat, t.note, t.is_generated,
              CASE WHEN t.loan_id IS NOT NULL THEN 'loan' END AS loan,
              rr.name AS recurring,
              CASE WHEN e.owner_type = 'other' THEN e.owner_name END AS owner_name
       FROM transactions t
       LEFT JOIN envelopes e ON e.id = t.envelope_id
       LEFT JOIN envelopes ce ON ce.id = t.counterpart_envelope_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN recurring_rules rr ON rr.id = t.recurring_id
       WHERE ${where}
       ORDER BY t.occurred_on, t.occurred_at, t.created_at, t.id`,
      params
    );
    const mapped: CsvTxRow[] = rows.map((r) => ({
      id: String(r.id), type: String(r.type), occurredOn: String(r.occurred_on), occurredAt: String(r.occurred_at),
      amountPaisa: BigInt(String(r.amount)), envelope: (r.env as string | null) ?? null, toEnvelope: (r.to_env as string | null) ?? null,
      category: (r.cat as string | null) ?? null, note: (r.note as string | null) ?? null, loan: (r.loan as string | null) ?? null,
      recurring: (r.recurring as string | null) ?? null, generated: Boolean(r.is_generated), ownerName: (r.owner_name as string | null) ?? null,
    }));
    return transactionsCsv(mapped);
  });
}
