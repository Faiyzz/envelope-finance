/** pnpm db:migrate - applies pending SQL migrations using the UNPOOLED connection. */
import { Client } from 'pg';
import { applyMigrations } from '../src/server/db/migrate';

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL_UNPOOLED (or DATABASE_URL).');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const applied = await applyMigrations(client, undefined, (m) => console.log(m));
    console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
