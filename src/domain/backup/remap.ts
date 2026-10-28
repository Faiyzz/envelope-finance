/**
 * Deterministic id remapping - TD-D9 / TD-11 §4.4.3. Pure given a uuidv5 function.
 *
 * If any id in the file collides with another user's row, EVERY id is remapped
 * with uuidv5(oldId, namespace = userId): deterministic, so re-importing the
 * same file yields identical ids (idempotent).
 */

import type { BackupBody } from './schema';

export type Uuid5 = (name: string, namespace: string) => string;

export function allIds(doc: BackupBody): string[] {
  return [
    ...doc.envelopes, ...doc.categories, ...doc.transactions, ...doc.transaction_splits,
    ...doc.loans, ...doc.recurring_rules, ...doc.recurring_occurrences, ...doc.reconciliations, ...doc.audit_log,
  ].map((r) => r.id);
}

export function remapDoc(doc: BackupBody, userId: string, v5: Uuid5): BackupBody {
  const cache = new Map<string, string>();
  const m = (id: string) => {
    let r = cache.get(id);
    if (!r) {
      r = v5(id, userId);
      cache.set(id, r);
    }
    return r;
  };
  const mn = (id: string | null) => (id === null ? null : m(id));

  return {
    ...doc,
    envelopes: doc.envelopes.map((e) => ({ ...e, id: m(e.id) })),
    categories: doc.categories.map((x) => ({ ...x, id: m(x.id) })),
    loans: doc.loans.map((l) => ({ ...l, id: m(l.id), lender_envelope_id: m(l.lender_envelope_id), borrower_envelope_id: m(l.borrower_envelope_id) })),
    recurring_rules: doc.recurring_rules.map((r) => ({
      ...r,
      id: m(r.id),
      envelope_id: mn(r.envelope_id),
      category_id: m(r.category_id),
      split_template: r.split_template ? r.split_template.map((t) => ({ ...t, envelopeId: m(t.envelopeId) })) : null,
    })),
    transactions: doc.transactions.map((t) => ({
      ...t,
      id: m(t.id),
      envelope_id: mn(t.envelope_id),
      counterpart_envelope_id: mn(t.counterpart_envelope_id),
      category_id: mn(t.category_id),
      loan_id: mn(t.loan_id),
      recurring_id: mn(t.recurring_id),
      parent_transaction_id: mn(t.parent_transaction_id),
    })),
    transaction_splits: doc.transaction_splits.map((s) => ({ ...s, id: m(s.id), transaction_id: m(s.transaction_id), envelope_id: m(s.envelope_id) })),
    recurring_occurrences: doc.recurring_occurrences.map((o) => ({ ...o, id: m(o.id), rule_id: m(o.rule_id), transaction_id: mn(o.transaction_id) })),
    reconciliations: doc.reconciliations.map((r) => ({ ...r, id: m(r.id), adjustment_transaction_id: mn(r.adjustment_transaction_id) })),
    audit_log: doc.audit_log.map((a) => ({ ...a, id: m(a.id), entity_id: m(a.entity_id) })),
  };
}
