-- TD-06 §1.1: Loans schema
-- Migration 0008_loans.sql

CREATE TABLE loans (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lender_envelope_id UUID NOT NULL,
  borrower_envelope_id UUID NOT NULL,
  note TEXT CHECK (char_length(note) <= 500),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, lender_envelope_id) REFERENCES envelopes (user_id, id),
  FOREIGN KEY (user_id, borrower_envelope_id) REFERENCES envelopes (user_id, id),
  CHECK (lender_envelope_id <> borrower_envelope_id)
);

ALTER TABLE transactions
  ADD CONSTRAINT fk_tx_loan FOREIGN KEY (user_id, loan_id) REFERENCES loans (user_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- Exactly one live 'loan' tx per loan
CREATE UNIQUE INDEX uq_loan_one_origin ON transactions (loan_id) WHERE type = 'loan' AND deleted_at IS NULL;

-- loan_state view - TD-06 §1.2
CREATE VIEW loan_state AS
SELECT l.user_id, l.id AS loan_id, l.lender_envelope_id, l.borrower_envelope_id, l.note,
       o.id AS origin_tx_id, o.amount_paisa AS original_paisa, o.occurred_on AS loan_date,
       COALESCE(r.repaid, 0)::bigint AS repaid_paisa,
       (o.amount_paisa - COALESCE(r.repaid, 0))::bigint AS remaining_paisa,
       CASE WHEN o.amount_paisa - COALESCE(r.repaid, 0) = 0 THEN 'paid' ELSE 'active' END AS status,
       r.last_repaid_on AS paid_on
FROM loans l
JOIN transactions o ON o.loan_id = l.id AND o.type = 'loan' AND o.deleted_at IS NULL
LEFT JOIN LATERAL (SELECT SUM(amount_paisa) AS repaid, MAX(occurred_on) AS last_repaid_on
                   FROM transactions x WHERE x.loan_id = l.id AND x.type = 'loan_repayment' AND x.deleted_at IS NULL) r ON TRUE
WHERE l.deleted_at IS NULL;

-- envelope_loan_totals view - TD-06 §1.2
CREATE VIEW envelope_loan_totals AS
SELECT user_id, borrower_envelope_id AS envelope_id, SUM(remaining_paisa) AS borrowed_paisa, 0::bigint AS loaned_out_paisa
  FROM loan_state WHERE status='active' GROUP BY 1,2
UNION ALL
SELECT user_id, lender_envelope_id, 0, SUM(remaining_paisa) FROM loan_state WHERE status='active' GROUP BY 1,2;
