-- TD-01 §4.1: Triggers
-- Migration 0002_core_triggers.sql

-- (a) updated_at maintenance for every table that has it
CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_envelopes_updated_at BEFORE UPDATE ON envelopes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- (b) transactions: version bump on UPDATE (optimistic concurrency, FR-CON-03)
CREATE FUNCTION tx_bump_version() RETURNS trigger AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tx_bump_version BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION tx_bump_version();

-- (c) transactions: ownership and category-kind rules, checked on INSERT/UPDATE
CREATE FUNCTION tx_check_refs() RETURNS trigger AS $$
DECLARE
  o_from TEXT;
  o_to TEXT;
  ck TEXT;
BEGIN
  IF NEW.envelope_id IS NOT NULL THEN
    SELECT owner_type INTO o_from FROM envelopes WHERE id = NEW.envelope_id;
  END IF;
  
  IF NEW.counterpart_envelope_id IS NOT NULL THEN
    SELECT owner_type INTO o_to FROM envelopes WHERE id = NEW.counterpart_envelope_id;
  END IF;
  
  IF NEW.type IN ('external_deposit','external_withdrawal') AND o_from <> 'other' THEN
    RAISE EXCEPTION 'external_* requires an other-owned envelope' USING ERRCODE='23514';
  END IF;
  
  IF NEW.type IN ('transfer','loan','loan_repayment') AND (o_from <> 'mine' OR o_to <> 'mine') THEN
    RAISE EXCEPTION 'transfer/loan requires mine envelopes' USING ERRCODE='23514';
  END IF;
  
  IF NEW.category_id IS NOT NULL THEN
    SELECT kind INTO ck FROM categories WHERE id = NEW.category_id;
    IF (NEW.type = 'expense' AND ck <> 'expense') OR (NEW.type = 'income' AND ck <> 'income') THEN
      RAISE EXCEPTION 'category kind mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tx_check_refs BEFORE INSERT OR UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION tx_check_refs();

-- (d) envelopes: owner_type immutable once referenced (URD §5)
CREATE FUNCTION env_owner_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.owner_type <> OLD.owner_type AND (
       EXISTS (SELECT 1 FROM transactions WHERE envelope_id = OLD.id OR counterpart_envelope_id = OLD.id)
    OR EXISTS (SELECT 1 FROM transaction_splits WHERE envelope_id = OLD.id)) THEN
    RAISE EXCEPTION 'owner_type is immutable once the envelope has transactions' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_env_owner_immutable BEFORE UPDATE ON envelopes
  FOR EACH ROW EXECUTE FUNCTION env_owner_immutable();

-- (e) splits: Σ splits ≤ income amount, and parent must be an income (deferred so multi-row insert works)
CREATE FUNCTION split_check() RETURNS trigger AS $$
DECLARE
  t RECORD;
  s BIGINT;
BEGIN
  SELECT type, amount_paisa INTO t FROM transactions 
  WHERE id = COALESCE(NEW.transaction_id, OLD.transaction_id);
  
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  
  SELECT COALESCE(SUM(amount_paisa),0) INTO s FROM transaction_splits 
  WHERE transaction_id = COALESCE(NEW.transaction_id, OLD.transaction_id);
  
  IF t.type <> 'income' AND s > 0 THEN
    RAISE EXCEPTION 'splits only on income' USING ERRCODE='23514';
  END IF;
  
  IF s > t.amount_paisa THEN
    RAISE EXCEPTION 'splits exceed income amount' USING ERRCODE='23514';
  END IF;
  
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_split_check AFTER INSERT OR UPDATE OR DELETE ON transaction_splits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION split_check();

-- Re-run split check when income amount is edited
CREATE FUNCTION tx_split_check_on_amount() RETURNS trigger AS $$
BEGIN
  PERFORM split_check();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_tx_split_check AFTER UPDATE OF amount_paisa ON transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tx_split_check_on_amount();
