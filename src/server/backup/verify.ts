/**
 * Live timeline verifier (SQL) - TD-01 §6.2/§6.3. Runs on the caller's client,
 * so it can verify uncommitted state inside a transaction (apply -> verify ->
 * rollback on violation).
 */

export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface SqlViolation {
  kind: 'envelope' | 'unallocated' | 'loan';
  id: string | null;
  on: string;
  shortfallPaisa: string;
  /** The transaction at which the balance first went negative. */
  txId: string | null;
}

/** Verify given envelopes (or all of the user's when `envelopeIds` is null) + Unallocated + loans. */
export async function verifyTimeline(q: Queryable, userId: string, envelopeIds: string[] | null): Promise<SqlViolation | null> {
  const ids =
    envelopeIds ??
    (await q.query(`SELECT id FROM envelopes WHERE user_id = $1`, [userId])).rows.map((r) => String(r.id));

  const env = await q.query(
    `WITH running AS (
       SELECT le.account, le.envelope_id, le.transaction_id, le.occurred_on, le.occurred_at, le.created_at,
              SUM(le.delta) OVER (PARTITION BY le.account, le.envelope_id
                ORDER BY le.occurred_on, le.occurred_at, le.created_at, le.transaction_id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS bal
       FROM ledger_effects le
       WHERE le.user_id = $1 AND le.account <> 'TOTAL'
         AND (le.account = 'UNALLOCATED' OR le.envelope_id = ANY($2::uuid[])))
     SELECT account, envelope_id, transaction_id, to_char(occurred_on,'YYYY-MM-DD') AS on_date, (-bal)::text AS shortfall
     FROM running WHERE bal < 0
     ORDER BY occurred_on, occurred_at, created_at, transaction_id LIMIT 1`,
    [userId, ids]
  );
  const e = env.rows[0];
  if (e) {
    return {
      kind: e.account === 'UNALLOCATED' ? 'unallocated' : 'envelope',
      id: (e.envelope_id as string | null) ?? null,
      on: String(e.on_date),
      shortfallPaisa: String(e.shortfall),
      txId: (e.transaction_id as string | null) ?? null,
    };
  }

  const loan = await q.query(
    `WITH r AS (
       SELECT t.loan_id, t.id, t.occurred_on,
              SUM(CASE t.type WHEN 'loan' THEN t.amount_paisa ELSE -t.amount_paisa END) OVER (
                PARTITION BY t.loan_id ORDER BY t.occurred_on, t.occurred_at, t.created_at, t.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS remaining
       FROM transactions t
       WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.type IN ('loan','loan_repayment') AND t.loan_id IS NOT NULL)
     SELECT loan_id, id AS tx_id, to_char(occurred_on,'YYYY-MM-DD') AS on_date, (-remaining)::text AS shortfall
     FROM r WHERE remaining < 0 ORDER BY occurred_on LIMIT 1`,
    [userId]
  );
  const l = loan.rows[0];
  return l ? { kind: 'loan', id: String(l.loan_id), on: String(l.on_date), shortfallPaisa: String(l.shortfall), txId: (l.tx_id as string | null) ?? null } : null;
}
