/**
 * Reconciliation status state machine - TD-08 §5
 */

export interface StatusInput {
  latest?: {
    checkedAt: string;
    checkedOn: string;
    actual: bigint;
    difference: bigint;
    ledgerRevision: bigint;
  };
  currentExpected: bigint;
  currentRevision: bigint;
  changeCountSince: number;
  now: string;
}

export type ReconciliationStatus =
  | 'never_verified'
  | 'reconciled'
  | 'changes_since'
  | 'mismatch'
  | 'changes_since_still_off';

export interface StatusResult {
  status: ReconciliationStatus;
  message: string;
}

/**
 * Compute reconciliation status from input state
 * Pure function evaluated top-down
 */
export function reconciliationStatus(input: StatusInput): StatusResult {
  // 1. No latest
  if (!input.latest) {
    return {
      status: 'never_verified',
      message: 'Verify with your bank',
    };
  }

  const { latest, currentExpected, currentRevision, changeCountSince } = input;

  // 2. Current expected == latest actual
  if (currentExpected === latest.actual) {
    if (currentRevision === latest.ledgerRevision) {
      return {
        status: 'reconciled',
        message: '✓ Reconciled',
      };
    } else {
      const [, mm, dd] = latest.checkedOn.slice(0, 10).split('-').map(Number);
      const date = `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(mm ?? 1) - 1]} ${dd}`;
      return {
        status: 'reconciled',
        message: `✓ Reconciled · based on your check of ${date}`,
      };
    }
  }

  // 3. Latest difference == 0 (matched then) and revision differs
  if (latest.difference === 0n && currentRevision !== latest.ledgerRevision) {
    return {
      status: 'changes_since',
      message: `${changeCountSince} changes since you last verified`,
    };
  }

  // 4. Latest difference != 0 and revision equal
  if (latest.difference !== 0n && currentRevision === latest.ledgerRevision) {
    const diff = latest.difference;
    const sign = diff > 0n ? '+' : '';
    return {
      status: 'mismatch',
      message: `⚠ ${sign}${diff} PKR mismatch`,
    };
  }

  // 5. Latest difference != 0, revision differs, current expected != latest actual
  if (latest.difference !== 0n && currentRevision !== latest.ledgerRevision && currentExpected !== latest.actual) {
    const diff = latest.difference;
    const sign = diff > 0n ? '+' : '';
    return {
      status: 'changes_since_still_off',
      message: `Records changed since your check. Still ${sign}${diff} off from your bank figure of ${latest.actual}`,
    };
  }

  // Fallback
  return {
    status: 'never_verified',
    message: 'Verify with your bank',
  };
}
