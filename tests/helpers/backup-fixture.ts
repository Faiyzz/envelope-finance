import { createHash } from 'crypto';
import { canonicalJson } from '@/domain/backup/canonical';
import type { BackupBody, BackupDoc } from '@/domain/backup/schema';

let n = 0;
let calls = 0;
let prefix = '00000000';
/** Unique per makeFixture() call, so two fixtures never share ids (collision tests build them on purpose). */
export const id = () => {
  n++;
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
};
const TS = '2026-10-01T10:00:00.000Z';

export interface Fx extends BackupBody {}

/** Reference-scenario-like ledger: opening 200,000; Home 50,000; Personal 80,000; Ahmed (other) 20,000; one loan + repayment. */
export function makeFixture() {
  n = 0;
  calls++;
  prefix = calls.toString(16).padStart(8, '0');
  const ids = {
    home: id(), personal: id(), ahmed: id(), catX: id(), catI: id(), catGroceries: id(),
    open: id(), aHome: id(), aPers: id(), aAhmed: id(), exp: id(), loan: id(), loanTx: id(), repTx: id(),
  };
  const tx = (o: Partial<Fx['transactions'][number]> & Pick<Fx['transactions'][number], 'id' | 'type' | 'amount_paisa'>): Fx['transactions'][number] => ({
    occurred_on: '2026-10-01', occurred_at: '12:00:00', envelope_id: null, counterpart_envelope_id: null, category_id: null,
    note: null, loan_id: null, recurring_id: null, is_generated: false, parent_transaction_id: null, deleted_at: null,
    version: 1, created_at: TS, updated_at: TS, ...o,
  });
  const env = (e: Partial<Fx['envelopes'][number]> & Pick<Fx['envelopes'][number], 'id' | 'name'>): Fx['envelopes'][number] => ({
    description: null, icon: '💼', color: null, owner_type: 'mine', owner_name: null, kind: 'standard', goal_amount_paisa: null,
    status: 'active', archived_at: null, sort_order: 0, created_at: TS, updated_at: TS, ...e,
  });
  const cat = (c: Partial<Fx['categories'][number]> & Pick<Fx['categories'][number], 'id' | 'name' | 'kind'>): Fx['categories'][number] => ({
    group_name: null, status: 'active', is_system: false, sort_order: 0, created_at: TS, updated_at: TS, ...c,
  });

  const body: Fx = {
    schema_version: 1,
    exported_at: '2026-10-06T10:00:00.000Z',
    app_version: 'test',
    timezone: 'Asia/Karachi',
    profile: { name: 'Test', email: 't@example.com', currency: 'PKR', timezone: 'Asia/Karachi', theme: 'system', number_grouping: 'western', week_start: 1, hide_balances_default: false },
    envelopes: [
      env({ id: ids.home, name: 'Home', icon: '🏠' }),
      env({ id: ids.personal, name: 'Personal', sort_order: 1 }),
      env({ id: ids.ahmed, name: 'Ahmed', owner_type: 'other', owner_name: 'Ahmed', sort_order: 2 }),
    ],
    categories: [
      cat({ id: ids.catX, name: 'Uncategorized', kind: 'expense', is_system: true }),
      cat({ id: ids.catI, name: 'Uncategorized', kind: 'income', is_system: true }),
      cat({ id: ids.catGroceries, name: 'Groceries', kind: 'expense', group_name: 'home' }),
    ],
    transactions: [
      tx({ id: ids.open, type: 'opening_balance', amount_paisa: '20000000', occurred_at: '00:00:00' }),
      tx({ id: ids.aHome, type: 'allocation', amount_paisa: '5000000', envelope_id: ids.home, occurred_at: '00:00:01' }),
      tx({ id: ids.aPers, type: 'allocation', amount_paisa: '8000000', envelope_id: ids.personal, occurred_at: '00:00:02' }),
      tx({ id: ids.aAhmed, type: 'allocation', amount_paisa: '2000000', envelope_id: ids.ahmed, occurred_at: '00:00:03' }),
      tx({ id: ids.exp, type: 'expense', amount_paisa: '250000', envelope_id: ids.home, category_id: ids.catGroceries, occurred_on: '2026-10-02' }),
      tx({ id: ids.loanTx, type: 'loan', amount_paisa: '500000', envelope_id: ids.personal, counterpart_envelope_id: ids.home, loan_id: ids.loan, occurred_on: '2026-10-03' }),
      tx({ id: id(), type: 'loan_repayment', amount_paisa: '200000', envelope_id: ids.home, counterpart_envelope_id: ids.personal, loan_id: ids.loan, occurred_on: '2026-10-04' }),
    ],
    transaction_splits: [],
    loans: [{ id: ids.loan, lender_envelope_id: ids.personal, borrower_envelope_id: ids.home, note: null, deleted_at: null, created_at: TS, updated_at: TS }],
    recurring_rules: [],
    recurring_occurrences: [],
    reconciliations: [],
    audit_log: [],
  };
  return { body, ids };
}

export const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

export function sealed(body: Fx): BackupDoc {
  return { ...body, checksum: sha(canonicalJson(body)) };
}

export function toBytes(doc: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}
