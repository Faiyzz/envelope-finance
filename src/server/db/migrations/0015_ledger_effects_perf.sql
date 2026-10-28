-- Performance fix-forward for 0003. The LATERAL VALUES expansion costs ~11 µs per
-- transaction (the VALUES node is re-executed per row), i.e. ~300 ms for a 25k-row
-- ledger. The same posting table is expressed here as plain UNION ALL branches that
-- the planner can scan with the per-user index. Columns and semantics are unchanged;
-- tests/integration/ledger.test.ts (SQL vs TS differential) guards equivalence.
CREATE OR REPLACE VIEW ledger_effects AS
-- TOTAL
SELECT t.user_id, t.id AS transaction_id, t.type AS tx_type, t.occurred_on, t.occurred_at, t.created_at,
       'TOTAL'::text AS account, NULL::uuid AS envelope_id,
       CASE WHEN t.type IN ('expense','external_withdrawal') THEN -t.amount_paisa ELSE t.amount_paisa END AS delta
FROM transactions t
WHERE t.deleted_at IS NULL
  AND t.type IN ('opening_balance','income','external_deposit','adjustment','expense','external_withdrawal')
  AND t.amount_paisa <> 0

UNION ALL
-- UNALLOCATED
SELECT t.user_id, t.id, t.type, t.occurred_on, t.occurred_at, t.created_at,
       'UNALLOCATED', NULL::uuid,
       CASE t.type
         WHEN 'allocation' THEN -t.amount_paisa
         WHEN 'income' THEN t.amount_paisa - COALESCE(sp.split_total, 0)
         ELSE t.amount_paisa            -- opening_balance, deallocation, adjustment(envelope NULL)
       END
FROM transactions t
LEFT JOIN LATERAL (SELECT SUM(s.amount_paisa) AS split_total
                   FROM transaction_splits s
                   WHERE t.type = 'income' AND s.transaction_id = t.id) sp ON TRUE
WHERE t.deleted_at IS NULL
  AND (t.type IN ('opening_balance','income','deallocation','allocation')
       OR (t.type = 'adjustment' AND t.envelope_id IS NULL))
  AND (t.type <> 'income' OR t.amount_paisa - COALESCE(sp.split_total, 0) <> 0)
  AND t.amount_paisa <> 0

UNION ALL
-- ENVELOPE: source / single envelope
SELECT t.user_id, t.id, t.type, t.occurred_on, t.occurred_at, t.created_at,
       'ENVELOPE', t.envelope_id,
       CASE WHEN t.type IN ('expense','external_withdrawal','deallocation','transfer','loan','loan_repayment')
            THEN -t.amount_paisa ELSE t.amount_paisa END
FROM transactions t
WHERE t.deleted_at IS NULL AND t.envelope_id IS NOT NULL
  AND t.type IN ('expense','external_withdrawal','deallocation','transfer','loan','loan_repayment','external_deposit','allocation','adjustment')
  AND t.amount_paisa <> 0

UNION ALL
-- ENVELOPE: destination
SELECT t.user_id, t.id, t.type, t.occurred_on, t.occurred_at, t.created_at,
       'ENVELOPE', t.counterpart_envelope_id, t.amount_paisa
FROM transactions t
WHERE t.deleted_at IS NULL AND t.counterpart_envelope_id IS NOT NULL
  AND t.type IN ('transfer','loan','loan_repayment') AND t.amount_paisa <> 0

UNION ALL
-- ENVELOPE: income splits
SELECT s.user_id, s.transaction_id, t.type, t.occurred_on, t.occurred_at, t.created_at,
       'ENVELOPE', s.envelope_id, s.amount_paisa
FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
WHERE t.deleted_at IS NULL;
