import { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/session';
import { buildCsv } from '@/server/backup/export';
import { CSV_KINDS, type CsvKind } from '@/domain/backup/csv';
import { todayIn, parseLocalDate, diffDays } from '@/domain/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_RANGE_DAYS = 366 * 5;

/** GET /api/export/csv?kind=...&from=&to= (TD-11 §3) */
export async function GET(request: Request) {
  let session;
  try {
    session = await requireUser();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') as CsvKind | null;
  if (!kind || !CSV_KINDS.includes(kind)) return NextResponse.json({ error: 'Unknown export type.' }, { status: 400 });

  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const from = fromRaw ? parseLocalDate(fromRaw) : null;
  const to = toRaw ? parseLocalDate(toRaw) : null;
  if ((fromRaw && !from) || (toRaw && !to)) return NextResponse.json({ error: 'Invalid date.' }, { status: 400 });
  if (from && to && (from > to || diffDays(to, from) > MAX_RANGE_DAYS)) {
    return NextResponse.json({ error: 'Pick a range of at most 5 years, with the start before the end.' }, { status: 400 });
  }

  const csv = await buildCsv(session.userId, kind, { from: from ?? undefined, to: to ?? undefined });
  if (Buffer.byteLength(csv) > MAX_BYTES) return NextResponse.json({ error: 'That export is too large; narrow the date range.' }, { status: 400 });

  const date = todayIn(session.user.timezone, Date.now());
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="envelope-${kind}-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
