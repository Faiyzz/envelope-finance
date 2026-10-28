/**
 * Loan domain functions - TD-06 §2
 */

import type { Paisa } from '@/domain/money';

export interface Loan {
  id: string;
  loanDate: string;
  remaining: Paisa;
}

/**
 * Calculate remaining amount on a loan
 */
export function remaining(original: Paisa, repayments: Paisa[]): Paisa {
  const totalRepaid = repayments.reduce<bigint>((sum, r) => sum + r, 0n);
  return (original - totalRepaid) as Paisa;
}

/**
 * Allocate repayments across loans (oldest first)
 * Stops when money or loans run out
 */
export function allocateRepayAll(
  loans: Loan[],
  borrowerBalance: Paisa
): Array<{ loanId: string; amount: Paisa }> {
  if (borrowerBalance <= 0n) return [];

  // Sort by loan date, then created (implicitly by array order)
  const sorted = [...loans].sort((a, b) => a.loanDate.localeCompare(b.loanDate));

  const allocations: Array<{ loanId: string; amount: Paisa }> = [];
  let remaining: bigint = borrowerBalance;

  for (const loan of sorted) {
    if (remaining <= 0n) break;
    if (loan.remaining <= 0n) continue;

    const amount = (remaining < loan.remaining ? remaining : loan.remaining) as Paisa;
    allocations.push({ loanId: loan.id, amount });
    remaining -= amount;
  }

  return allocations;
}

/**
 * Calculate own funds (may be negative, NOT clamped)
 */
export function ownFunds(balance: Paisa, borrowed: Paisa): Paisa {
  return (balance - borrowed) as Paisa;
}

/**
 * Validate loan input
 */
export function validateLoanInput(input: {
  lenderEnvelopeId: string;
  borrowerEnvelopeId: string;
  amount: Paisa;
  date: string;
  /** User-local today (YYYY-MM-DD). Defaults to the UTC date. */
  today?: string;
}): { ok: true } | { ok: false; error: string } {
  if (input.lenderEnvelopeId === input.borrowerEnvelopeId) {
    return { ok: false, error: 'Pick two different envelopes' };
  }

  if (input.amount <= 0n) {
    return { ok: false, error: 'Amount must be positive' };
  }

  // Date validation: ≤ today, ≥ 2000-01-01 (ISO dates compare as strings)
  const today = input.today ?? new Date().toISOString().slice(0, 10);

  if (input.date > today) {
    return { ok: false, error: 'Loan date cannot be in the future' };
  }

  if (input.date < '2000-01-01') {
    return { ok: false, error: 'Loan date must be after 2000-01-01' };
  }

  return { ok: true };
}
