/**
 * Range resolution - TD-09 §2. Pure; all calendar maths via domain/dates
 * (no JS Date, so results never depend on the host time zone).
 */

import { addDays, addMonthsClamped, compare, diffDays, endOfMonth, monthsBetween, startOfMonth, type LocalDate } from '@/domain/dates';

export type RangeKey =
  | 'this_month'
  | 'prev_month'
  | 'last_3'
  | 'last_6'
  | 'last_12'
  | { custom: { from: string; to: string } };

export interface ResolvedRange {
  from: string;
  to: string;
  months: string[]; // first-of-month list
  label: string;
}

const LAST: Record<'last_3' | 'last_6' | 'last_12', { n: number; label: string }> = {
  last_3: { n: 3, label: 'Last 3 months' },
  last_6: { n: 6, label: 'Last 6 months' },
  last_12: { n: 12, label: 'Last 12 months' },
};

/** Resolve a range key to concrete dates relative to `today` (user-local). */
export function resolveRange(key: RangeKey, today: string): ResolvedRange {
  const t = today as LocalDate;
  const mk = (from: LocalDate, to: LocalDate, label: string): ResolvedRange => ({
    from,
    to,
    months: monthsBetween(from, to),
    label,
  });

  if (key === 'this_month') return mk(startOfMonth(t), t, 'This month');

  if (key === 'prev_month') {
    const prev = addMonthsClamped(startOfMonth(t), -1, 1);
    return mk(prev, endOfMonth(prev), 'Previous month');
  }

  if (typeof key === 'string') {
    const { n, label } = LAST[key];
    return mk(addMonthsClamped(startOfMonth(t), -(n - 1), 1), t, label);
  }

  return mk(key.custom.from as LocalDate, key.custom.to as LocalDate, 'Custom');
}

/**
 * Comparison period (TD-09 §2):
 *  - month-aligned ranges (start on the 1st): the same number of months immediately
 *    before; a partial last month compares the same elapsed days
 *  - any other (custom) range: an equal-length window immediately before
 */
export function previousRange(range: ResolvedRange, _today: string): { from: string; to: string } {
  const from = range.from as LocalDate;
  const to = range.to as LocalDate;

  if (from === startOfMonth(from)) {
    const n = monthsBetween(from, to).length;
    const prevFrom = addMonthsClamped(from, -n, 1);
    const toIsMonthEnd = to === endOfMonth(to);
    const prevTo = toIsMonthEnd ? endOfMonth(addMonthsClamped(startOfMonth(to), -n, 1)) : addMonthsClamped(to, -n);
    return { from: prevFrom, to: prevTo };
  }

  const len = diffDays(to, from) + 1;
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(len - 1)), to: prevTo };
}

/** True when `a` is not after `b` (helper for range validation). */
export const isBeforeOrEqual = (a: string, b: string) => compare(a as LocalDate, b as LocalDate) <= 0;
