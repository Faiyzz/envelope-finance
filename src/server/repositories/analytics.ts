/**
 * Analytics read models - TD-09 §3
 */

import { getPool } from '@/server/db/client';
import { addDays, monthsBetween, type LocalDate } from '@/domain/dates';
import { previousRange } from '@/domain/analytics/ranges';
import { largestRemainder } from '@/domain/analytics/percent';

export interface AnalyticsResponse {
  range: { from: string; to: string; label: string };
  summary: {
    spent: string;
    income: string;
    net: string;
    adjustments: { total: string; count: number };
    prev: { spent: string; income: string; net: string };
    changePct: { spent: number | null; income: number | null };
  };
  monthly: Array<{ month: string; spent: string; income: string }>;
  byCategory: Array<{
    categoryId: string | null;
    name: string;
    archived: boolean;
    amount: string;
    pct: number;
    isOther?: boolean;
  }>;
  byEnvelope: Array<{
    envelopeId: string;
    name: string;
    icon: string;
    archived: boolean;
    amount: string;
    pct: number;
  }>;
  topExpenses: Array<{
    txId: string;
    amount: string;
    envelopeName: string;
    categoryName: string;
    date: string;
    note: string | null;
  }>;
  daily?: Array<{ date: string; spent: string }>;
  includeHeld: boolean;
}

/**
 * Get analytics for a user
 */
