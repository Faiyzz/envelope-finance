-- TD-11 §4.1: import history (file hash for idempotency messaging, rate limiting)
CREATE TABLE import_runs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_hash TEXT NOT NULL,
  schema_version INT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  counts JSONB NOT NULL
);
CREATE INDEX ix_import_runs_user ON import_runs (user_id, imported_at DESC);

ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON import_runs
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);

-- RLS hides other users' rows from the app role, so id-collision detection for imports
-- must run as the table owner. Returns only a boolean (no data leak).
CREATE OR REPLACE FUNCTION import_id_collision(ids uuid[], uid uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM envelopes WHERE id = ANY(ids) AND user_id <> uid)
      OR EXISTS (SELECT 1 FROM categories WHERE id = ANY(ids) AND user_id <> uid)
      OR EXISTS (SELECT 1 FROM transactions WHERE id = ANY(ids) AND user_id <> uid)
      OR EXISTS (SELECT 1 FROM transaction_splits WHERE id = ANY(ids) AND user_id <> uid)
      OR EXISTS (SELECT 1 FROM loans WHERE id = ANY(ids) AND user_id <> uid)
      OR EXISTS (SELECT 1 FROM recurring_rules WHERE id = ANY(ids) AND user_id <> uid)
      OR EXISTS (SELECT 1 FROM recurring_occurrences WHERE id = ANY(ids) AND user_id <> uid)
      OR EXISTS (SELECT 1 FROM reconciliations WHERE id = ANY(ids) AND user_id <> uid)
      OR EXISTS (SELECT 1 FROM audit_log WHERE id = ANY(ids) AND user_id <> uid);
$$;
REVOKE ALL ON FUNCTION import_id_collision(uuid[], uuid) FROM PUBLIC;
