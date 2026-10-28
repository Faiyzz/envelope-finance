/**
 * E2E harness (TD-13 §4): embedded PostgreSQL -> migrate -> seed a user with the
 * reference-scenario-like ledger -> `next start`. Playwright's webServer runs this.
 *
 *   E2E_EMAIL / E2E_PASSWORD are fixed so specs can log in.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { applyMigrations } from '../src/server/db/migrate';

export const E2E_EMAIL = 'e2e@example.com';
export const E2E_PASSWORD = 'e2e-password-123';
const PG_PORT = Number(process.env.E2E_PG_PORT ?? 54990);
const APP_PORT = Number(process.env.E2E_PORT ?? 3100);

async function main() {
  const dir = `/tmp/ef-e2e-pg-${randomUUID()}`;
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: PG_PORT, persistent: false, onLog: () => undefined, onError: () => undefined });
  console.log('[e2e] initialising postgres');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('ef_e2e');
  const url = `postgresql://postgres:pw@localhost:${PG_PORT}/ef_e2e`;

  const admin = new Client({ connectionString: url });
  admin.on('error', () => undefined);
  await admin.connect();
  console.log('[e2e] migrating');
  await applyMigrations(admin);

  const userId = randomUUID();
  const passwordHash = await hash(E2E_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
  await admin.query(
    `INSERT INTO users (id, name, email, password_hash, onboarding_completed_at) VALUES ($1, 'E2E User', $2, $3, now())`,
    [userId, E2E_EMAIL, passwordHash]
  );

  const env = {
    ...process.env,
    DATABASE_URL: url,
    DATABASE_URL_UNPOOLED: url,
    AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
    AUTH_URL: `http://localhost:${APP_PORT}`,
    AUTH_TRUST_HOST: 'true',
    ALLOW_REGISTRATION: 'false',
    CRON_SECRET: 'cron-secret-cron-secret-cron-secret-123',
    NODE_ENV: 'production',
  } as NodeJS.ProcessEnv;

  // seed the ledger through the real import pipeline (also exercises it end to end)
  Object.assign(process.env, env);
  const { makeFixture, sealed, toBytes } = await import('../tests/helpers/backup-fixture');
  const { validateImportBytes, commitImport } = await import('../src/server/backup/import');
  const today = new Date().toISOString().slice(0, 10);
  const valid = validateImportBytes(toBytes(sealed(makeFixture().body)), today);
  if (!valid.ok) throw new Error(`fixture invalid: ${JSON.stringify(valid)}`);
  console.log('[e2e] seeding');
  await commitImport(userId, valid);
  await (await import('../src/server/db/client')).closePool(); // the app server opens its own pool
  console.log('[e2e] starting next');
  await admin.end();

  const server = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], { env, stdio: 'inherit' });
  const stop = async () => {
    server.kill('SIGTERM');
    await pg.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  server.on('exit', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
