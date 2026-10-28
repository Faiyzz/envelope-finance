-- TD-01 §5: Posting model - ledger_effects view
-- Migration 0003_ledger_views.sql

CREATE VIEW ledger_effects AS
SELECT t.user_id, t.id AS transaction_id, t.type AS tx_type,
       t.occurred_on, t.occurred_at, t.created_at,
       p.account, p.envelope_id, p.delta
FROM transactions t
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(s.amount_paisa), 0) AS split_total
  FROM transaction_splits s WHERE s.transaction_id = t.id
) sp ON TRUE
CROSS JOIN LATERAL (VALUES
  ('TOTAL'::text, NULL::uuid,
     CASE t.type 
       WHEN 'opening_balance' THEN t.amount_paisa 
       WHEN 'income' THEN t.amount_paisa
       WHEN 'external_deposit' THEN t.amount_paisa 
       WHEN 'adjustment' THEN t.amount_paisa
       WHEN 'expense' THEN -t.amount_paisa 
       WHEN 'external_withdrawal' THEN -t.amount_paisa
       ELSE 0 
     END),
  ('UNALLOCATED', NULL::uuid,
     CASE 
       WHEN t.type = 'opening_balance' THEN t.amount_paisa
       WHEN t.type = 'income'          THEN t.amount_paisa - sp.split_total
       WHEN t.type = 'deallocation'    THEN t.amount_paisa
       WHEN t.type = 'allocation'      THEN -t.amount_paisa
       WHEN t.type = 'adjustment' AND t.envelope_id IS NULL THEN t.amount_paisa
       ELSE 0 
     END),
  ('ENVELOPE', t.envelope_id,
     CASE WHEN t.type IN ('expense','external_withdrawal','deallocation','transfer','loan','loan_repayment') THEN -t.amount_paisa
          WHEN t.type IN ('external_deposit','allocation','adjustment') THEN t.amount_paisa
          ELSE 0 
     END),
  ('ENVELOPE', t.counterpart_envelope_id,
     CASE WHEN t.type IN ('transfer','loan','loan_repayment') THEN t.amount_paisa ELSE 0 END)
) AS p(account, envelope_id, delta)
WHERE t.deleted_at IS NULL
  AND p.delta <> 0
  AND (p.account <> 'ENVELOPE' OR p.envelope_id IS NOT NULL)

UNION ALL                                           -- income splits
SELECT s.user_id, s.transaction_id, t.type, t.occurred_on, t.occurred_at, t.created_at,
       'ENVELOPE', s.envelope_id, s.amount_paisa
FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
WHERE t.deleted_at IS NULL;

-- TD-01 §5.1: Derived balances
CREATE VIEW envelope_balances AS                      -- one row per envelope, zero if no postings
SELECT e.user_id, e.id AS envelope_id, COALESCE(SUM(le.delta), 0)::bigint AS balance_paisa
FROM envelopes e
LEFT JOIN ledger_effects le ON le.user_id = e.user_id AND le.account = 'ENVELOPE' AND le.envelope_id = e.id
GROUP BY e.user_id, e.id;

CREATE VIEW ledger_totals AS
SELECT u.id AS user_id,
  COALESCE((SELECT SUM(delta) FROM ledger_effects WHERE user_id = u.id AND account = 'TOTAL'), 0)::bigint AS total_paisa,
  COALESCE((SELECT SUM(delta) FROM ledger_effects WHERE user_id = u.id AND account = 'UNALLOCATED'), 0)::bigint AS unallocated_explicit_paisa,
  COALESCE((SELECT SUM(balance_paisa) FROM envelope_balances WHERE user_id = u.id), 0)::bigint AS envelopes_paisa,
  COALESCE((SELECT SUM(eb.balance_paisa) FROM envelope_balances eb JOIN envelopes e ON e.id = eb.envelope_id
            WHERE e.user_id = u.id AND e.owner_type = 'mine'), 0)::bigint AS mine_paisa,
  COALESCE((SELECT SUM(eb.balance_paisa) FROM envelope_balances eb JOIN envelopes e ON e.id = eb.envelope_id
            WHERE e.user_id = u.id AND e.owner_type = 'other'), 0)::bigint AS other_paisa
FROM users u;
