/**
 * Synthetic 50k-row dataset for local/CI performance runs (TD-12 §8.3).
 *   DATABASE_URL=... npm run seed:perf
 * Creates perf@example.com with 3 envelopes and 50,000 expenses over ~4 years.
 */
import { Client } from 'pg';
import { randomUUID } from 'crypto';

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL.');
  const db = new Client({ connectionString: url });
  await db.connect();
  const rows = Number(process.env.PERF_ROWS ?? 50_000);
  const user = randomUUID();
  await db.query(`INSERT INTO users (id, name, email, password_hash, onboarding_completed_at) VALUES ($1,'Perf','perf-${user.slice(0, 6)}@example.com','!', now())`, [user]);
  const envs: string[] = [];
  for (const [i, name] of ['Home', 'Personal', 'Savings'].entries()) {
    const id = randomUUID();
    envs.push(id);
    await db.query(`INSERT INTO envelopes (id, user_id, name, sort_order) VALUES ($1,$2,$3,$4)`, [id, user, name, i]);
  }
  const cat = randomUUID();
  await db.query(`INSERT INTO categories (id, user_id, name, kind, is_system) VALUES ($1,$2,'Uncategorized','expense', true)`, [cat, user]);
  await db.query(`INSERT INTO categories (id, user_id, name, kind, is_system) VALUES ($1,$2,'Uncategorized','income', true)`, [randomUUID(), user]);
  await db.query(`INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at) VALUES (gen_random_uuid(), $1, 'opening_balance', 90000000000, '2020-01-01', '00:00:00')`, [user]);
  for (const [i, e] of envs.entries()) {
    await db.query(`INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id) VALUES (gen_random_uuid(), $1,'allocation', 30000000000, '2020-01-01', $3, $2)`, [user, e, `00:00:0${i + 1}`]);
  }
  await db.query(
    `INSERT INTO transactions (id, user_id, type, amount_paisa, occurred_on, occurred_at, envelope_id, category_id, created_at)
     SELECT gen_random_uuid(), $1, 'expense', 100 + (g % 900), DATE '2021-01-01' + (g % 1500), TIME '09:00:00' + (g % 600) * interval '1 second',
            ($2::uuid[])[1 + g % 3], $3, now() - (g || ' seconds')::interval
     FROM generate_series(1, $4::int) g`,
    [user, envs, cat, rows]
  );
  await db.query('ANALYZE');
  console.log(`Seeded ${rows} expenses for user ${user}`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
