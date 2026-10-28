/**
 * npm run db:seed -- <email> <password> [name]
 * Migrates the database and creates (or resets the password of) a user with default categories.
 */
import { Client } from 'pg';
import { uuidv7 } from 'uuidv7';
import { applyMigrations } from '../db/migrate';
import { hashPassword, normalisePassword } from './password';
import { getPool, closePool } from '../db/client';
import { seedDefaultCategories } from '../actions/categories';

async function main() {
  const [email, password, name = 'Faiyz'] = process.argv.slice(2);
  if (!email || !password) throw new Error('Usage: npm run db:seed -- <email> <password> [name]');

  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  const client = new Client({ connectionString: url });
  await client.connect();
  await applyMigrations(client);
  await client.end();

  const pool = getPool();
  const hash = await hashPassword(normalisePassword(password));
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  let userId: string;
  if (existing.rows[0]) {
    userId = existing.rows[0].id;
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
    console.log(`Updated password for ${email}`);
  } else {
    userId = uuidv7();
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, timezone, currency, theme, number_grouping, week_start)
       VALUES ($1,$2,$3,$4,'Asia/Karachi','PKR','system','western',1)`,
      [userId, name, email.toLowerCase(), hash]
    );
    console.log(`Created ${email}`);
  }
  await seedDefaultCategories(userId, pool);
  await closePool();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
