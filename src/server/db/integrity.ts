/**
 * Integrity check - TD-01 §10. Read-only; NEVER repairs.
 *
 * Recomputes everything from the ledger and reports discrepancies in plain
 * language. Runs per user on a single REPEATABLE READ snapshot.
 */

import { getPool } from './client';
import { verifyTimeline, type Queryable } from '@/server/backup/verify';

export interface IntegrityFinding {
  id: string;
  severity: 'error' | 'warning';
  message: string;
  ref?: string;
}

export interface IntegrityReport {
  ok: boolean;
  checkedAt: string;
  findings: IntegrityFinding[];
}

interface Client extends Queryable {
  release: () => void;
}

const money = (p: bigint) => `${p / 100n}${p % 100n ? '.' + (p % 100n).toString().padStart(2, '0') : ''} PKR`;

export async function checkIntegrity(q: Queryable, userId: string): Promise<IntegrityFinding[]> {
  const f: IntegrityFinding[] = [];
  const add = (id: string, message: string, ref?: string, severity: IntegrityFinding['severity'] = 'error') => f.push({ id, severity, message, ref });
  const one = async (sql: string) => (await q.query(sql, [userId])).rows;

  // I1 (INV-1): total = Σ envelopes + unallocated, and the explicit Unallocated postings agree with the derived value
  const t = (await one(`SELECT total_paisa::text AS t, unallocated_explicit_paisa::text AS u, envelopes_paisa::text AS e FROM ledger_totals WHERE user_id = $1`))[0];
  if (t) {
    const derived = BigInt(String(t.t)) - BigInt(String(t.e));
    if (derived !== BigInt(String(t.u))) add('I1', `Unallocated doesn't add up: the ledger says ${money(BigInt(String(t.u)))} but total minus envelopes is ${money(derived)}.`);
  }

  // I2/I3 (INV-2/3/10) and I4 (loans): the first violation anywhere on the timeline
  const v = await verifyTimeline(q, userId, null);
  if (v) {
    const what = v.kind === 'unallocated' ? 'Unallocated' : v.kind === 'loan' ? 'A loan' : `An envelope (${v.id})`;
    add(v.kind === 'loan' ? 'I4' : v.kind === 'unallocated' ? 'I3' : 'I2', `${what} goes ${money(BigInt(v.shortfallPaisa))} below zero on ${v.on}.`, v.id ?? undefined);
  }

  // I4: loan rows ↔ origin transactions, parties are "mine"
  for (const r of await one(`SELECT l.id, (SELECT count(*) FROM transactions o WHERE o.loan_id = l.id AND o.type = 'loan' AND o.deleted_at IS NULL)::int AS origins
                              FROM loans l WHERE l.user_id = $1 AND l.deleted_at IS NULL`)) {
    if (r.origins !== 1) add('I4', `A loan has ${r.origins} starting transactions (it needs exactly 1).`, String(r.id));
  }
  for (const r of await one(`SELECT l.id FROM loans l JOIN envelopes a ON a.id = l.lender_envelope_id JOIN envelopes b ON b.id = l.borrower_envelope_id
                              WHERE l.user_id = $1 AND (a.owner_type <> 'mine' OR b.owner_type <> 'mine')`)) {
    add('I4', "A loan involves money held for someone else.", String(r.id));
  }

  // I5: orphans / cross-user references / splits
  for (const r of await one(`SELECT t.id FROM transactions t
       LEFT JOIN envelopes e ON e.id = t.envelope_id AND e.user_id = t.user_id
       LEFT JOIN envelopes c ON c.id = t.counterpart_envelope_id AND c.user_id = t.user_id
       WHERE t.user_id = $1 AND ((t.envelope_id IS NOT NULL AND e.id IS NULL) OR (t.counterpart_envelope_id IS NOT NULL AND c.id IS NULL)) LIMIT 20`)) {
    add('I5', 'A transaction points to an envelope that is missing or belongs to someone else.', String(r.id));
  }
  for (const r of await one(`SELECT t.id FROM transactions t JOIN transaction_splits s ON s.transaction_id = t.id
       WHERE t.user_id = $1 AND t.deleted_at IS NULL GROUP BY t.id, t.amount_paisa HAVING SUM(s.amount_paisa) > t.amount_paisa LIMIT 20`)) {
    add('I5', 'An income is split into more than its total.', String(r.id));
  }

  // I6: at most one live opening balance
  const ob = (await one(`SELECT count(*)::int AS n FROM transactions WHERE user_id = $1 AND type = 'opening_balance' AND deleted_at IS NULL`))[0];
  if (Number(ob?.n ?? 0) > 1) add('I6', `There are ${ob!.n} opening balances; only one is allowed.`);

  // I7: archived envelopes are empty and owe nothing
  for (const r of await one(`SELECT e.id, e.name, eb.balance_paisa::text AS b FROM envelopes e JOIN envelope_balances eb ON eb.envelope_id = e.id
                              WHERE e.user_id = $1 AND e.status = 'archived' AND eb.balance_paisa <> 0`)) {
    add('I7', `“${r.name}” is archived but still holds ${money(BigInt(String(r.b)))}.`, String(r.id));
  }
  for (const r of await one(`SELECT DISTINCT e.id, e.name FROM loan_state ls JOIN envelopes e ON e.id IN (ls.lender_envelope_id, ls.borrower_envelope_id)
                              WHERE ls.user_id = $1 AND ls.status = 'active' AND e.status = 'archived'`)) {
    add('I7', `“${r.name}” is archived but has an active loan.`, String(r.id));
  }

  // I8: generated occurrences point at live transactions
  for (const r of await one(`SELECT o.id FROM recurring_occurrences o LEFT JOIN transactions t ON t.id = o.transaction_id AND t.deleted_at IS NULL
                              WHERE o.user_id = $1 AND o.status = 'generated' AND t.id IS NULL LIMIT 20`)) {
    add('I8', 'A recurring payment is marked as generated but its transaction is missing.', String(r.id), 'warning');
  }

  // I9: stored reconciliation arithmetic
  for (const r of await one(`SELECT id FROM reconciliations WHERE user_id = $1 AND difference_paisa <> actual_paisa - expected_paisa`)) {
    add('I9', "A bank check's difference does not equal actual minus expected.", String(r.id));
  }
  return f;
}

/** Run the check for one user on a consistent snapshot. */
export async function runIntegrityCheck(userId: string): Promise<IntegrityReport> {
  const client = (await (getPool() as unknown as { connect: () => Promise<Client> }).connect()) as Client;
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const findings = await checkIntegrity(client, userId);
    await client.query('COMMIT');
    return { ok: findings.every((x) => x.severity !== 'error'), checkedAt: new Date().toISOString(), findings };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
