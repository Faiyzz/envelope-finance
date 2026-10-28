import { NextResponse } from 'next/server';
import { requireUser } from '@/server/auth/session';
import { isSameOrigin } from '@/server/http/origin';
import { commitImport, validateImportBytes, MAX_IMPORT_BYTES, ImportIntegrityError } from '@/server/backup/import';
import { RateLimited } from '@/domain/errors';
import { todayIn } from '@/domain/dates';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/import   (multipart: file, confirm?)   ?dryRun=1 validates only.
 * Replace-everything import (TD-11 §4). Nothing is written unless validation passes.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Bad origin.' }, { status: 403 });

  let session;
  try {
    session = await requireUser();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > MAX_IMPORT_BYTES + 64 * 1024) return NextResponse.json({ ok: false, message: 'This file is larger than 20 MB.', problems: [], totalProblems: 0 }, { status: 413 });

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return NextResponse.json({ ok: false, message: 'Choose a backup file.', problems: [], totalProblems: 0 }, { status: 400 });

  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1';
  if (!dryRun && form?.get('confirm') !== 'REPLACE') {
    return NextResponse.json({ ok: false, message: 'Type REPLACE to confirm.', problems: [], totalProblems: 0 }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const today = todayIn(session.user.timezone, Date.now());
  const result = validateImportBytes(bytes, today);
  if (!result.ok) return NextResponse.json(result, { status: 422 });

  if (dryRun) {
    return NextResponse.json({ ok: true, dryRun: true, counts: result.counts, schemaVersion: result.schemaVersion });
  }

  try {
    const done = await commitImport(session.userId, result);
    return NextResponse.json({ ok: true, ...done });
  } catch (e) {
    if (e instanceof RateLimited) {
      return NextResponse.json({ ok: false, message: 'You can import up to 3 times an hour. Try again later.', problems: [], totalProblems: 0 }, { status: 429 });
    }
    if (e instanceof ImportIntegrityError) {
      return NextResponse.json({ ok: false, message: e.message, problems: [], totalProblems: 0 }, { status: 422 });
    }
    logger.error({ err: e instanceof Error ? e.message : 'unknown' }, 'import failed');
    return NextResponse.json({ ok: false, message: 'Something went wrong. Nothing was changed.', problems: [], totalProblems: 0 }, { status: 500 });
  }
}
