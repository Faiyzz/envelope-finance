-- Fix-forward for 0003/0006: ledger_totals and envelope_stats joined the grouped
-- envelope_balances view WITHOUT a user_id condition, so a `WHERE user_id = $1` on the
-- outer query could not be pushed into the aggregate and every query scanned every
-- user's ledger (~2 s at 50k rows; found by the TD-12 §8.2 EXPLAIN test).
--
-- ledger_totals is now ONE pass over the user's postings; envelope_stats joins on
-- (user_id, envelope_id). Column names and meaning are unchanged.

CREATE OR REPLACE VIEW ledger_totals AS
SELECT u.id AS user_id,
       COALESCE(a.total, 0)::bigint                AS total_paisa,
       COALESCE(a.unalloc, 0)::bigint              AS unallocated_explicit_paisa,
       COALESCE(a.env, 0)::bigint                  AS envelopes_paisa,
       COALESCE(a.mine, 0)::bigint                 AS mine_paisa,
       COALESCE(a.other, 0)::bigint                AS other_paisa
FROM users u
LEFT JOIN LATERAL (
  SELECT SUM(le.delta) FILTER (WHERE le.account = 'TOTAL')       AS total,
         SUM(le.delta) FILTER (WHERE le.account = 'UNALLOCATED') AS unalloc,
         SUM(le.delta) FILTER (WHERE le.account = 'ENVELOPE')    AS env,
         SUM(le.delta) FILTER (WHERE le.account = 'ENVELOPE' AND e.owner_type = 'mine')  AS mine,
         SUM(le.delta) FILTER (WHERE le.account = 'ENVELOPE' AND e.owner_type = 'other') AS other
  FROM ledger_effects le
  LEFT JOIN envelopes e ON e.id = le.envelope_id AND e.user_id = le.user_id
  WHERE le.user_id = u.id
) a ON TRUE;

CREATE OR REPLACE VIEW envelope_stats AS
SELECT e.user_id, e.id AS envelope_id,
       eb.balance_paisa,
       (SELECT count(*) FROM transactions t
         WHERE t.user_id = e.user_id AND t.deleted_at IS NULL
           AND (t.envelope_id = e.id OR t.counterpart_envelope_id = e.id)) AS tx_count
FROM envelopes e
JOIN envelope_balances eb ON eb.user_id = e.user_id AND eb.envelope_id = e.id;
