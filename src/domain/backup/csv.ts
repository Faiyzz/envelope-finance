/**
 * CSV building - TD-11 §3 (FR-CSV-01, FR-SEC-03). Pure.
 *
 * Formula-injection neutralisation applies to TEXT cells only. Numeric cells
 * are written from a validated `^-?\d+\.\d{2}$` string and never prefixed, so
 * negative amounts stay numeric (GAP U-09).
 */

export const BOM = '﻿';
export const EOL = '\r\n';

const DANGEROUS_FIRST = new Set(['=', '+', '-', '@', '\t', '\r']);

export function neutralizeText(s: string): string {
  return s.length > 0 && DANGEROUS_FIRST.has(s[0]!) ? `'${s}` : s;
}

/** RFC 4180 quoting. */
export function quote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type Cell = { kind: 'text'; v: string | null | undefined } | { kind: 'num'; v: string } | { kind: 'raw'; v: string };

export const text = (v: string | null | undefined): Cell => ({ kind: 'text', v });
export const num = (v: string): Cell => ({ kind: 'num', v });
/** Pre-validated safe values (ISO dates, uuids, booleans). */
export const raw = (v: string): Cell => ({ kind: 'raw', v });

export function renderCell(c: Cell): string {
  switch (c.kind) {
    case 'text':
      return quote(neutralizeText(c.v ?? ''));
    case 'num':
      if (!/^-?\d+\.\d{2}$/.test(c.v)) throw new Error(`Invalid numeric cell: ${c.v}`);
      return c.v;
    case 'raw':
      return quote(c.v);
  }
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return BOM + [header.map(quote).join(','), ...rows.map((r) => r.map(renderCell).join(','))].join(EOL) + EOL;
}

/** Integer paisa -> "-1234.50" (dot decimal, no grouping, no currency). */
export function formatPlain(p: bigint): string {
  const neg = p < 0n;
  const a = neg ? -p : p;
  const whole = a / 100n;
  const frac = (a % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Signed effect on TOTAL for a transaction type (CSV `amount_pkr`). */
export function totalEffect(type: string, amount: bigint): bigint {
  switch (type) {
    case 'opening_balance':
    case 'income':
    case 'external_deposit':
    case 'adjustment':
      return amount;
    case 'expense':
    case 'external_withdrawal':
      return -amount;
    default:
      return 0n;
  }
}

export interface CsvTxRow {
  id: string;
  type: string;
  occurredOn: string;
  occurredAt: string;
  amountPaisa: bigint;
  envelope: string | null;
  toEnvelope: string | null;
  category: string | null;
  note: string | null;
  loan: string | null;
  recurring: string | null;
  generated: boolean;
  ownerName: string | null;
}

export const TX_HEADER = ['date', 'time', 'type', 'envelope', 'to_envelope', 'category', 'amount_pkr', 'note', 'loan', 'recurring', 'generated', 'owner_name', 'id'];

export function transactionsCsv(rows: CsvTxRow[]): string {
  return toCsv(
    TX_HEADER,
    rows.map((r) => [
      raw(r.occurredOn), raw(r.occurredAt), raw(r.type), text(r.envelope), text(r.toEnvelope), text(r.category),
      num(formatPlain(totalEffect(r.type, r.amountPaisa))), text(r.note), text(r.loan), text(r.recurring),
      raw(r.generated ? 'true' : 'false'), text(r.ownerName), raw(r.id),
    ])
  );
}

export interface CsvReconRow {
  checkedAt: string;
  expected: bigint;
  actual: bigint;
  difference: bigint;
  note: string | null;
  adjustment: string | null;
}

export function reconciliationsCsv(rows: CsvReconRow[]): string {
  return toCsv(
    ['checked_at', 'expected_pkr', 'actual_pkr', 'difference_pkr', 'note', 'adjustment'],
    rows.map((r) => [raw(r.checkedAt), num(formatPlain(r.expected)), num(formatPlain(r.actual)), num(formatPlain(r.difference)), text(r.note), text(r.adjustment)])
  );
}

export type CsvKind = 'transactions' | 'expenses' | 'income' | 'reconciliations';
export const CSV_KINDS: CsvKind[] = ['transactions', 'expenses', 'income', 'reconciliations'];
