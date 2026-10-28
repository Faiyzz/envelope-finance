import type { Config } from 'drizzle-kit';

// Read env directly: drizzle-kit must not require the full app env (AUTH_SECRET etc.)
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '';

export default {
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
} satisfies Config;
