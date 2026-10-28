/**
 * TS mirror of the SQL `ledger_effects` posting table - TD-01 §5.
 *
 * The SQL view is authoritative; this mirror exists for simulators, the
 * property-test model, and the import snapshot validator (TD-11). A
 * differential test (tests/integration/ledger-differential) keeps them equal.
 *
 * Convention (TD-D1): envelopeId = source ("from"), counterpartEnvelopeId = destination ("to").
 */

import type { Posting, LocalDate, LocalTime } from '@/domain/validation/timeline';
import type { Paisa } from '@/domain/money';

export type TxType =
  | 'opening_balance' | 'income' | 'external_deposit' | 'expense' | 'external_withdrawal'
  | 'allocation' | 'deallocation' | 'transfer' | 'loan' | 'loan_repayment' | 'adjustment';

export interface LedgerTx {
  id: string;
  type: TxType;
  amountPaisa: bigint;
  occurredOn: string;
  occurredAt: string;
  createdAt: string;
  envelopeId: string | null;
  counterpartEnvelopeId: string | null;
  splits?: Array<{ envelopeId: string; amountPaisa: bigint }>;
}

export interface RawPosting {
  account: 'TOTAL' | 'UNALLOCATED' | 'ENVELOPE';
  envelopeId: string | null;
  delta: bigint;
}

export function postingsFor(tx: LedgerTx): RawPosting[] {
  const a = tx.amountPaisa;
  const out: RawPosting[] = [];
  const push = (account: RawPosting['account'], envelopeId: string | null, delta: bigint) => {
    if (delta !== 0n) out.push({ account, envelopeId, delta });
  };
  const splitTotal = (tx.splits ?? []).reduce((s, x) => s + x.amountPaisa, 0n);

  switch (tx.type) {
    case 'opening_balance':
      push('TOTAL', null, a);
      push('UNALLOCATED', null, a);
      break;
    case 'income':
      push('TOTAL', null, a);
      push('UNALLOCATED', null, a - splitTotal);
      for (const s of tx.splits ?? []) push('ENVELOPE', s.envelopeId, s.amountPaisa);
      break;
    case 'external_deposit':
      push('TOTAL', null, a);
      push('ENVELOPE', tx.envelopeId, a);
      break;
    case 'expense':
    case 'external_withdrawal':
      push('TOTAL', null, -a);
      push('ENVELOPE', tx.envelopeId, -a);
      break;
    case 'allocation':
      push('UNALLOCATED', null, -a);
      push('ENVELOPE', tx.envelopeId, a);
      break;
    case 'deallocation':
      push('UNALLOCATED', null, a);
      push('ENVELOPE', tx.envelopeId, -a);
      break;
    case 'transfer':
    case 'loan':
    case 'loan_repayment':
      push('ENVELOPE', tx.envelopeId, -a);
      push('ENVELOPE', tx.counterpartEnvelopeId, a);
      break;
    case 'adjustment':
      push('TOTAL', null, a);
      if (tx.envelopeId === null) push('UNALLOCATED', null, a);
      else push('ENVELOPE', tx.envelopeId, a);
      break;
  }
  return out;
}

/** Postings usable by findFirstViolation (TOTAL excluded). */
export function timelinePostings(txs: LedgerTx[]): Posting[] {
  const res: Posting[] = [];
  for (const tx of txs) {
    for (const p of postingsFor(tx)) {
      if (p.account === 'TOTAL') continue;
      res.push({
        txId: tx.id,
        seq: [tx.occurredOn as LocalDate, tx.occurredAt as LocalTime, tx.createdAt, tx.id],
        account: p.account,
        envelopeId: p.envelopeId,
        delta: p.delta as Paisa,
      });
    }
  }
  return res;
}

export interface LedgerBalances {
  total: bigint;
  unallocatedExplicit: bigint;
  envelopes: Map<string, bigint>;
  /** total - Σ envelopes (FR-LED-02) */
  unallocated: bigint;
}

export function balancesOf(txs: LedgerTx[]): LedgerBalances {
  let total = 0n;
  let unallocatedExplicit = 0n;
  const envelopes = new Map<string, bigint>();
  for (const tx of txs) {
    for (const p of postingsFor(tx)) {
      if (p.account === 'TOTAL') total += p.delta;
      else if (p.account === 'UNALLOCATED') unallocatedExplicit += p.delta;
      else envelopes.set(p.envelopeId!, (envelopes.get(p.envelopeId!) ?? 0n) + p.delta);
    }
  }
  let sum = 0n;
  for (const v of envelopes.values()) sum += v;
  return { total, unallocatedExplicit, envelopes, unallocated: total - sum };
}
