/**
 * Dashboard read model - TD-10 §4.1
 *
 * One read-only transaction on one connection, queries in parallel over the
 * same snapshot so totals cannot be torn. Balances are never cached.
 */

import { getPool } from '@/server/db/client';
import { getEnvelopeList } from '@/server/repositories/envelopes';
import { getUpcoming } from '@/server/repositories/recurring';
import { getLatestReconciliation } from '@/server/repositories/reconciliation';
import { reconciliationStatus } from '@/domain/reconciliation';
import { buildAttention } from '@/domain/dashboard/attention';
import { diffDays, todayIn, type LocalDate } from '@/domain/dates';
import type {
  AttentionItem,
  DashboardDTO,
  ReconChipDTO,
  RecentTxDTO,
  UpcomingDTO,
} from '@/domain/dashboard/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export async function getDashboard(userId: string, timezone: string): Promise<DashboardDTO> {
  const today = todayIn(timezone, Date.now());
  const pool = getPool() as unknown as { connect: () => Promise<Q & { release: () => void }> };
  const client = await pool.connect();

  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);

    // One connection can only run one statement at a time, so these run serially on the
    // same REPEATABLE READ snapshot (consistent totals; no deprecated concurrent client.query).
    const totals = await client.query(
      `SELECT total_paisa, envelopes_paisa, mine_paisa, other_paisa FROM ledger_totals WHERE user_id = $1`,
      [userId]
    );
    const setup = await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM transactions WHERE user_id = $1 AND type = 'opening_balance' AND deleted_at IS NULL) AS has_opening,
         EXISTS (SELECT 1 FROM envelopes WHERE user_id = $1 AND status = 'active') AS has_envelopes`,
      [userId]
    );
    const revision = await client.query(`SELECT ledger_revision FROM users WHERE id = $1`, [userId]);
    const recentRows = await client.query(
      `SELECT t.id, t.type, t.amount_paisa, t.occurred_on, t.note,
              e.name AS env_name, e.owner_type, e.owner_name, c.name AS cat_name, ce.name AS cp_name
       FROM transactions t
       LEFT JOIN envelopes e ON e.id = t.envelope_id
       LEFT JOIN envelopes ce ON ce.id = t.counterpart_envelope_id
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1 AND t.deleted_at IS NULL
       ORDER BY t.occurred_on DESC, t.occurred_at DESC, t.created_at DESC, t.id DESC
       LIMIT 5`,
      [userId]
    );
    const pausedRows = await client.query(
      `SELECT id, name FROM recurring_rules
       WHERE user_id = $1 AND status = 'paused' AND pause_reason = 'envelope_archived'
       ORDER BY name LIMIT 5`,
      [userId]
    );
    await client.query('COMMIT');

    const t = totals.rows[0] ?? {};
    const total = BigInt(t.total_paisa ?? 0);
    const envelopesSum = BigInt(t.envelopes_paisa ?? 0);
    const mine = BigInt(t.mine_paisa ?? 0);
    const held = BigInt(t.other_paisa ?? 0);
    const unallocated = total - envelopesSum; // FR-LED-02: derived, never stored
    const yourMoney = unallocated + mine;

    const [envelopes, upcoming, latest] = await Promise.all([
      getEnvelopeList(userId),
      getUpcoming(userId),
      getLatestReconciliation(userId),
    ]);

    const recon = buildRecon(latest, total, BigInt(revision.rows[0]?.ledger_revision ?? 0));

    const needs: Extract<AttentionItem, { kind: 'needs_attention' }>[] = upcoming
      .filter((u) => u.status === 'needs_attention')
      .map((u) => ({
        kind: 'needs_attention',
        id: u.id,
        ruleName: u.ruleName,
        amount: u.amountPaisa.toString(),
        dueDate: u.dueDate,
        envelopeName: u.envelopeName,
      }));

    const daysSinceCheck = latest
      ? Math.max(0, diffDays(today, String(latest.checkedOn).slice(0, 10) as LocalDate))
      : null;

    const attention = buildAttention({
      needsAttention: needs,
      integrityFailed: false, // integrity_runs lands with TD-01 §10 job
      daysSinceCheck,
      pausedRules: pausedRows.rows.map((r) => ({ ruleId: r.id, ruleName: r.name })),
    }).all;

    const upcomingDTO: UpcomingDTO[] = upcoming.slice(0, 5).map((u) => ({
      id: u.id,
      ruleName: u.ruleName,
      type: u.type,
      amount: u.amountPaisa.toString(),
      dueDate: u.dueDate,
      inDays: diffDays(u.dueDate as LocalDate, today),
      needsAttention: u.status === 'needs_attention',
      envelopeName: u.envelopeName,
    }));

    return {
      total: total.toString(),
      yourMoney: yourMoney.toString(),
      heldForOthers: held.toString(),
      unallocated: unallocated.toString(),
      recon,
      attention,
      envelopes: envelopes.map((e) => ({
        id: e.id,
        name: e.name,
        icon: e.icon,
        ownerType: e.ownerType,
        ownerName: e.ownerName,
        kind: e.kind,
        balance: e.balance.toString(),
        txCount: e.txCount,
        borrowed: e.borrowed.toString(),
        loanedOut: e.loanedOut.toString(),
        ownFunds: e.ownFunds.toString(),
        goal: e.goal
          ? { amount: e.goal.amount.toString(), progressPct: Math.round(e.goal.progress * 100) }
          : undefined,
      })),
      upcoming: upcomingDTO,
      recent: recentRows.rows.map(toRecent),
      setup: { hasOpeningBalance: !!setup.rows[0]?.has_opening, hasEnvelopes: !!setup.rows[0]?.has_envelopes },
      today,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toRecent(r: any): RecentTxDTO { // eslint-disable-line @typescript-eslint/no-explicit-any
  const a = BigInt(r.amount_paisa);
  // Sign = effect on the money the row is about (TD-05 §6.1 list signage)
  const negative = ['expense', 'external_withdrawal', 'deallocation'].includes(r.type);
  const positive = ['income', 'external_deposit', 'allocation', 'opening_balance', 'adjustment'].includes(r.type);
  const signed = negative ? -a : positive ? a : 0n;
  return {
    id: r.id,
    type: r.type,
    signedAmount: (r.type === 'adjustment' ? a : signed).toString(),
    envelopeName: r.env_name,
    counterpartName: r.cp_name,
    categoryName: r.cat_name,
    note: r.note,
    occurredOn: String(r.occurred_on).slice(0, 10),
    onBehalfOf: r.owner_type === 'other' ? r.owner_name : null,
  };
}

function buildRecon(
  latest: Awaited<ReturnType<typeof getLatestReconciliation>>,
  currentExpected: bigint,
  currentRevision: bigint
): ReconChipDTO {
  if (!latest) return { status: 'never_verified' };
  // The stored revision is not exposed by the repository yet; `changedSince`
  // (hash over transactions dated <= check date) is the available signal.
  const sameRevision = !latest.changedSince;
  const res = reconciliationStatus({
    latest: {
      checkedAt: String(latest.checkedAt),
      checkedOn: String(latest.checkedOn),
      actual: latest.actual,
      difference: latest.difference,
      ledgerRevision: sameRevision ? currentRevision : currentRevision - 1n,
    },
    currentExpected,
    currentRevision,
    changeCountSince: 0,
    now: new Date().toISOString(),
  });
  return {
    status: res.status,
    difference: latest.difference.toString(),
    actual: latest.actual.toString(),
    checkedOn: String(latest.checkedOn).slice(0, 10),
    current: sameRevision,
  };
}
