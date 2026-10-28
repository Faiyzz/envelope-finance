-- TD-04 §2: Envelope stats view
-- Migration 0006_envelope_stats.sql

CREATE VIEW envelope_stats AS
SELECT e.user_id, e.id AS envelope_id,
  eb.balance_paisa,
  (SELECT count(*) FROM transactions t 
   WHERE t.user_id = e.user_id AND t.deleted_at IS NULL
   AND (t.envelope_id = e.id OR t.counterpart_envelope_id = e.id)) AS tx_count
FROM envelopes e 
JOIN envelope_balances eb ON eb.envelope_id = e.id;
