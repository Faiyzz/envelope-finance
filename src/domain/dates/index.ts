/**
 * Date utilities - TD-01 §3
 * 
 * Pure TypeScript. No JS Date for calendar maths.
 * LocalDate = 'YYYY-MM-DD', LocalTime = 'HH:MM:SS'
 */

export type LocalDate = string & { readonly __brand: 'LocalDate' };
export type LocalTime = string & { readonly __brand: 'LocalTime' };

export const MIN_DATE = '2000-01-01';

/**
 * Parse LocalDate string with strict validation
 */
export function parseLocalDate(s: string): LocalDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return null;
  }
  
  const parts = s.split('-');
  const yearStr = parts[0];
  const monthStr = parts[1];
  const dayStr = parts[2];
  
  if (!yearStr || !monthStr || !dayStr) return null;
  
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) return null;
  
  return s as LocalDate;
}

/**
 * Parse LocalTime string
 */
export function parseLocalTime(s: string): LocalTime | null {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(s)) {
    return null;
  }
  
  const parts = s.split(':');
  const hourStr = parts[0];
  const minStr = parts[1];
  const secStr = parts[2];
  
  if (!hourStr || !minStr || !secStr) return null;
  
  const hour = Number(hourStr);
  const min = Number(minStr);
  const sec = Number(secStr);
  
  if (hour < 0 || hour > 23) return null;
  if (min < 0 || min > 59) return null;
  if (sec < 0 || sec > 59) return null;
  
  return s as LocalTime;
}

// ---------------------------------------------------------------------------
// Integer civil-calendar arithmetic (Howard Hinnant's algorithms). No JS Date,
// so results never depend on the host time zone or DST (TD-01 §3).
// ---------------------------------------------------------------------------

/** Days since 1970-01-01 for a proleptic Gregorian date (month 1-12). */
function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): { y: number; m: number; d: number } {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

function split(d: string): { y: number; m: number; d: number } {
  const [y, m, day] = d.split('-').map(Number);
  return { y: y as number, m: m as number, d: day as number };
}

function make(y: number, m: number, d: number): LocalDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` as LocalDate;
}

/**
 * Add days to a LocalDate
 */
export function addDays(d: LocalDate, n: number): LocalDate {
  const { y, m, d: day } = split(d);
  const c = civilFromDays(daysFromCivil(y, m, day) + n);
  return make(c.y, c.m, c.d);
}

/**
 * Add months, clamping the day to the target month's length. `anchorDay`
 * (default: the date's own day) is kept across months, so 31 -> 28/29 -> 31.
 */
export function addMonthsClamped(d: LocalDate, n: number, anchorDay?: number): LocalDate {
  const { y, m, d: day } = split(d);
  const total = y * 12 + (m - 1) + n;
  const ty = Math.floor(total / 12);
  const tm = (total % 12 + 12) % 12 + 1;
  return make(ty, tm, Math.min(anchorDay ?? day, daysInMonth(ty, tm)));
}

/**
 * Add years; Feb 29 clamps to Feb 28 in non-leap years.
 */
export function addYears(d: LocalDate, n: number): LocalDate {
  const { y, m, d: day } = split(d);
  return make(y + n, m, Math.min(day, daysInMonth(y + n, m)));
}

/**
 * Days in month (month is 1-12)
 */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Is leap year
 */
export function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Compare two LocalDates
 */
export function compare(a: LocalDate, b: LocalDate): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Whole days from b to a (a - b). Positive when `a` is later.
 */
export function diffDays(a: LocalDate, b: LocalDate): number {
  const pa = split(a);
  const pb = split(b);
  return daysFromCivil(pa.y, pa.m, pa.d) - daysFromCivil(pb.y, pb.m, pb.d);
}

/**
 * Start of month
 */
export function startOfMonth(d: LocalDate): LocalDate {
  const { y, m } = split(d);
  return make(y, m, 1);
}

/**
 * End of month
 */
export function endOfMonth(d: LocalDate): LocalDate {
  const { y, m } = split(d);
  return make(y, m, daysInMonth(y, m));
}

/**
 * List of first-of-month dates between two dates
 */
export function monthsBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const result: LocalDate[] = [];
  let current = startOfMonth(from);
  const toStart = startOfMonth(to);
  while (compare(current, toStart) <= 0) {
    result.push(current);
    current = addMonthsClamped(current, 1, 1);
  }
  return result;
}

/**
 * Get today's LocalDate in a timezone
 * This is the ONLY timezone conversion (TD-01 §3)
 */
export function todayIn(tz: string, now: number): LocalDate {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find(p => p.type === 'year')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;
  
  if (!year || !month || !day) {
    throw new Error('Failed to format date');
  }
  
  return `${year}-${month}-${day}` as LocalDate;
}

/**
 * Get current time in a timezone
 */
export function nowTimeIn(tz: string, now: number): LocalTime {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = parts.find(p => p.type === 'hour')?.value;
  const minute = parts.find(p => p.type === 'minute')?.value;
  const second = parts.find(p => p.type === 'second')?.value;
  
  if (!hour || !minute || !second) {
    throw new Error('Failed to format time');
  }
  
  // some engines render midnight as "24" with hour12:false
  return `${hour === '24' ? '00' : hour}:${minute}:${second}` as LocalTime;
}

/**
 * Assert date is allowed (not future, not before MIN_DATE)
 */
export function assertDateAllowed(date: LocalDate, today: LocalDate): void {
  if (compare(date, today) > 0) {
    throw new Error('DATE_IN_FUTURE');
  }
  if (compare(date, MIN_DATE as LocalDate) < 0) {
    throw new Error('DATE_TOO_OLD');
  }
}

/**
 * Default time for a date
 * If date == today, use current time; else 12:00:00
 */
export function defaultTimeFor(date: LocalDate, today: LocalDate, tz: string, now: number): LocalTime {
  if (compare(date, today) === 0) {
    return nowTimeIn(tz, now);
  }
  return '12:00:00' as LocalTime;
}
