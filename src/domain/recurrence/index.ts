/**
 * Pure recurrence engine - TD-07 §3
 * 
 * All functions are pure, operate on LocalDate, take today as parameter,
 * and use index-based date computation (never "previous + step")
 */

export interface RuleSchedule {
  frequency: 'weekly' | 'monthly' | 'yearly' | 'custom_days';
  intervalN: number;
  anchorDay?: number;
  startDate: string; // LocalDate
  endDate?: string; // LocalDate
}

import { addDays, addMonthsClamped, addYears, compare, daysInMonth, type LocalDate } from '@/domain/dates';

/**
 * Calculate due date for a specific slot index.
 * Index-based (never "previous + step") so clamping never drifts:
 *  weekly      start + 7*interval*k days
 *  custom_days start + interval*k days
 *  monthly     month = start + interval*k, day = min(anchor ?? start.day, daysInMonth)
 *  yearly      year  = start + interval*k, Feb 29 -> Feb 28 in non-leap years
 */
export function dueDateForSlot(rule: RuleSchedule, k: number): string {
  const start = rule.startDate as LocalDate;
  switch (rule.frequency) {
    case 'weekly':
      return addDays(start, 7 * rule.intervalN * k);
    case 'custom_days':
      return addDays(start, rule.intervalN * k);
    case 'monthly':
      return addMonthsClamped(start, rule.intervalN * k, rule.anchorDay);
    case 'yearly': {
      const y = addYears(start, rule.intervalN * k);
      // honour an explicit anchor day within the (same) month
      const [yy, mm] = y.split('-').map(Number) as [number, number];
      const anchor = rule.anchorDay;
      return anchor ? (`${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(Math.min(anchor, daysInMonth(yy, mm))).padStart(2, '0')}`) : y;
    }
    default:
      throw new Error(`Unknown frequency: ${String(rule.frequency)}`);
  }
}

/**
 * Get slots that are due
 * Slots k >= fromSlot with dueDate <= today and (endDate undefined or dueDate <= endDate)
 * Stops after cap and when budget is 0
 */
export function slotsDue(
  rule: RuleSchedule,
  fromSlot: number,
  today: string,
  budgetRemaining: number | null,
  cap = 24
): Array<{ slotIndex: number; dueDate: string }> {
  const slots: Array<{ slotIndex: number; dueDate: string }> = [];
  for (let k = fromSlot; slots.length < cap; k++) {
    // Check budget
    if (budgetRemaining !== null && budgetRemaining <= 0) break;
    
    const dueDateStr = dueDateForSlot(rule, k);
    // Check if due date is in the past or today (ISO dates compare as strings)
    if (compare(dueDateStr as LocalDate, today as LocalDate) > 0) break;
    
    // Check end date
    if (rule.endDate) {
      if (compare(dueDateStr as LocalDate, rule.endDate as LocalDate) > 0) break;
    }
    
    slots.push({ slotIndex: k, dueDate: dueDateStr });
    
    // Decrement budget
    if (budgetRemaining !== null) {
      budgetRemaining--;
    }
  }
  
  return slots;
}

/**
 * Preview next N occurrences for the create form
 * Counts from first slot with dueDate >= fromDate
 */
export function previewNext(rule: RuleSchedule, fromDate: string, n = 3): string[] {
  const dates: string[] = [];
  
  for (let k = 0; dates.length < n; k++) {
    const dueDateStr = dueDateForSlot(rule, k);
    if (compare(dueDateStr as LocalDate, fromDate as LocalDate) >= 0) {
      dates.push(dueDateStr);
    }
  }
  
  return dates;
}

/**
 * Get next due date for a rule
 * Returns null when budget exhausted/endDate passed
 */
export function nextDueDate(rule: RuleSchedule, nextSlotIndex: number): string | null {
  const dueDateStr = dueDateForSlot(rule, nextSlotIndex);
  
  // Check end date
  if (rule.endDate) {
    if (compare(dueDateStr as LocalDate, rule.endDate as LocalDate) > 0) return null;
  }
  
  return dueDateStr;
}
