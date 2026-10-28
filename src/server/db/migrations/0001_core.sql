-- TD-01 §4: Core schema
-- Migration 0001_core.sql

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
  currency TEXT NOT NULL DEFAULT 'PKR' CHECK (currency = 'PKR'),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  number_grouping TEXT NOT NULL DEFAULT 'western' CHECK (number_grouping IN ('western','lakh')),
  week_start SMALLINT NOT NULL DEFAULT 1 CHECK (week_start IN (0,1,6)),      -- 1=Mon
  hide_balances_default BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_completed_at TIMESTAMPTZ,
  ledger_revision BIGINT NOT NULL DEFAULT 0,                                   -- TD-D5
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE envelopes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description TEXT CHECK (char_length(description) <= 300),
  icon TEXT NOT NULL DEFAULT '💼',
  color TEXT,                                                                    -- design token name
  owner_type TEXT NOT NULL DEFAULT 'mine' CHECK (owner_type IN ('mine','other')),
  owner_name TEXT CHECK (char_length(owner_name) <= 60),
  kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','savings')),
  goal_amount_paisa BIGINT CHECK (goal_amount_paisa IS NULL OR goal_amount_paisa > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CONSTRAINT env_owner_name CHECK (owner_type <> 'other' OR (owner_name IS NOT NULL AND btrim(owner_name) <> '')),
  CONSTRAINT env_archived CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_env_active_name ON envelopes (user_id, lower(btrim(name))) WHERE status = 'active';
CREATE INDEX ix_env_user_status ON envelopes (user_id, status, sort_order);

CREATE TABLE categories (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
  group_name TEXT CHECK (group_name IN ('home','personal','other')),            -- "group" is reserved
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CONSTRAINT cat_system_active CHECK (NOT is_system OR status = 'active')
);
CREATE UNIQUE INDEX uq_cat_name ON categories (user_id, kind, lower(btrim(name)));
CREATE UNIQUE INDEX uq_cat_system ON categories (user_id, kind) WHERE is_system;

CREATE TYPE transaction_type AS ENUM (
  'opening_balance','income','external_deposit','expense','external_withdrawal',
  'allocation','deallocation','transfer','loan','loan_repayment','adjustment');

CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type transaction_type NOT NULL,
  amount_paisa BIGINT NOT NULL,
  occurred_on DATE NOT NULL CHECK (occurred_on >= DATE '2000-01-01'),
  occurred_at TIME NOT NULL DEFAULT TIME '12:00:00',
  envelope_id UUID,                   -- SOURCE ("from") for movement types; the envelope for single-envelope types
  counterpart_envelope_id UUID,       -- DESTINATION ("to") for transfer / loan / loan_repayment
  category_id UUID,
  note TEXT CHECK (char_length(note) <= 500),
  loan_id UUID,                       -- FK added in TD-06 migration (DEFERRABLE INITIALLY DEFERRED)
  recurring_id UUID,                  -- FK added in TD-07 migration
  is_generated BOOLEAN NOT NULL DEFAULT FALSE,
  parent_transaction_id UUID,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, envelope_id)             REFERENCES envelopes (user_id, id),
  FOREIGN KEY (user_id, counterpart_envelope_id) REFERENCES envelopes (user_id, id),
  FOREIGN KEY (user_id, category_id)             REFERENCES categories (user_id, id),
  FOREIGN KEY (user_id, parent_transaction_id)   REFERENCES transactions (user_id, id),
  CONSTRAINT tx_deleted_pair CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  CONSTRAINT tx_amount CHECK (
    CASE type
      WHEN 'adjustment'      THEN amount_paisa <> 0 AND abs(amount_paisa) <= 99999999999
      WHEN 'opening_balance' THEN amount_paisa BETWEEN 0 AND 99999999999     -- TD-D4
      ELSE amount_paisa BETWEEN 1 AND 99999999999
    END),
  CONSTRAINT tx_shape CHECK (
    CASE
      WHEN type = 'opening_balance'
        THEN envelope_id IS NULL AND counterpart_envelope_id IS NULL AND category_id IS NULL AND loan_id IS NULL
      WHEN type = 'income'
        THEN envelope_id IS NULL AND counterpart_envelope_id IS NULL AND category_id IS NOT NULL AND loan_id IS NULL
      WHEN type = 'expense'
        THEN envelope_id IS NOT NULL AND counterpart_envelope_id IS NULL AND category_id IS NOT NULL AND loan_id IS NULL
      WHEN type IN ('external_deposit','external_withdrawal','allocation','deallocation')
        THEN envelope_id IS NOT NULL AND counterpart_envelope_id IS NULL AND category_id IS NULL AND loan_id IS NULL
      WHEN type = 'transfer'
        THEN envelope_id IS NOT NULL AND counterpart_envelope_id IS NOT NULL
             AND envelope_id <> counterpart_envelope_id AND category_id IS NULL AND loan_id IS NULL
      WHEN type IN ('loan','loan_repayment')
        THEN envelope_id IS NOT NULL AND counterpart_envelope_id IS NOT NULL
             AND envelope_id <> counterpart_envelope_id AND category_id IS NULL AND loan_id IS NOT NULL
      WHEN type = 'adjustment'                       -- envelope_id NULL ⇒ target is Unallocated
        THEN counterpart_envelope_id IS NULL AND category_id IS NULL AND loan_id IS NULL
    END)
);
CREATE UNIQUE INDEX uq_tx_opening ON transactions (user_id) WHERE type = 'opening_balance' AND deleted_at IS NULL;
CREATE INDEX ix_tx_user_time  ON transactions (user_id, occurred_on DESC, occurred_at DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_tx_env        ON transactions (user_id, envelope_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_tx_cp_env     ON transactions (user_id, counterpart_envelope_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_tx_cat        ON transactions (user_id, category_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_tx_type       ON transactions (user_id, type) WHERE deleted_at IS NULL;
CREATE INDEX ix_tx_loan       ON transactions (user_id, loan_id) WHERE loan_id IS NOT NULL;
CREATE INDEX ix_tx_recurring  ON transactions (user_id, recurring_id) WHERE recurring_id IS NOT NULL;
CREATE INDEX ix_tx_deleted    ON transactions (user_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX ix_tx_note_trgm  ON transactions USING gin (note gin_trgm_ops);

CREATE TABLE transaction_splits (                  -- income only
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL,
  envelope_id UUID NOT NULL,
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa BETWEEN 1 AND 99999999999),
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, envelope_id)    REFERENCES envelopes (user_id, id),
  UNIQUE (transaction_id, envelope_id)
);
CREATE INDEX ix_split_tx ON transaction_splits (user_id, transaction_id);
CREATE INDEX ix_split_env ON transaction_splits (user_id, envelope_id);

CREATE TABLE idempotency_keys (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key UUID NOT NULL,
  action TEXT NOT NULL,
  request_hash TEXT NOT NULL,                       -- sha256 of canonical input JSON
  response JSONB NOT NULL,                          -- ActionResult with money as strings
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id, key)
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,                             -- 'transaction','loan','envelope','category','recurring_rule','reconciliation'
  entity_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete','restore','archive','unarchive')),
  before_json JSONB, after_json JSONB,              -- bigint serialised as strings
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_log (user_id, entity, entity_id, at DESC);
CREATE INDEX ix_audit_user_at ON audit_log (user_id, at DESC);
