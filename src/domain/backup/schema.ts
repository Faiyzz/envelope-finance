/**
 * Backup document schema v1 - TD-11 §2. Strict: unknown keys (incl. __proto__)
 * are rejected, money is integer-paisa strings, dates ISO.
 */

import { z } from 'zod';

export const CURRENT_SCHEMA_VERSION = 1;

const Id = z.string().uuid();
const PaisaStr = z.string().regex(/^-?\d{1,18}$/);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TimeStr = z.string().regex(/^\d{2}:\d{2}:\d{2}$/);
const Ts = z.string().datetime({ offset: true });
const TsNull = Ts.nullable();
const Text = (max: number) => z.string().max(max);

const TxType = z.enum([
  'opening_balance', 'income', 'external_deposit', 'expense', 'external_withdrawal',
  'allocation', 'deallocation', 'transfer', 'loan', 'loan_repayment', 'adjustment',
]);

export const ProfileSchema = z.object({
  name: Text(60),
  email: Text(254),
  currency: z.literal('PKR'),
  timezone: Text(64),
  theme: z.enum(['system', 'light', 'dark']),
  number_grouping: z.enum(['western', 'lakh']),
  week_start: z.number().int().min(0).max(6),
  hide_balances_default: z.boolean(),
}).strict();

export const EnvelopeSchema = z.object({
  id: Id,
  name: Text(60),
  description: Text(300).nullable(),
  icon: Text(32),
  color: Text(32).nullable(),
  owner_type: z.enum(['mine', 'other']),
  owner_name: Text(60).nullable(),
  kind: z.enum(['standard', 'savings']),
  goal_amount_paisa: PaisaStr.nullable(),
  status: z.enum(['active', 'archived']),
  archived_at: TsNull,
  sort_order: z.number().int(),
  created_at: Ts,
  updated_at: Ts,
}).strict();

export const CategorySchema = z.object({
  id: Id,
  name: Text(40),
  kind: z.enum(['expense', 'income']),
  group_name: z.enum(['home', 'personal', 'other']).nullable(),
  status: z.enum(['active', 'archived']),
  is_system: z.boolean(),
  sort_order: z.number().int(),
  created_at: Ts,
  updated_at: Ts,
}).strict();

export const TransactionSchema = z.object({
  id: Id,
  type: TxType,
  amount_paisa: PaisaStr,
  occurred_on: DateStr,
  occurred_at: TimeStr,
  envelope_id: Id.nullable(),
  counterpart_envelope_id: Id.nullable(),
  category_id: Id.nullable(),
  note: Text(500).nullable(),
  loan_id: Id.nullable(),
  recurring_id: Id.nullable(),
  is_generated: z.boolean(),
  parent_transaction_id: Id.nullable(),
  deleted_at: TsNull,
  version: z.number().int().min(1),
  created_at: Ts,
  updated_at: Ts,
}).strict();

export const SplitSchema = z.object({
  id: Id,
  transaction_id: Id,
  envelope_id: Id,
  amount_paisa: PaisaStr,
}).strict();

export const LoanSchema = z.object({
  id: Id,
  lender_envelope_id: Id,
  borrower_envelope_id: Id,
  note: Text(500).nullable(),
  deleted_at: TsNull,
  created_at: Ts,
  updated_at: Ts,
}).strict();

export const RuleSchema = z.object({
  id: Id,
  name: Text(60),
  type: z.enum(['expense', 'income']),
  amount_paisa: PaisaStr,
  envelope_id: Id.nullable(),
  category_id: Id,
  split_template: z.array(z.object({ envelopeId: Id, amountPaisa: PaisaStr }).strict()).nullable(),
  frequency: z.enum(['weekly', 'monthly', 'yearly', 'custom_days']),
  interval_n: z.number().int().min(1).max(366),
  anchor_day: z.number().int().min(1).max(31).nullable(),
  start_date: DateStr,
  end_date: DateStr.nullable(),
  max_occurrences: z.number().int().min(1).nullable(),
  status: z.enum(['active', 'paused', 'completed', 'ended']),
  pause_reason: z.enum(['user', 'envelope_archived']).nullable(),
  is_committee: z.boolean(),
  next_slot_index: z.number().int().min(0),
  version: z.number().int().min(1),
  created_at: Ts,
  updated_at: Ts,
}).strict();

export const OccurrenceSchema = z.object({
  id: Id,
  rule_id: Id,
  slot_index: z.number().int().min(0),
  due_date: DateStr,
  status: z.enum(['generated', 'skipped', 'needs_attention']),
  transaction_id: Id.nullable(),
  note: Text(300).nullable(),
  created_at: Ts,
  updated_at: Ts,
}).strict();

export const ReconciliationSchema = z.object({
  id: Id,
  checked_at: Ts,
  checked_on: DateStr,
  expected_paisa: PaisaStr,
  actual_paisa: PaisaStr,
  difference_paisa: PaisaStr,
  note: Text(500).nullable(),
  adjustment_transaction_id: Id.nullable(),
  tx_count_at_check: z.number().int().min(0),
  ledger_revision: PaisaStr,
  ledger_hash: Text(64),
  deleted_at: TsNull,
  created_at: Ts,
  updated_at: Ts,
}).strict();

export const AuditSchema = z.object({
  id: Id,
  entity: Text(40),
  entity_id: Id,
  action: z.enum(['create', 'update', 'delete', 'restore', 'archive', 'unarchive']),
  before_json: z.unknown().nullable(),
  after_json: z.unknown().nullable(),
  at: Ts,
}).strict();

export const BackupSchema = z.object({
  schema_version: z.number().int().min(1),
  exported_at: Ts,
  app_version: Text(40),
  timezone: Text(64),
  profile: ProfileSchema,
  envelopes: z.array(EnvelopeSchema),
  categories: z.array(CategorySchema),
  transactions: z.array(TransactionSchema),
  transaction_splits: z.array(SplitSchema),
  loans: z.array(LoanSchema),
  recurring_rules: z.array(RuleSchema),
  recurring_occurrences: z.array(OccurrenceSchema),
  reconciliations: z.array(ReconciliationSchema),
  audit_log: z.array(AuditSchema),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type BackupDoc = z.infer<typeof BackupSchema>;
export type BackupTx = z.infer<typeof TransactionSchema>;
export type BackupBody = Omit<BackupDoc, 'checksum'>;

/** Tables in FK-safe insert order (children after parents). */
export const TABLE_ORDER = [
  'categories', 'envelopes', 'loans', 'recurring_rules', 'transactions',
  'transaction_splits', 'recurring_occurrences', 'reconciliations', 'audit_log',
] as const;
export type BackupTable = (typeof TABLE_ORDER)[number];
