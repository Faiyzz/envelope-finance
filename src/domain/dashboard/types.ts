/**
 * Dashboard DTOs - TD-10 §4.1
 *
 * Money crosses the server/client boundary as decimal strings of integer
 * paisa (TD-00 §4.1). Never bigint in JSON, never floats.
 */

export type PaisaStr = string;

export interface EnvelopeCardDTO {
  id: string;
  name: string;
  icon: string;
  ownerType: 'mine' | 'other';
  ownerName: string | null;
  kind: 'standard' | 'savings';
  balance: PaisaStr;
  txCount: number;
  borrowed: PaisaStr;
  loanedOut: PaisaStr;
  ownFunds: PaisaStr;
  goal?: { amount: PaisaStr; progressPct: number };
}

export interface RecentTxDTO {
  id: string;
  type: string;
  /** Signed effect on the envelope (or Total for income) in paisa. */
  signedAmount: PaisaStr;
  envelopeName: string | null;
  counterpartName: string | null;
  categoryName: string | null;
  note: string | null;
  occurredOn: string;
  onBehalfOf: string | null;
}

export interface UpcomingDTO {
  id: string;
  ruleName: string;
  type: 'expense' | 'income';
  amount: PaisaStr;
  dueDate: string;
  /** Days from today; negative = overdue. */
  inDays: number;
  needsAttention: boolean;
  envelopeName?: string;
}

export type ReconStatusKey =
  | 'never_verified'
  | 'reconciled'
  | 'changes_since'
  | 'mismatch'
  | 'changes_since_still_off';

export interface ReconChipDTO {
  status: ReconStatusKey;
  /** Signed difference (actual - expected) for mismatch states. */
  difference?: PaisaStr;
  /** Absolute figure used by `changes_since_still_off` copy. */
  actual?: PaisaStr;
  checkedOn?: string;
  changeCount?: number;
  /** True when the check still describes the current ledger. */
  current?: boolean;
}

export type AttentionItem =
  | {
      kind: 'needs_attention';
      id: string;
      ruleName: string;
      amount: PaisaStr;
      dueDate: string;
      envelopeId?: string;
      envelopeName?: string;
      available?: PaisaStr;
    }
  | { kind: 'integrity_failed' }
  | { kind: 'recon_stale'; days: number }
  | { kind: 'rule_paused'; ruleId: string; ruleName: string };

export interface DashboardDTO {
  total: PaisaStr;
  yourMoney: PaisaStr;
  heldForOthers: PaisaStr;
  unallocated: PaisaStr;
  recon: ReconChipDTO;
  attention: AttentionItem[];
  envelopes: EnvelopeCardDTO[];
  upcoming: UpcomingDTO[];
  recent: RecentTxDTO[];
  setup: { hasOpeningBalance: boolean; hasEnvelopes: boolean };
  today: string;
  fetchedAt: string;
}
