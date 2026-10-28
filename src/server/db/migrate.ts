/**
 * Forward-only SQL migration runner - TD-00 §10.
 *
 * The migrations are hand-written SQL (views, triggers, RLS), so there is no
 * drizzle journal; this applies `migrations/*.sql` in filename order, each in
 * its own transaction, recording them in `schema_migrations`. Applied files
 * are checksummed: editing an applied migration is an error ("never edit an
 * applied migration").
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

interface Client {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(path.join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export async function applyMigrations(client: Client, dir = MIGRATIONS_DIR, log: (m: string) => void = () => undefined): Promise<string[]> {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await client.query("SELECT pg_advisory_lock(hashtextextended('ef-migrations', 0))");
  const applied: string[] = [];
  try {
    const done = new Map((await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [String(r.name), String(r.checksum)]));
    for (const m of readMigrations(dir)) {
      const prev = done.get(m.name);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`Migration ${m.name} was edited after being applied. Fix forward with a new migration.`);
        continue;
      }
      log(`applying ${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      applied.push(m.name);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('ef-migrations', 0))");
  }
  return applied;
}
