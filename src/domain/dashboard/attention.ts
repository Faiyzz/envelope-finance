/**
 * Attention strip rules - TD-10 §4.4. Pure.
 *
 * Priority: needs-attention recurring > integrity failure > stale
 * reconciliation (> 14 days) > auto-paused rules. Max 3 shown.
 */

import type { AttentionItem } from './types';

export const ATTENTION_MAX = 3;
export const RECON_STALE_DAYS = 14;

export interface AttentionInput {
  needsAttention: Extract<AttentionItem, { kind: 'needs_attention' }>[];
  integrityFailed: boolean;
  /** null when the user has never saved a check (handled by the chip, not nagged). */
  daysSinceCheck: number | null;
  pausedRules: Array<{ ruleId: string; ruleName: string }>;
}

export function buildAttention(input: AttentionInput): { all: AttentionItem[]; shown: AttentionItem[]; more: number } {
  const all: AttentionItem[] = [...input.needsAttention];
  if (input.integrityFailed) all.push({ kind: 'integrity_failed' });
  if (input.daysSinceCheck !== null && input.daysSinceCheck > RECON_STALE_DAYS) {
    all.push({ kind: 'recon_stale', days: input.daysSinceCheck });
  }
  for (const r of input.pausedRules) all.push({ kind: 'rule_paused', ...r });
  const shown = all.slice(0, ATTENTION_MAX);
  return { all, shown, more: all.length - shown.length };
}
