import { describe, expect, it } from 'vitest';
import { assertDateAllowed, defaultTimeFor, diffDays, daysInMonth, isLeap, parseLocalDate, todayIn, type LocalDate } from '@/domain/dates';
import { dueDateForSlot, previewNext } from '@/domain/recurrence';

const d = (s: string) => s as LocalDate;

describe('[URD-52] server-authoritative dates', () => {
  it('"today" near midnight PKT vs UTC lands on the correct date', () => {
    // 2026-10-05T19:30Z is already 00:30 on the 6th in Karachi (UTC+5)
    expect(todayIn('Asia/Karachi', Date.UTC(2026, 9, 5, 19, 30))).toBe('2026-10-06');
    expect(todayIn('Asia/Karachi', Date.UTC(2026, 9, 5, 18, 59))).toBe('2026-10-05');
    expect(todayIn('UTC', Date.UTC(2026, 9, 5, 19, 30))).toBe('2026-10-05');
  });
  it('rejects future and pre-2000 dates', () => {
    expect(() => assertDateAllowed(d('2026-10-07'), d('2026-10-06'))).toThrow();
    expect(() => assertDateAllowed(d('1999-12-31'), d('2026-10-06'))).toThrow();
    expect(() => assertDateAllowed(d('2026-10-06'), d('2026-10-06'))).not.toThrow();
  });
  it('defaults the time: now when today, 12:00 otherwise', () => {
    const now = Date.UTC(2026, 9, 6, 9, 5, 7); // 14:05:07 PKT
    expect(defaultTimeFor(d('2026-10-06'), d('2026-10-06'), 'Asia/Karachi', now)).toBe('14:05:07');
    expect(defaultTimeFor(d('2026-10-05'), d('2026-10-06'), 'Asia/Karachi', now)).toBe('12:00:00');
  });
  it('calendar utilities handle leap years and invalid dates', () => {
    expect(isLeap(2024)).toBe(true);
    expect(isLeap(2100)).toBe(false);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(parseLocalDate('2026-02-29')).toBeNull();
    expect(parseLocalDate('2024-02-29')).toBe('2024-02-29');
    expect(diffDays(d('2026-03-01'), d('2026-02-01'))).toBe(28);
  });
});

describe('[URD-29] recurrence clamping', () => {
  const monthly31 = { frequency: 'monthly' as const, intervalN: 1, anchorDay: 31, startDate: '2027-01-31' };
  it('monthly on the 31st never skips a month or drifts across a year', () => {
    const dates = Array.from({ length: 13 }, (_, k) => dueDateForSlot(monthly31, k));
    expect(dates).toEqual([
      '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30',
      '2027-07-31', '2027-08-31', '2027-09-30', '2027-10-31', '2027-11-30', '2027-12-31', '2028-01-31',
    ]);
  });
  it('leap February uses the 29th, then returns to the anchor', () => {
    const r = { ...monthly31, startDate: '2028-01-31' };
    expect(dueDateForSlot(r, 1)).toBe('2028-02-29');
    expect(dueDateForSlot(r, 2)).toBe('2028-03-31');
  });
  it('yearly Feb 29 clamps to Feb 28 and returns in leap years', () => {
    const y = { frequency: 'yearly' as const, intervalN: 1, startDate: '2024-02-29' };
    expect([0, 1, 2, 3, 4].map((k) => dueDateForSlot(y, k))).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  });
  it('slots are strictly increasing', () => {
    const dates = Array.from({ length: 40 }, (_, k) => dueDateForSlot(monthly31, k));
    for (let i = 1; i < dates.length; i++) expect(dates[i]! > dates[i - 1]!).toBe(true);
  });
  it('previews the next three occurrences', () => {
    expect(previewNext(monthly31, '2027-02-01', 3)).toEqual(['2027-02-28', '2027-03-31', '2027-04-30']);
  });
});
