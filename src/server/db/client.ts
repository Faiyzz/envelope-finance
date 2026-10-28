import { Pool as PgPool, types, type PoolConfig } from 'pg';
import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { getEnv } from '@/lib/env';

// Neon over WebSockets: interactive transactions + advisory locks work (HTTP driver cannot).
neonConfig.webSocketConstructor = ws;

// DATE columns are calendar dates (LocalDate strings), never JS Dates (IMP-005).
types.setTypeParser(1082, (v: string) => v);

/** Both pools expose the same node-postgres surface (query/connect/end). */
export type DbPool = PgPool;

let pool: DbPool | null = null;

export function getPool(): DbPool {
  if (pool) return pool;
  const env = getEnv();
  const config: PoolConfig = {
    connectionString: env.DATABASE_URL,
    max: 5, // small per-instance pool (TD-12 §8.2)
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
  pool = (env.DATABASE_URL.includes('neon.tech') ? new NeonPool(config as ConstructorParameters<typeof NeonPool>[0]) : new PgPool(config)) as unknown as DbPool;
  return pool;
}

export function getUnpooledClient(): DbPool {
  const env = getEnv();
  return new PgPool({ connectionString: env.DATABASE_URL_UNPOOLED, max: 1 });
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
