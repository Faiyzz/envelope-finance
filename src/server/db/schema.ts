/**
 * Drizzle schema - TD-01 §4
 * 
 * Drizzle schema mirrors the hand-written SQL migrations for typing only.
 * The authoritative schema is in migrations/0001_core.sql
 */

import { pgTable, uuid, text, bigint, timestamp, boolean, integer, pgEnum } from 'drizzle-orm/pg-core';

export const transactionTypeEnum = pgEnum('transaction_type', [
  'opening_balance',
  'income',
  'external_deposit',
  'expense',
  'external_withdrawal',
  'allocation',
  'deallocation',
  'transfer',
  'loan',
  'loan_repayment',
  'adjustment',
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  timezone: text('timezone').notNull().default('Asia/Karachi'),
  currency: text('currency').notNull().default('PKR'),
  theme: text('theme').notNull().default('system'),
  numberGrouping: text('number_grouping').notNull().default('western'),
  weekStart: integer('week_start').notNull().default(1),
  hideBalancesDefault: boolean('hide_balances_default').notNull().default(false),
  onboardingCompletedAt: timestamp('onboarding_completed_at'),
  ledgerRevision: bigint('ledger_revision', { mode: 'bigint' }).notNull().default(0n),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until'),
  passwordChangedAt: timestamp('password_changed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const envelopes = pgTable('envelopes', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon').notNull().default('💼'),
  color: text('color'),
  ownerType: text('owner_type').notNull().default('mine'),
  ownerName: text('owner_name'),
  kind: text('kind').notNull().default('standard'),
  goalAmountPaisa: bigint('goal_amount_paisa', { mode: 'bigint' }),
  status: text('status').notNull().default('active'),
  archivedAt: timestamp('archived_at'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  groupName: text('group_name'),
  status: text('status').notNull().default('active'),
  isSystem: boolean('is_system').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: transactionTypeEnum('type').notNull(),
  amountPaisa: bigint('amount_paisa', { mode: 'bigint' }).notNull(),
  occurredOn: text('occurred_on').notNull(),
  occurredAt: text('occurred_at').notNull().default('12:00:00'),
  envelopeId: uuid('envelope_id').references(() => envelopes.id, { onDelete: 'no action' }),
  counterpartEnvelopeId: uuid('counterpart_envelope_id').references(() => envelopes.id, { onDelete: 'no action' }),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'no action' }),
  note: text('note'),
  loanId: uuid('loan_id'),
  recurringId: uuid('recurring_id'),
  isGenerated: boolean('is_generated').notNull().default(false),
  parentTransactionId: uuid('parent_transaction_id'), // self-FK lives in the SQL migration
  deletedAt: timestamp('deleted_at'),
  deletedBy: uuid('deleted_by').references(() => users.id),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const transactionSplits = pgTable('transaction_splits', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  transactionId: uuid('transaction_id').notNull().references(() => transactions.id, { onDelete: 'cascade' }),
  envelopeId: uuid('envelope_id').notNull().references(() => envelopes.id),
  amountPaisa: bigint('amount_paisa', { mode: 'bigint' }).notNull(),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: uuid('key').notNull(),
  action: text('action').notNull(),
  requestHash: text('request_hash').notNull(),
  response: text('response').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at').notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id').notNull(),
  action: text('action').notNull(),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  at: timestamp('at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  userAgent: text('user_agent'),
  ipHash: text('ip_hash'),
});

export const loginAttempts = pgTable('login_attempts', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  email: text('email').notNull(),
  ipHash: text('ip_hash').notNull(),
  succeeded: boolean('succeeded').notNull(),
  at: timestamp('at').notNull().defaultNow(),
});

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