export async function getAnalytics(
  userId: string,
  options: {
    from: string;
    to: string;
    includeHeld: boolean;
    includeDaily?: boolean;
  }
): Promise<AnalyticsResponse> {
  const pool = getPool();
  const { from, to, includeHeld, includeDaily } = options;

  // Base CTE
  const baseQuery = `
    WITH base AS (
      SELECT t.id, t.type, t.amount_paisa, t.occurred_on, t.category_id, t.envelope_id, t.note, e.owner_type AS env_owner
      FROM transactions t
      LEFT JOIN envelopes e ON e.id = t.envelope_id AND e.user_id = t.user_id
      WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.occurred_on BETWEEN $2 AND $3
    )
  `;

  const spendFilter = includeHeld ? "type='expense'" : "type='expense' AND env_owner='mine'";

  // Summary cards (current + previous period)
  const summaryQuery = `
    ${baseQuery}
    SELECT
      COALESCE(SUM(CASE WHEN ${spendFilter} THEN amount_paisa ELSE 0 END), 0) as spent,
      COALESCE(SUM(CASE WHEN type='income' THEN amount_paisa ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN type='adjustment' THEN amount_paisa ELSE 0 END), 0) as adjustments,
      COUNT(CASE WHEN type='adjustment' THEN 1 END) as adjustment_count
    FROM base
  `;

  const summaryResult = await pool.query(summaryQuery, [userId, from, to]);
  const summaryRow = summaryResult.rows[0];

  const spent = BigInt(summaryRow.spent);
  const income = BigInt(summaryRow.income);
  const adjustments = BigInt(summaryRow.adjustments);
  const adjustmentCount = parseInt(summaryRow.adjustment_count);
  const net = income - spent;

  // Previous period: same number of months before (partial month -> same elapsed days),
  // or an equal-length window for custom ranges (TD-09 §2). Pure, timezone-independent.
  const prev = previousRange({ from, to, months: [], label: '' }, to);
  const prevSummaryResult = await pool.query(summaryQuery, [
    userId,
    prev.from,
    prev.to,
  ]);
  const prevSummaryRow = prevSummaryResult.rows[0];

  const prevSpent = BigInt(prevSummaryRow.spent);
  const prevIncome = BigInt(prevSummaryRow.income);
  const prevNet = prevIncome - prevSpent;

  // Calculate percentage changes
  const spentChangePct = prevSpent > 0n ? Number((spent - prevSpent) * 10000n / prevSpent) / 100 : null;
  const incomeChangePct = prevIncome > 0n ? Number((income - prevIncome) * 10000n / prevIncome) / 100 : null;

  // Monthly series
  const monthlyQuery = `
    ${baseQuery}
    SELECT
      date_trunc('month', occurred_on)::date as month,
      COALESCE(SUM(CASE WHEN ${spendFilter} THEN amount_paisa ELSE 0 END), 0) as spent,
      COALESCE(SUM(CASE WHEN type='income' THEN amount_paisa ELSE 0 END), 0) as income
    FROM base
    GROUP BY date_trunc('month', occurred_on)
    ORDER BY month
  `;

  const monthlyResult = await pool.query(monthlyQuery, [userId, from, to]);

  // Generate all months in range and fill zeros
  const months = generateMonthsInRange(from, to);
  const monthlyMap = new Map(monthlyResult.rows.map((r: any) => [r.month, r]));

  const monthly = months.map(month => {
    const row = monthlyMap.get(month);
    return {
      month,
      spent: (row?.spent || '0') as string,
      income: (row?.income || '0') as string,
    };
  });

  // By category
  const categoryQuery = `
    ${baseQuery}
    SELECT
      c.id as category_id,
      COALESCE(c.name, 'Uncategorized') as name,
      COALESCE(c.status = 'archived', false) as archived,
      COALESCE(SUM(CASE WHEN ${spendFilter} THEN amount_paisa ELSE 0 END), 0) as amount
    FROM base
    LEFT JOIN categories c ON c.id = base.category_id
    GROUP BY c.id, c.name, c.status
    ORDER BY amount DESC
  `;

  const categoryResult = await pool.query(categoryQuery, [userId, from, to]);
  const categoryRows = categoryResult.rows.map((r: any) => ({
    categoryId: r.category_id,
    name: r.name,
    archived: r.archived,
    amount: BigInt(r.amount),
  }));

  // Group top 7 + Other
  const topCategories = categoryRows.slice(0, 7);
  const otherAmount = categoryRows.slice(7).reduce((sum: bigint, r: any) => sum + r.amount, 0n);

  const categoryAmounts = topCategories.map((c: any) => c.amount);
  if (otherAmount > 0n) {
    categoryAmounts.push(otherAmount);
  }

  const categoryPcts = largestRemainder(categoryAmounts);

  const byCategory: AnalyticsResponse['byCategory'] = topCategories.map((c: any, i: number) => ({
    categoryId: c.categoryId,
    name: c.name,
    archived: c.archived,
    amount: c.amount.toString(),
    pct: categoryPcts[i] ?? 0,
  }));

  if (otherAmount > 0n) {
    categoryRows.push({
      categoryId: null,
      name: 'Other',
      archived: false,
      amount: otherAmount,
    });
    byCategory.push({
      categoryId: null,
      name: 'Other',
      archived: false,
      amount: otherAmount.toString(),
      pct: categoryPcts[categoryPcts.length - 1] ?? 0,
      isOther: true,
    });
  }

  // By envelope
  const envelopeQuery = `
    ${baseQuery}
    SELECT
      e.id as envelope_id,
      e.name,
      e.icon,
      COALESCE(e.status = 'archived', false) as archived,
      COALESCE(SUM(CASE WHEN ${spendFilter} THEN amount_paisa ELSE 0 END), 0) as amount
    FROM base
    LEFT JOIN envelopes e ON e.id = base.envelope_id
    GROUP BY e.id, e.name, e.icon, e.status
    ORDER BY amount DESC
  `;

  const envelopeResult = await pool.query(envelopeQuery, [userId, from, to]);
  const envelopeRows = envelopeResult.rows.map((r: any) => ({
    envelopeId: r.envelope_id,
    name: r.name,
    icon: r.icon,
    archived: r.archived,
    amount: BigInt(r.amount),
  }));

  const envelopeAmounts = envelopeRows.map((e: any) => e.amount);
  const envelopePcts = largestRemainder(envelopeAmounts);

  const byEnvelope = envelopeRows.map((e: any, i: number) => ({
    envelopeId: e.envelopeId,
    name: e.name,
    icon: e.icon,
    archived: e.archived,
    amount: e.amount.toString(),
    pct: envelopePcts[i] ?? 0,
  }));

  // Top expenses
  const topExpensesQuery = `
    ${baseQuery}
    SELECT
      t.id as tx_id,
      t.amount_paisa,
      e.name as envelope_name,
      COALESCE(c.name, 'Uncategorized') as category_name,
      t.occurred_on as date,
      t.note
    FROM base t
    LEFT JOIN envelopes e ON e.id = t.envelope_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${spendFilter}
    ORDER BY t.amount_paisa DESC, t.occurred_on DESC, t.id
    LIMIT 5
  `;

  const topExpensesResult = await pool.query(topExpensesQuery, [userId, from, to]);
  const topExpenses = topExpensesResult.rows.map((r: any) => ({
    txId: r.tx_id,
    amount: r.amount_paisa,
    envelopeName: r.envelope_name,
    categoryName: r.category_name,
    date: r.date,
    note: r.note,
  }));

  // Daily spending (optional)
  let daily: Array<{ date: string; spent: string }> | undefined;
  if (includeDaily) {
    const dailyQuery = `
      ${baseQuery}
      SELECT
        occurred_on as date,
        COALESCE(SUM(CASE WHEN ${spendFilter} THEN amount_paisa ELSE 0 END), 0) as spent
      FROM base
      GROUP BY occurred_on
      ORDER BY occurred_on
    `;

    const dailyResult = await pool.query(dailyQuery, [userId, from, to]);
    const dailyMap = new Map(dailyResult.rows.map((r: any) => [r.date, r.spent]));

    const days = generateDaysInRange(from, to);
    daily = days.map(day => {
      const spent = dailyMap.get(day);
      return {
        date: day,
        spent: (spent !== undefined ? String(spent) : '0'),
      };
    });
  }

  return {
    range: { from, to, label: 'Custom' },
    summary: {
      spent: spent.toString(),
      income: income.toString(),
      net: net.toString(),
      adjustments: { total: adjustments.toString(), count: adjustmentCount },
      prev: {
        spent: prevSpent.toString(),
        income: prevIncome.toString(),
        net: prevNet.toString(),
      },
      changePct: {
        spent: spentChangePct,
        income: incomeChangePct,
      },
    },
    monthly,
    byCategory,
    byEnvelope,
    topExpenses,
    daily,
    includeHeld,
  };
}

/** First-of-month list in range (pure calendar maths). */
function generateMonthsInRange(from: string, to: string): string[] {
  return monthsBetween(from as LocalDate, to as LocalDate);
}

/** All days in range (inclusive). */
function generateDaysInRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from as LocalDate; d <= (to as LocalDate); d = addDays(d, 1)) days.push(d);
  return days;
}
