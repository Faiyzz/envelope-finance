/**
 * URD §21 traceability gate (TD-13 §3): every test number must appear as a
 * `[URD-n]` tag in at least one test title.
 *
 *   npm run check:traceability            ratchet: fail if coverage drops below the baseline
 *   npm run check:traceability -- --strict  fail if ANY of the 52 is untagged (release gate)
 *   npm run check:traceability -- --update  rewrite the baseline after adding tests
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const TOTAL = 52;
const BASELINE = 'tests/traceability-baseline.json';

const TOPICS: Record<number, string> = {
  1: 'Money parsing', 2: 'Exact sums', 3: 'Amount limits', 4: 'Boundary balances', 5: 'Allocation boundary', 6: 'Income splits',
  7: 'Backdated expense', 8: 'Delete funding income', 9: 'Edit amount', 10: 'Edit envelope', 11: 'Concurrent overspend', 12: 'Idempotent double submit',
  13: 'Stale version', 14: 'Soft delete/restore', 15: 'Envelope names', 16: 'Owner type lock', 17: 'Archive flows', 18: 'Hard delete rules',
  19: 'Held-money effects', 20: 'Others envelopes cannot lend', 21: 'Loan boundaries', 22: 'Loan leaves Total', 23: 'Repayments', 24: 'Own funds negative',
  25: 'Delete loan/repayment', 26: 'Opposite-direction loans', 27: 'Loans excluded from analytics', 28: 'Borrow-on-shortfall flow', 29: 'Recurrence clamping',
  30: 'Generation idempotent', 31: 'Catch-up generation', 32: 'Needs attention', 33: 'Pause/resume/skip/committee', 34: 'Edit/delete rule', 35: 'Income template with archived envelope',
  36: 'Reconciled -> changes since', 37: 'Mismatch wording', 38: 'Adjustment', 39: 'Changed-since badge', 40: 'Actual < 0 / large mismatch', 41: 'Analytics counts only income/expense',
  42: 'Percent/zero months/TZ', 43: 'Archived/renamed category', 44: 'IDOR matrix', 45: 'Login throttling/seed', 46: 'XSS/CSV injection', 47: 'Logout/session revoke',
  48: 'Import/export round trip', 49: 'Offline / no leak', 50: 'Themes, 320px, zoom, SR', 51: 'Quick expense', 52: 'Midnight PKT/UTC',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(test|spec)\.ts$/.test(f) ? [p] : [];
  });
}

const covered = new Set<number>();
for (const file of walk('tests')) {
  for (const m of readFileSync(file, 'utf8').matchAll(/\[URD-(\d+)\]/g)) covered.add(Number(m[1]));
}

const missing = Array.from({ length: TOTAL }, (_, i) => i + 1).filter((n) => !covered.has(n));
console.log(`URD §21 traceability: ${covered.size}/${TOTAL} covered`);
if (missing.length) console.log('Untagged: ' + missing.map((n) => `${n} (${TOPICS[n]})`).join(', '));

const args = process.argv.slice(2);
if (args.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify([...covered].sort((a, b) => a - b)) + '\n');
  console.log(`Baseline updated (${covered.size}).`);
  process.exit(0);
}
if (args.includes('--strict')) process.exit(missing.length ? 1 : 0);

const baseline: number[] = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : [];
const regressed = baseline.filter((n) => !covered.has(n));
if (regressed.length) {
  console.error(`Coverage regressed for URD tests: ${regressed.join(', ')}`);
  process.exit(1);
}
