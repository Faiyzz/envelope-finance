-- TD-07 §2: Recurring rules schema
-- Migration 0009_recurring.sql

CREATE TYPE frequency_type AS ENUM ('weekly','monthly','yearly','custom_days');

CREATE TABLE recurring_rules (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  type TEXT NOT NULL CHECK (type IN ('expense','income')),
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa BETWEEN 1 AND 99999999999),
  envelope_id UUID,
  category_id UUID NOT NULL,
  split_template JSONB,
  frequency frequency_type NOT NULL,
  interval_n INTEGER NOT NULL DEFAULT 1 CHECK (interval_n BETWEEN 1 AND 366),
  anchor_day SMALLINT CHECK (anchor_day BETWEEN 1 AND 31),
  start_date DATE NOT NULL,
  end_date DATE,
  max_occurrences INTEGER CHECK (max_occurrences IS NULL OR max_occurrences > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','ended')),
  pause_reason TEXT CHECK (pause_reason IN ('user','envelope_archived')),
  is_committee BOOLEAN NOT NULL DEFAULT FALSE,
  next_slot_index INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, envelope_id) REFERENCES envelopes (user_id, id),
  FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id),
  CHECK ((type = 'expense') = (envelope_id IS NOT NULL)),
  CHECK (type = 'income' OR split_template IS NULL),
  CHECK (NOT is_committee OR (type = 'expense' AND max_occurrences IS NOT NULL))
);

CREATE INDEX ix_rule_user_status ON recurring_rules (user_id, status);

CREATE TABLE recurring_occurrences (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL,
  slot_index INTEGER NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generated','skipped','needs_attention')),
  transaction_id UUID,
  note TEXT CHECK (char_length(note) <= 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, rule_id) REFERENCES recurring_rules (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, transaction_id) REFERENCES transactions (user_id, id) ON DELETE SET NULL,
  UNIQUE (rule_id, due_date),
  UNIQUE (rule_id, slot_index),
  CHECK (status <> 'generated' OR transaction_id IS NOT NULL)
);

ALTER TABLE transactions 
  ADD CONSTRAINT fk_tx_recurring 
  FOREIGN KEY (user_id, recurring_id) REFERENCES recurring_rules (user_id, id) 
  ON DELETE SET NULL;
