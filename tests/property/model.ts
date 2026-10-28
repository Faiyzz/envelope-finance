/**
 * Reference model for the property tests - TD-13 §2.
 *
 * Deliberately independent of the SQL view and of domain/ledger/effects.ts: it
 * keeps per-account chronological delta lists and checks prefix sums, using its
 * own tiny effect rules. It decides accept/reject for every operation.
 */

export type Env = 'H' | 'P' | 'X'; // Home, Personal (mine), Ahmed (other)

export interface MTx {
  id: number;
  type: string;
  amount: bigint;
  on: string;
  at: string;
  seq: number; // creation order (created_at tiebreak)
  env?: Env;
  cp?: Env;
  splits?: Array<{ env: Env; amount: bigint }>;
  loan?: number;
  deleted: boolean;
}

type Delta = { acct: string; d: bigint; key: [string, string, number] };

function effects(t: MTx): Delta[] {
  const key: [string, string, number] = [t.on, t.at, t.seq];
  const out: Delta[] = [];
  const a = t.amount;
  const add = (acct: string, d: bigint) => out.push({ acct, d, key });
  switch (t.type) {
    case 'income': {
      const sp = (t.splits ?? []).reduce((s, x) => s + x.amount, 0n);
      add('U', a - sp);
      for (const s of t.splits ?? []) add(s.env, s.amount);
      break;
    }
    case 'expense': case 'extWithdraw': add(t.env!, -a); break;
    case 'extDeposit': add(t.env!, a); break;
    case 'allocate': add('U', -a); add(t.env!, a); break;
    case 'deallocate': add('U', a); add(t.env!, -a); break;
    case 'transfer': case 'loan': case 'repay': add(t.env!, -a); add(t.cp!, a); break;
  }
  return out;
}

export const totalEffect = (t: MTx): bigint =>
  t.type === 'income' || t.type === 'extDeposit' ? t.amount : t.type === 'expense' || t.type === 'extWithdraw' ? -t.amount : 0n;

const cmp = (a: [string, string, number], b: [string, string, number]) =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] - b[2];

/** True iff no account (and no loan) ever goes negative over the whole timeline. */
export function isValid(txs: MTx[]): boolean {
  const live = txs.filter((t) => !t.deleted);
  const byAcct = new Map<string, Delta[]>();
  for (const t of live) for (const e of effects(t)) (byAcct.get(e.acct) ?? byAcct.set(e.acct, []).get(e.acct)!).push(e);
  for (const list of byAcct.values()) {
    list.sort((x, y) => cmp(x.key, y.key));
    let run = 0n;
    for (const e of list) { run += e.d; if (run < 0n) return false; }
  }
  // loans: running remaining per loan >= 0
  const byLoan = new Map<number, MTx[]>();
  for (const t of live) if (t.loan !== undefined) (byLoan.get(t.loan) ?? byLoan.set(t.loan, []).get(t.loan)!).push(t);
  for (const list of byLoan.values()) {
    list.sort((x, y) => cmp([x.on, x.at, x.seq], [y.on, y.at, y.seq]));
    let rem = 0n;
    for (const t of list) { rem += t.type === 'loan' ? t.amount : -t.amount; if (rem < 0n) return false; }
  }
  return true;
}

export function balances(txs: MTx[]) {
  const acct = new Map<string, bigint>();
  let total = 0n;
  for (const t of txs.filter((x) => !x.deleted)) {
    total += totalEffect(t);
    for (const e of effects(t)) acct.set(e.acct, (acct.get(e.acct) ?? 0n) + e.d);
  }
  const env = (e: Env) => acct.get(e) ?? 0n;
  return { total, unallocated: acct.get('U') ?? 0n, H: env('H'), P: env('P'), X: env('X') };
}
