-- TD-00 §7 / TD-01 §10: support for the nightly job dispatcher.

CREATE TABLE integrity_runs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok BOOLEAN NOT NULL,
  findings JSONB NOT NULL
);
CREATE INDEX ix_integrity_runs_user ON integrity_runs (user_id, at DESC);
ALTER TABLE integrity_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrity_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON integrity_runs
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);

-- The cron dispatcher must enumerate users although RLS hides every other row.
-- Returns ids only (no personal data).
CREATE OR REPLACE FUNCTION job_list_user_ids() RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT id FROM users $$;
REVOKE ALL ON FUNCTION job_list_user_ids() FROM PUBLIC;

-- Auth housekeeping rows are not user-scoped by RLS (login_attempts has no user_id); done as definer.
CREATE OR REPLACE FUNCTION job_cleanup_auth() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0; c integer;
BEGIN
  DELETE FROM sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '30 days'; GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM login_attempts WHERE at < now() - interval '2 days'; GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '1 day' OR used_at IS NOT NULL; GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION job_cleanup_auth() FROM PUBLIC;

CREATE OR REPLACE FUNCTION job_cleanup_idempotency() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c integer;
BEGIN
  DELETE FROM idempotency_keys WHERE expires_at < now(); GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END $$;
REVOKE ALL ON FUNCTION job_cleanup_idempotency() FROM PUBLIC;

-- Hard-delete transactions soft-deleted more than 30 days ago (TD-05 §7).
CREATE OR REPLACE FUNCTION job_purge_deleted() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c integer;
BEGIN
  DELETE FROM transactions WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'; GET DIAGNOSTICS c = ROW_COUNT; RETURN c;
END $$;
REVOKE ALL ON FUNCTION job_purge_deleted() FROM PUBLIC;
