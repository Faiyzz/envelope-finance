/**
 * Date types - TD-00 §4.2
 * 
 * LocalDate = branded string 'YYYY-MM-DD' (user's calendar date)
 * LocalTime = branded string 'HH:MM:SS'
 * Both map to Postgres DATE/TIME.
 * Calendar maths never use JS Date (TD-01 §3).
 */

export type LocalDate = string & { readonly __brand: unique symbol };
export type LocalTime = string & { readonly __brand: unique symbol };

export function localDate(value: string): LocalDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Invalid LocalDate format: expected YYYY-MM-DD');
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error('Invalid LocalDate');
  }
  return value as LocalDate;
}

export function localTime(value: string): LocalTime {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new Error('Invalid LocalTime format: expected HH:MM:SS');
  }
  return value as LocalTime;
}

export function asLocalDate(value: string): LocalDate {
  return value as LocalDate;
}

export function asLocalTime(value: string): LocalTime {
  return value as LocalTime;
}

// Instant is a UTC timestamp (milliseconds since epoch)
export type Instant = number & { readonly __brand: unique symbol };

export function instant(value: number): Instant {
  if (value < 0) {
    throw new Error('Instant cannot be negative');
  }
  return value as Instant;
}

export function asInstant(value: number): Instant {
  return value as Instant;
}

// Clock interface for dependency injection (TD-00 §4.2)
export interface Clock {
  now(): Instant;
}
