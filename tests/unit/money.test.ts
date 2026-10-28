import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluateAmountExpression, formatMoney, parseMoney, sum, MAX_PAISA, type Paisa } from '@/domain/money';

const ok = (s: string) => {
  const r = parseMoney(s);
  return r.ok ? r.value : null;
};

describe('[URD-1] money parsing', () => {
  it('parses plain, grouped and padded input', () => {
    expect(ok('2,500')).toBe(250000n);
    expect(ok('2500.50')).toBe(250050n);
    expect(ok(' 2500 ')).toBe(250000n);
    expect(ok('2,00,000')).toBe(20000000n); // lakh grouping accepted on input
    expect(ok('2500.5')).toBe(250050n);
  });
  it('rejects too many decimals, negatives, zero, exponent, junk', () => {
    expect(parseMoney('2500.555').ok).toBe(false);
    for (const bad of ['-5', '0', '1e3', '', 'abc', '1,2,3', '12,34', '.5', '5.', 'NaN', '0x10', '1 000,5']) {
      expect(parseMoney(bad).ok, bad).toBe(false);
    }
  });
  it('normalises Arabic-Indic and Urdu digits', () => {
    expect(ok('٢٥٠٠')).toBe(250000n);
    expect(ok('۲۵۰۰')).toBe(250000n);
    expect(ok('٢٥٠٠٫٥٠')).toBe(250050n);
  });
  it('evaluates calculator input without eval', () => {
    const r = evaluateAmountExpression('1200+350');
    expect(r.ok && r.value).toBe(155000n);
    expect(evaluateAmountExpression('1200+').ok).toBe(false);
    expect(evaluateAmountExpression('1200-350').ok).toBe(false);
    expect(evaluateAmountExpression('2*3').ok).toBe(false);
  });
});

describe('[URD-2] exact arithmetic', () => {
  it('0.10 + 0.20 is exactly 0.30', () => {
    expect(sum([ok('0.10')!, ok('0.20')!])).toBe(30n);
  });
  it('10,000 random sums equal a BigInt fold', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 1_000_000_000n }), { minLength: 1, maxLength: 20 }), (xs) => {
        const expected = xs.reduce((a, b) => a + b, 0n);
        return sum(xs as Paisa[]) === expected;
      }),
      { numRuns: 10_000 }
    );
  });
  it('parse(format(x)) round-trips across the range', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: MAX_PAISA }), (x) => {
        const text = formatMoney(x as Paisa, { currency: false, decimals: 'always' });
        const r = parseMoney(text);
        return r.ok && r.value === x;
      }),
      { numRuns: 2_000 }
    );
  });
  it('formats negatives with a true minus and never emits NaN', () => {
    expect(formatMoney(-250050n as Paisa)).toBe('−2,500.50 PKR');
    expect(formatMoney(250000n as Paisa)).toBe('2,500 PKR');
    expect(formatMoney(5n as Paisa)).toBe('0.05 PKR');
    expect(formatMoney(20000000n as Paisa, { grouping: 'lakh', currency: false })).toBe('2,00,000');
    expect(formatMoney(-5n as Paisa)).not.toMatch(/NaN|undefined|--/);
  });
});

describe('[URD-3] limits', () => {
  it('accepts the maximum and rejects one paisa above', () => {
    expect(ok('999,999,999.99')).toBe(MAX_PAISA);
    expect(parseMoney('1,000,000,000').ok).toBe(false);
    expect(parseMoney('999999999.99').ok).toBe(true);
    expect(parseMoney('1000000000').ok).toBe(false);
  });
});
