import { describe, expect, it } from 'vitest';
import { BOM, formatPlain, neutralizeText, quote, renderCell, text, num, toCsv, transactionsCsv, reconciliationsCsv, TX_HEADER } from '@/domain/backup/csv';

describe('[URD-46] CSV safety', () => {
  it('neutralises formula injection in TEXT cells', () => {
    for (const bad of ['=cmd|"/c calc"!A1', '+1', '-2', '@SUM(A1)', '\tfoo', '\rfoo']) {
      expect(neutralizeText(bad).startsWith("'")).toBe(true);
    }
    expect(neutralizeText('Groceries')).toBe('Groceries');
    expect(neutralizeText('')).toBe('');
  });
  it('never prefixes numeric cells (negative amounts stay numeric)', () => {
    expect(renderCell(num('-500.00'))).toBe('-500.00');
    expect(() => renderCell(num('=1+1'))).toThrow();
    expect(() => renderCell(num('-5'))).toThrow();
  });
  it('quotes per RFC 4180', () => {
    expect(quote('a,b')).toBe('"a,b"');
    expect(quote('say "hi"')).toBe('"say ""hi"""');
    expect(quote('line\nbreak')).toBe('"line\nbreak"');
    expect(quote('plain')).toBe('plain');
  });
  it('has a BOM, CRLF endings and the documented header', () => {
    const csv = toCsv(['a'], [[text('x')]]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toContain('\r\n');
    expect(transactionsCsv([]).slice(1).split('\r\n')[0]).toBe(TX_HEADER.join(','));
  });
  it('formats signed amounts and exports a hostile note safely', () => {
    expect(formatPlain(-123450n)).toBe('-1234.50');
    expect(formatPlain(5n)).toBe('0.05');
    expect(formatPlain(250000n)).toBe('2500.00');
    const csv = transactionsCsv([{
      id: 'i', type: 'expense', occurredOn: '2026-10-06', occurredAt: '12:00:00', amountPaisa: 250000n,
      envelope: '=HYPERLINK("x")', toEnvelope: null, category: 'Food', note: '@SUM(1)', loan: null, recurring: null, generated: false, ownerName: null,
    }]);
    const row = csv.split('\r\n')[1]!;
    expect(row).toContain('-2500.00'); // expense = negative effect on Total, unprefixed
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(row).toContain("'@SUM(1)");
  });
  it('transfers and loans have zero effect on Total', () => {
    const row = transactionsCsv([{ id: 'i', type: 'transfer', occurredOn: '2026-10-06', occurredAt: '12:00:00', amountPaisa: 100n, envelope: 'A', toEnvelope: 'B', category: null, note: null, loan: null, recurring: null, generated: false, ownerName: null }]).split('\r\n')[1]!;
    expect(row).toContain(',0.00,');
  });
  it('reconciliation csv', () => {
    const c = reconciliationsCsv([{ checkedAt: '2026-10-06T10:00:00.000Z', expected: 100000n, actual: 90000n, difference: -10000n, note: null, adjustment: null }]);
    expect(c).toContain('-100.00');
  });
});
