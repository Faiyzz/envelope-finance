/**
 * Largest-remainder percentage algorithm - TD-09 §4
 * Returns integers summing to 100 (or all 0 when total = 0)
 */

export function largestRemainder(values: bigint[]): number[] {
  const total = values.reduce((sum, v) => sum + v, 0n);

  if (total === 0n) {
    return values.map(() => 0);
  }

  // Compute exact percentages as basis points (100 * value / total)
  const exact: Array<{ value: bigint; quotient: number; remainder: bigint; index: number }> = values.map((v, i) => {
    const scaled = v * 100n;
    const quotient = Number(scaled / total);
    const remainder = scaled % total;
    return { value: v, quotient, remainder, index: i };
  });

  // Floor each
  const result = exact.map(e => e.quotient);
  const sum = result.reduce((s, v) => s + v, 0);

  // Distribute remaining points to largest remainders
  const remaining = 100 - sum;
  const sortedByRemainder = [...exact].sort((a, b) => {
    if (b.remainder !== a.remainder) {
      // Larger remainder first
      return b.remainder > a.remainder ? 1 : -1;
    }
    // Ties: larger value first
    if (b.value !== a.value) {
      return b.value > a.value ? 1 : -1;
    }
    // Then lower index
    return a.index - b.index;
  });

  for (let i = 0; i < remaining && i < sortedByRemainder.length; i++) {
    const item = sortedByRemainder[i];
    if (item) {
      result[item.index] = (result[item.index] ?? 0) + 1;
    }
  }

  return result;
}
