/**
 * Health endpoint - TD-00 §8
 * 
 * GET /api/health → {status:'ok', db:'ok'|'down', version, time}
 * Runs SELECT 1 with 1s timeout; never reveals config.
 */

import { NextResponse } from 'next/server';
import { getPool } from '@/server/db/client';
import { getEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function GET() {
  const env = getEnv();
  const pool = getPool();
  
  let dbStatus: 'ok' | 'down' = 'down';
  
  // SELECT 1 with a 1 s budget; never reveals configuration (TD-00 §8)
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000)),
    ]);
    dbStatus = 'ok';
  } catch {
    dbStatus = 'down';
  }

  return NextResponse.json({
    status: 'ok',
    db: dbStatus,
    version: env.APP_VERSION,
    time: new Date().toISOString(),
  });
}
