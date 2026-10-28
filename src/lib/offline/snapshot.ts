'use client';

/**
 * Per-user offline snapshot - TD-12 §5.1. Written after a successful online
 * render (throttled, only when changed); read by the /offline viewer.
 */

import { useEffect, useRef } from 'react';
import type { DashboardDTO, RecentTxDTO } from '@/domain/dashboard/types';
import { putSnapshot } from './idb';

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_THROTTLE_MS = 10_000;
export const STALE_AFTER_DAYS = 7;

export interface Snapshot {
  v: number;
  userId: string;
  appVersion: string;
  fetchedAt: string;
  grouping: 'western' | 'lakh';
  dashboard: DashboardDTO;
  recent100: RecentTxDTO[];
}

/** Stable fingerprint of what the user would see (ignores volatile timestamps). */
export function fingerprint(s: Pick<Snapshot, 'dashboard' | 'recent100'>): string {
  const { fetchedAt: _f, ...d } = s.dashboard;
  return JSON.stringify([d, s.recent100.length, s.recent100[0]?.id ?? null]);
}

export function ageDays(fetchedAt: string, now = Date.now()): number {
  return Math.floor((now - new Date(fetchedAt).getTime()) / 86_400_000);
}

/** Validates/migrates a stored snapshot; returns null (drop) on version skew. */
export function readable(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<Snapshot>;
  if (s.v !== SNAPSHOT_VERSION || !s.dashboard || !s.userId || !s.fetchedAt) return null;
  return s as Snapshot;
}

export function useSnapshotWriter(userId: string, dashboard: DashboardDTO, grouping: 'western' | 'lakh') {
  const last = useRef<{ fp: string; at: number } | null>(null);

  useEffect(() => {
    if (!navigator.onLine) return;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch('/api/snapshot', { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) return;
        const { recent100 } = (await res.json()) as { recent100: RecentTxDTO[] };
        const snap: Snapshot = {
          v: SNAPSHOT_VERSION,
          userId,
          appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev',
          fetchedAt: new Date().toISOString(),
          grouping,
          dashboard,
          recent100,
        };
        const fp = fingerprint(snap);
        const now = Date.now();
        if (last.current && (last.current.fp === fp || now - last.current.at < SNAPSHOT_THROTTLE_MS)) return;
        last.current = { fp, at: now };
        await putSnapshot(userId, snap);
      } catch {
        /* offline / IDB unavailable: the viewer simply shows nothing */
      }
    }, 1500); // after first paint, off the critical path
    return () => clearTimeout(handle);
  }, [userId, dashboard, grouping]);
}
