/**
 * Cron dispatcher route - TD-00 §7
 * 
 * Vercel cron issues GET with Authorization: Bearer $CRON_SECRET
 * Single dispatcher runs all tasks idempotently.
 * Schedule: 5 19 * * * (19:05 UTC = 00:05 Asia/Karachi)
 */

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

import { tasks } from '@/server/jobs/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const env = getEnv();
  const authHeader = request.headers.get('authorization');
  
  // Verify bearer token with constant-time compare
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  const token = authHeader.slice(7);
  const expected = env.CRON_SECRET;
  
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: Record<string, { ok: boolean; ms: number; count?: number }> = {};
  
  for (const [taskName, taskFn] of Object.entries(tasks)) {
    const start = Date.now();
    try {
      const result = await taskFn();
      results[taskName] = {
        ok: true,
        ms: Date.now() - start,
        count: result.count,
      };
      logger.info({ task: taskName, ms: Date.now() - start, count: result.count }, 'Cron task completed');
    } catch (error) {
      results[taskName] = {
        ok: false,
        ms: Date.now() - start,
      };
      logger.error({ task: taskName, error }, 'Cron task failed');
    }
  }

  return NextResponse.json({ results });
}
