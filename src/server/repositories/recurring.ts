/**
 * Recurring read models - TD-07 §6
 */

import { getPool } from '@/server/db/client';
import { dueDateForSlot } from '@/domain/recurrence';

export interface UpcomingItem {
  id: string;
  ruleId: string;
  ruleName: string;
  type: 'expense' | 'income';
  amountPaisa: bigint;
  dueDate: string;
  status: 'needs_attention' | 'projected';
  envelopeName?: string;
}

/**
 * Get upcoming list for dashboard
 * Merges needs_attention occurrences and projected next slots
 */
export async function getUpcoming(userId: string): Promise<UpcomingItem[]> {
  const pool = getPool();
  const today = new Date().toISOString().split('T')[0] as string;

  // Get needs_attention occurrences
  const needsAttentionResult = await pool.query(
    `SELECT ro.id, ro.rule_id, ro.due_date, ro.status,
            rr.name as rule_name, rr.type, rr.amount_paisa, rr.envelope_id, e.name as envelope_name
     FROM recurring_occurrences ro
     JOIN recurring_rules rr ON rr.id = ro.rule_id
     LEFT JOIN envelopes e ON e.id = rr.envelope_id
     WHERE ro.user_id = $1 AND ro.status = 'needs_attention'
     ORDER BY ro.due_date ASC`,
    [userId]
  );

  const upcoming: UpcomingItem[] = needsAttentionResult.rows.map((row: any) => ({
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    type: row.type,
    amountPaisa: BigInt(row.amount_paisa),
    dueDate: row.due_date,
    status: 'needs_attention',
    envelopeName: row.envelope_name,
  }));

  // Get projected next slots for active rules
  const rulesResult = await pool.query(
    `SELECT rr.id, rr.name, rr.type, rr.amount_paisa, rr.envelope_id, rr.frequency, 
            rr.interval_n, rr.anchor_day, rr.start_date, rr.end_date, rr.next_slot_index,
            e.name as envelope_name
     FROM recurring_rules rr
     LEFT JOIN envelopes e ON e.id = rr.envelope_id
     WHERE rr.user_id = $1 AND rr.status = 'active'`,
    [userId]
  );

  for (const rule of rulesResult.rows) {
    const schedule = {
      frequency: rule.frequency,
      intervalN: rule.interval_n,
      anchorDay: rule.anchor_day,
      startDate: rule.start_date,
      endDate: rule.end_date,
    };

    const nextDueDate = dueDateForSlot(schedule, rule.next_slot_index);

    if (nextDueDate && nextDueDate <= today) {
      // Already due but not in needs_attention (shouldn't happen, but defensive)
      continue;
    }

    if (nextDueDate) {
      const thirtyDaysLater = new Date();
      thirtyDaysLater.setDate(thirtyDaysLater.getDate() + 30);
      const thirtyDaysLaterStr = thirtyDaysLater.toISOString().split('T')[0] as string;

      if (nextDueDate <= thirtyDaysLaterStr) {
        upcoming.push({
          id: `projected-${rule.id}`,
          ruleId: rule.id,
          ruleName: rule.name,
          type: rule.type,
          amountPaisa: BigInt(rule.amount_paisa),
          dueDate: nextDueDate,
          status: 'projected',
          envelopeName: rule.envelope_name,
        });
      }
    }
  }

  // Sort by date and take top 5
  upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return upcoming.slice(0, 5);
}

export interface RuleRow {
  id: string;
  name: string;
  type: 'expense' | 'income';
  amountPaisa: bigint;
  frequency: string;
  status: 'active' | 'paused' | 'completed' | 'ended';
  isCommittee: boolean;
  startDate: string;
  envelopeName: string | null;
}

/** All recurring rules, newest first. */
export async function listRules(userId: string): Promise<RuleRow[]> {
  const { rows } = await getPool().query(
    `SELECT rr.id, rr.name, rr.type, rr.amount_paisa, rr.frequency, rr.status, rr.is_committee, rr.start_date, e.name AS envelope_name
     FROM recurring_rules rr LEFT JOIN envelopes e ON e.id = rr.envelope_id
     WHERE rr.user_id = $1 ORDER BY rr.created_at DESC`,
    [userId]
  );
  return rows.map((r: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
    id: r.id, name: r.name, type: r.type, amountPaisa: BigInt(r.amount_paisa), frequency: r.frequency, status: r.status,
    isCommittee: r.is_committee, startDate: r.start_date, envelopeName: r.envelope_name,
  }));
}
