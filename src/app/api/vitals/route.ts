import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const NAMES = new Set(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']);

/** Receives Web Vitals beacons; logs only metric facts (no user data). */
export async function POST(request: Request) {
  const text = await request.text();
  if (text.length > 1024) return new NextResponse(null, { status: 413 });
  try {
    const m = JSON.parse(text) as { name: string; value: number; rating: string; nav: string; path: string };
    if (NAMES.has(m.name) && Number.isFinite(m.value)) {
      logger.info({ vitals: { name: m.name, value: m.value, rating: String(m.rating).slice(0, 16), nav: String(m.nav).slice(0, 16), path: String(m.path).slice(0, 80) } }, 'web-vital');
    }
  } catch {
    /* ignore malformed beacons */
  }
  return new NextResponse(null, { status: 204 });
}
