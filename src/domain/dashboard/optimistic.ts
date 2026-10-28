/**
 * Optimistic balance prediction - TD-10 §5.3. Pure, bigint only.
 *
 * Mirrors the posting table of TD-01 §5 for the only type quick-add
 * creates optimistically (expense): Total -A, envelope -A. The server's
 * response is always authoritative; this only paints the interim state.
 */

import type { DashboardDTO } from './types';

export interface PendingExpense {
  key: string;
  envelopeId: string;
  amount: string; // paisa
  label: string;
  occurredOn: string;
}

export function applyPendingExpenses(data: DashboardDTO, pending: PendingExpense[]): DashboardDTO {
  if (pending.length === 0) return data;

  let total = BigInt(data.total);
  let your = BigInt(data.yourMoney);
  let held = BigInt(data.heldForOthers);
  const envs = data.envelopes.map((e) => ({ ...e }));

  for (const p of pending) {
    const env = envs.find((e) => e.id === p.envelopeId);
    if (!env) continue;
    const a = BigInt(p.amount);
    total -= a;
    if (env.ownerType === 'mine') your -= a;
    else held -= a;
    const bal = BigInt(env.balance) - a;
    env.balance = bal.toString();
    env.ownFunds = (bal - BigInt(env.borrowed)).toString();
    env.txCount += 1;
  }

  const recent = [
    ...pending
      .slice()
      .reverse()
      .map((p) => ({
        id: `pending:${p.key}`,
        type: 'expense',
        signedAmount: (-BigInt(p.amount)).toString(),
        envelopeName: envs.find((e) => e.id === p.envelopeId)?.name ?? null,
        counterpartName: null,
        categoryName: p.label,
        note: null,
        occurredOn: p.occurredOn,
        onBehalfOf: null,
      })),
    ...data.recent,
  ].slice(0, 5);

  return {
    ...data,
    total: total.toString(),
    yourMoney: your.toString(),
    heldForOthers: held.toString(),
    envelopes: envs,
    recent,
  };
}
