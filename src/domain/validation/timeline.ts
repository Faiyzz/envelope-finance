/**
 * Timeline validation - TD-01 §6.4
 * 
 * Pure counterpart to SQL verifier. Used by snapshot validator and simulators.
 */

import type { Paisa } from '@/domain/money';

export type LocalDate = string & { readonly __brand: 'LocalDate' };
export type LocalTime = string & { readonly __brand: 'LocalTime' };

export interface Posting {
  txId: string;
  seq: SortKey;
  account: 'UNALLOCATED' | 'ENVELOPE';
  envelopeId: string | null;
  delta: Paisa;
}

export type SortKey = readonly [on: LocalDate, at: LocalTime, createdAt: string, id: string];

export type Violation =
  | { kind: 'envelope'; envelopeId: string; at: LocalDate; txId: string; shortfall: Paisa }
  | { kind: 'unallocated'; at: LocalDate; txId: string; shortfall: Paisa }
  | { kind: 'loan'; loanId: string; at: LocalDate; txId: string; shortfall: Paisa };

/**
 * Find first violation in a list of postings
 * Sorts, replays, returns first negative balance
 */
export function findFirstViolation(postings: Posting[]): Violation | null {
  // Sort by sequence key
  const sorted = [...postings].sort((a, b) => {
    const [aOn, aAt, aCreated, aId] = a.seq;
    const [bOn, bAt, bCreated, bId] = b.seq;
    
    if (aOn !== bOn) return aOn < bOn ? -1 : 1;
    if (aAt !== bAt) return aAt < bAt ? -1 : 1;
    if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
    if (aId !== bId) return aId < bId ? -1 : 1;
    return 0;
  });

  // Track running balances per account
  const balances = new Map<string, Paisa>();
  
  for (const posting of sorted) {
    const key = posting.account === 'UNALLOCATED' 
      ? 'UNALLOCATED' 
      : `ENVELOPE:${posting.envelopeId}`;
    
    const current = balances.get(key) ?? 0n;
    const newBalance = current + posting.delta;
    balances.set(key, newBalance as Paisa);
    
    if (newBalance < 0n) {
      if (posting.account === 'UNALLOCATED') {
        return {
          kind: 'unallocated',
          at: posting.seq[0],
          txId: posting.txId,
          shortfall: (-newBalance) as Paisa,
        };
      } else {
        return {
          kind: 'envelope',
          envelopeId: posting.envelopeId!,
          at: posting.seq[0],
          txId: posting.txId,
          shortfall: (-newBalance) as Paisa,
        };
      }
    }
  }
  
  return null;
}

/**
 * Find first loan violation
 * Loans have a single loan posting (+A) and N loan_repayment postings (-A)
 * Running remaining must never be negative
 */
export function findFirstLoanViolation(
  loanPostings: Array<{ loanId: string; txId: string; type: 'loan' | 'loan_repayment'; amount: Paisa; seq: SortKey }>
): { loanId: string; at: LocalDate; txId: string; shortfall: Paisa } | null {
  // Sort by sequence key
  const sorted = [...loanPostings].sort((a, b) => {
    const [aOn, aAt, aCreated, aId] = a.seq;
    const [bOn, bAt, bCreated, bId] = b.seq;
    
    if (aOn !== bOn) return aOn < bOn ? -1 : 1;
    if (aAt !== bAt) return aAt < bAt ? -1 : 1;
    if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
    if (aId !== bId) return aId < bId ? -1 : 1;
    return 0;
  });

  // Track running remaining per loan
  const remaining = new Map<string, Paisa>();
  
  for (const posting of sorted) {
    const current = remaining.get(posting.loanId) ?? 0n;
    const delta = posting.type === 'loan' ? posting.amount : -posting.amount;
    const newRemaining = current + delta;
    remaining.set(posting.loanId, newRemaining as Paisa);
    
    if (newRemaining < 0n) {
      return {
        loanId: posting.loanId,
        at: posting.seq[0],
        txId: posting.txId,
        shortfall: (-newRemaining) as Paisa,
      };
    }
  }
  
  return null;
}
