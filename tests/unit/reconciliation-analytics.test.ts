import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { reconciliationStatus, type StatusInput } from '@/domain/reconciliation';
import { largestRemainder } from '@/domain/analytics/percent';
import { resolveRange } from '@/domain/analytics/ranges';
import { allocateRepayAll } from '@/domain/loans';
import type { Paisa } from '@/domain/money';

const base = (o: Partial<StatusInput>): StatusInput => ({
  currentExpected: 100_000n,
  currentRevision: 5n,
  changeCountSince: 0,
  now: '2026-10-06T10:00:00Z',
  ...o,
});
const latest = (actual: bigint, difference: bigint, rev: bigint) => ({
  checkedAt: '2026-10-04T10:00:00Z', checkedOn: '2026-10-04', actual, difference, ledgerRevision: rev,
});

describe('[URD-36] [URD-37] [URD-40] reconciliation status truth table', () => {
  it('1 never verified', () => {
    expect(reconciliationStatus(base({})).status).toBe('never_verified');
  });
  it('2 reconciled when current expected equals the last actual (revision same or changed)', () => {
    expect(reconciliationStatus(base({ latest: latest(100_000n, 0n, 5n) })).status).toBe('reconciled');
    expect(reconciliationStatus(base({ latest: latest(100_000n, -500n, 3n) })).status).toBe('reconciled'); // user fixed records
  });
  it('3 matched then changed since -> "changes since", not a mismatch', () => {
    const r = reconciliationStatus(base({ currentExpected: 90_000n, latest: latest(100_000n, 0n, 3n), changeCountSince: 3 }));
    expect(r.status).toBe('changes_since');
  });
  it('4 mismatch only while the ledger is unchanged since the check', () => {
    expect(reconciliationStatus(base({ currentExpected: 100_000n, latest: latest(99_000n, -1000n, 5n) })).status).toBe('mismatch');
  });
  it('5 changed since a mismatching check and still off', () => {
    expect(reconciliationStatus(base({ currentExpected: 98_000n, latest: latest(99_000n, -1000n, 3n) })).status).toBe('changes_since_still_off');
  });
});

describe('[URD-42] analytics maths', () => {
  it('largest remainder always sums to exactly 100 and stays within 1 of the exact share', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 10_000_000n }), { minLength: 1, maxLength: 12 }), (vals) => {
        const total = vals.reduce((a, b) => a + b, 0n);
        const pcts = largestRemainder(vals);
        if (total === 0n) return pcts.every((p) => p === 0);
        const s = pcts.reduce((a, b) => a + b, 0);
        const near = vals.every((v, i) => {
          const exact = Number((v * 10000n) / total) / 100;
          return Math.abs(pcts[i]! - exact) < 1.0001;
        });
        return s === 100 && near;
      }),
      { numRuns: 1000 }
    );
  });
  it('resolves ranges across year boundaries, including leap February', () => {
    const r = resolveRange('last_3', '2027-01-15');
    expect(r.from).toBe('2026-11-01');
    expect(r.to).toBe('2027-01-15');
    expect(resolveRange('prev_month', '2028-03-10')).toMatchObject({ from: '2028-02-01', to: '2028-02-29' });
    expect(resolveRange('this_month', '2026-10-06')).toMatchObject({ from: '2026-10-01', to: '2026-10-06' });
  });
});

describe('[URD-23] repay-all allocation', () => {
  it('pays oldest loans first and stops when money runs out', () => {
    const loans = [
      { id: 'b', loanDate: '2026-10-02', remaining: 300n as Paisa },
      { id: 'a', loanDate: '2026-10-01', remaining: 500n as Paisa },
    ];
    expect(allocateRepayAll(loans, 600n as Paisa)).toEqual([{ loanId: 'a', amount: 500n }, { loanId: 'b', amount: 100n }]);
    expect(allocateRepayAll(loans, 0n as Paisa)).toEqual([]);
  });
});
