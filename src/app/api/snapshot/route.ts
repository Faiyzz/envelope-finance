import { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/session';
import { getRecent100 } from '@/server/queries/snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/snapshot - data for the per-user offline snapshot (never cached by the SW). */
export async function GET() {
  try {
    const { userId } = await requireUser();
    return NextResponse.json({ recent100: await getRecent100(userId) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
