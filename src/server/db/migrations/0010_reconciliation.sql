-- TD-08 §2: Reconciliation schema
-- Migration 0010_reconciliation.sql

CREATE TABLE reconciliations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_on DATE NOT NULL,
  expected_paisa BIGINT NOT NULL,
  actual_paisa BIGINT NOT NULL CHECK (actual_paisa >= 0),
  difference_paisa BIGINT NOT NULL,
  note TEXT CHECK (char_length(note) <= 500),
  adjustment_transaction_id UUID,
  tx_count_at_check INTEGER NOT NULL,
  ledger_revision BIGINT NOT NULL,
  ledger_hash TEXT NOT NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, adjustment_transaction_id) REFERENCES transactions (user_id, id) ON DELETE SET NULL,
  CONSTRAINT rec_diff CHECK (difference_paisa = actual_paisa - expected_paisa)
);

CREATE INDEX ix_rec_user_checked ON reconciliations (user_id, checked_at DESC) WHERE deleted_at IS NULL;

-- Trigger to reject UPDATE of immutable columns
CREATE OR REPLACE FUNCTION rec_prevent_immutable_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.id IS NOT NULL THEN
    IF NEW.checked_at <> OLD.checked_at OR
       NEW.checked_on <> OLD.checked_on OR
       NEW.expected_paisa <> OLD.expected_paisa OR
       NEW.actual_paisa <> OLD.actual_paisa OR
       NEW.difference_paisa <> OLD.difference_paisa OR
       NEW.adjustment_transaction_id <> OLD.adjustment_transaction_id OR
       NEW.tx_count_at_check <> OLD.tx_count_at_check OR
       NEW.ledger_revision <> OLD.ledger_revision OR
       NEW.ledger_hash <> OLD.ledger_hash THEN
      RAISE EXCEPTION 'Reconciliation records are immutable except note and soft-delete';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_rec_prevent_immutable_update
  BEFORE UPDATE ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION rec_prevent_immutable_update();
