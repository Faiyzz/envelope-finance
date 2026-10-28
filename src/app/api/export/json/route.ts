import { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/session';
import { buildBackup } from '@/server/backup/export';
import { todayIn } from '@/domain/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/export/json - full-fidelity backup (TD-11 §2). */
export async function GET() {
  let session;
  try {
    session = await requireUser();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const doc = await buildBackup(session.userId);
  const date = todayIn(session.user.timezone, Date.now());
  return new NextResponse(JSON.stringify(doc), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="envelope-backup-${date}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
