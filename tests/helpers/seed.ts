import { randomUUID } from 'crypto';
import type { Client } from 'pg';

export const uid = () => randomUUID();

export async function createUser(db: Client, email = `u${Math.random().toString(36).slice(2)}@example.com`): Promise<string> {
  const id = uid();
  await db.query(`INSERT INTO users (id, name, email, password_hash) VALUES ($1, 'Test', $2, 'x')`, [id, email]);
  return id;
}

export async function createEnvelope(db: Client, userId: string, name: string, owner: 'mine' | 'other' = 'mine'): Promise<string> {
  const id = uid();
  await db.query(
    `INSERT INTO envelopes (id, user_id, name, owner_type, owner_name) VALUES ($1,$2,$3,$4,$5)`,
    [id, userId, name, owner, owner === 'other' ? name : null]
  );
  return id;
}

export async function createCategory(db: Client, userId: string, kind: 'expense' | 'income', name = 'Uncategorized', system = true): Promise<string> {
  const id = uid();
  await db.query(`INSERT INTO categories (id, user_id, name, kind, is_system) VALUES ($1,$2,$3,$4,$5)`, [id, userId, name, kind, system]);
  return id;
}

export interface TxInput {
  id?: string;
  userId: string;
  type: string;
  amount: bigint;
  on?: string;
  at?: string;
  envelopeId?: string | null;
  counterpartId?: string | null;
  categoryId?: string | null;
  loanId?: string | null;
  createdAt?: string;
}

export async function insertTx(db: Client, t: TxInput): Promise<string> {
  const id = t.id ?? uid();
  await db.query(
    `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, counterpart_envelope_id, category_id, loan_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, clock_timestamp()))`,
    [id, t.userId, t.type, t.amount.toString(), t.on ?? '2026-10-01', t.at ?? '12:00:00', t.envelopeId ?? null, t.counterpartId ?? null, t.categoryId ?? null, t.loanId ?? null, t.createdAt ?? null]
  );
  return id;
}

export async function insertSplit(db: Client, userId: string, txId: string, envelopeId: string, amount: bigint) {
  await db.query(`INSERT INTO transaction_splits (id, user_id, transaction_id, envelope_id, amount_paisa) VALUES ($1,$2,$3,$4,$5)`, [uid(), userId, txId, envelopeId, amount.toString()]);
}

export async function totals(db: Client, userId: string) {
  const t = (await db.query(`SELECT total_paisa::text AS t, unallocated_explicit_paisa::text AS u, envelopes_paisa::text AS e, mine_paisa::text AS m, other_paisa::text AS o FROM ledger_totals WHERE user_id = $1`, [userId])).rows[0];
  const total = BigInt(t.t), env = BigInt(t.e);
  return { total, unallocated: total - env, unallocatedExplicit: BigInt(t.u), envelopes: env, mine: BigInt(t.m), other: BigInt(t.o) };
}

export async function envBalances(db: Client, userId: string): Promise<Map<string, bigint>> {
  const rows = (await db.query(`SELECT envelope_id, balance_paisa::text AS b FROM envelope_balances WHERE user_id = $1`, [userId])).rows;
  return new Map(rows.map((r) => [r.envelope_id as string, BigInt(r.b)]));
}
