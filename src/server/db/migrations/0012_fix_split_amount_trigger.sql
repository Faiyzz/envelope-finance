-- Fix-forward for 0002: tx_split_check_on_amount() called the trigger function
-- split_check() with PERFORM, which PostgreSQL rejects ("trigger functions can
-- only be called as triggers") at COMMIT of any UPDATE OF amount_paisa.
-- Found by the DB-backed property test (TD-13 §2).
CREATE OR REPLACE FUNCTION tx_split_check_on_amount() RETURNS trigger AS $$
DECLARE
  s BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_paisa), 0) INTO s FROM transaction_splits WHERE transaction_id = NEW.id;
  IF s > 0 AND NEW.type <> 'income' THEN
    RAISE EXCEPTION 'splits only on income' USING ERRCODE = '23514';
  END IF;
  IF s > NEW.amount_paisa THEN
    RAISE EXCEPTION 'splits exceed income amount' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
