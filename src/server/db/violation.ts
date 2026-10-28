/**
 * Turns a SQL timeline violation into a plain-language domain error - TD-01 §6.5.
 */

import { formatMoney, type Paisa } from '@/domain/money';
import { InsufficientFunds, TimelineViolation, type DomainError } from '@/domain/errors';
import type { SqlViolation } from '@/server/backup/verify';

interface Q {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
};

export interface ViolationHint {
  /** Transaction created by this action: if it is the culprit, report "has only X available". */
  createdTxId?: string;
  op?: 'create' | 'edit' | 'delete' | 'restore';
}

export async function violationToError(q: Q, userId: string, v: SqlViolation, hint: ViolationHint = {}): Promise<DomainError> {
  const shortfall = BigInt(v.shortfallPaisa);
  const money = (p: bigint) => formatMoney(p as Paisa);

  let culprit = '';
  if (v.txId && v.txId !== hint.createdTxId) {
    const r = await q.query(
      `SELECT t.type::text AS type, t.amount_paisa::text AS amount, c.name AS cat, t.note FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = $1 AND t.user_id = $2`,
      [v.txId, userId]
    );
    const row = r.rows[0];
    if (row) culprit = ` (the ${String(row.cat ?? row.type).toLowerCase().replace(/_/g, ' ')} of ${money(BigInt(String(row.amount)))} that day)`;
  }

  if (v.kind === 'envelope' && v.id) {
    const env = (await q.query(`SELECT name FROM envelopes WHERE id = $1 AND user_id = $2`, [v.id, userId])).rows[0];
    const name = String(env?.name ?? 'An envelope');
    if (hint.createdTxId && v.txId === hint.createdTxId && hint.op !== 'delete') {
      // The new transaction itself overdraws: report what is actually available (balance before it)
      const amt = BigInt(String((await q.query(`SELECT amount_paisa::text AS a FROM transactions WHERE id = $1`, [hint.createdTxId])).rows[0]?.a ?? 0));
      const available = amt - shortfall > 0n ? amt - shortfall : 0n;
      return new InsufficientFunds(v.id, available, amt, name);
    }
    const msg =
      hint.op === 'delete'
        ? `Deleting this would leave ${name} with −${money(shortfall).replace(' PKR', '')} PKR on ${niceDate(v.on)}${culprit}. Delete or edit that first.`
        : `${name} would be ${money(shortfall)} below zero on ${niceDate(v.on)}${culprit}. Pick a later date or add money first.`;
    return new TimelineViolation({ date: v.on, envelopeId: v.id, shortfall, message: msg }, { type: hint.op ?? 'write', changes: {} });
  }

  if (v.kind === 'unallocated') {
    return new TimelineViolation(
      { date: v.on, shortfall, message: `This would leave Unallocated ${money(shortfall)} below zero on ${niceDate(v.on)}${culprit}.` },
      { type: hint.op ?? 'write', changes: {} }
    );
  }

  return new TimelineViolation(
    { date: v.on, shortfall, message: `A loan would be over-repaid (or repaid before it started) on ${niceDate(v.on)}, by ${money(shortfall)}.` },
    { type: hint.op ?? 'write', changes: {} }
  );
}
