'use client';

/**
 * Online state - TD-12 §5.3: navigator.onLine plus a 15 s heartbeat
 * (HEAD /api/health) while the tab is visible and onLine is false or just flapped.
 */

import { create } from 'zustand';

interface OnlineState {
  online: boolean;
  set: (v: boolean) => void;
}

export const useOnlineStore = create<OnlineState>((set) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  set: (online) => set({ online }),
}));

export const useOnline = () => useOnlineStore((s) => s.online);

let started = false;
export function startOnlineMonitor() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const { set } = useOnlineStore.getState();
  const goOnline = () => set(true);
  const goOffline = () => set(false);
  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);

  const beat = async () => {
    if (document.visibilityState !== 'visible') return;
    if (navigator.onLine && useOnlineStore.getState().online) return; // healthy: no traffic
    try {
      const r = await fetch('/api/health', { method: 'HEAD', cache: 'no-store' });
      set(r.ok);
    } catch {
      set(false);
    }
  };
  setInterval(beat, 15_000);
}
