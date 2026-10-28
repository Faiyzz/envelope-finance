/**
 * Test database provisioning (TD-13 §1).
 *  - TEST_DATABASE_URL set (CI service container): use it
 *  - otherwise start an embedded PostgreSQL (devDependency `embedded-postgres`)
 * Each call returns a fresh, fully migrated database.
 */

import { Client, Pool } from 'pg';
import { randomUUID } from 'crypto';
import { applyMigrations } from '@/server/db/migrate';

export interface TestDb {
  url: string;
  admin: Client; // owner connection (bypasses RLS)
  pool: Pool;
  stop: () => Promise<void>;
}

let embedded: { url: string; stop: () => Promise<void> } | null = null;

async function baseUrl(): Promise<string> {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (embedded) return embedded.url;
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = 54000 + Math.floor(Math.random() * 900);
  const dir = `/tmp/ef-pg-${randomUUID()}`;
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => undefined, onError: () => undefined });
  await pg.initialise();
  await pg.start();
  embedded = { url: `postgresql://postgres:pw@localhost:${port}/postgres`, stop: () => pg.stop() };
  return embedded.url;
}

export async function createTestDb(): Promise<TestDb> {
  const base = await baseUrl();
  const root = new Client({ connectionString: base });
  await root.connect();
  const name = `t_${randomUUID().replace(/-/g, '')}`;
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();

  const url = base.replace(/\/[^/]*$/, `/${name}`);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await applyMigrations(admin);
  const pool = new Pool({ connectionString: url, max: 10 });
  return {
    url,
    admin,
    pool,
    stop: async () => {
      await pool.end();
      await admin.end();
    },
  };
}

export async function stopEmbedded() {
  if (embedded) await embedded.stop();
  embedded = null;
}
