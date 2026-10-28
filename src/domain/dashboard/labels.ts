/** Pure label helpers for dashboard rows (TD-10 §4.2). */

import type { RecentTxDTO } from './types';

export type UpcomingLabel =
  | { kind: 'overdue' }
  | { kind: 'today' }
  | { kind: 'tomorrow' }
  | { kind: 'inDays'; n: number };

export function upcomingLabel(inDays: number, needsAttention: boolean): UpcomingLabel {
  if (needsAttention || inDays < 0) return { kind: 'overdue' };
  if (inDays === 0) return { kind: 'today' };
  if (inDays === 1) return { kind: 'tomorrow' };
  return { kind: 'inDays', n: inDays };
}

const TYPE_LABEL: Record<string, string> = {
  opening_balance: 'Opening balance',
  income: 'Income',
  external_deposit: 'Held money received',
  expense: 'Expense',
  external_withdrawal: 'Held money returned',
  allocation: 'Money added',
  deallocation: 'Money moved to Unallocated',
  transfer: 'Transfer',
  loan: 'Loan',
  loan_repayment: 'Loan repayment',
  adjustment: 'Adjustment',
};

export function describeTx(r: RecentTxDTO): { title: string; subtitle: string } {
  const typeLabel = TYPE_LABEL[r.type] ?? r.type;
  const moved =
    r.counterpartName && r.envelopeName ? `${r.envelopeName} → ${r.counterpartName}` : r.envelopeName ?? 'Unallocated';
  const title = r.note?.trim() || (r.type === 'expense' || r.type === 'income' ? r.categoryName ?? typeLabel : typeLabel);
  const parts = [r.type === 'expense' || r.type === 'income' ? r.envelopeName ?? typeLabel : moved];
  if (r.onBehalfOf) parts.push(`On behalf of ${r.onBehalfOf}`);
  return { title, subtitle: parts.join(' · ') };
}

/** 'YYYY-MM-DD' -> 'Oct 6' without any timezone shift. */
export function shortDate(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[(m ?? 1) - 1]} ${day}${y ? '' : ''}`;
}
