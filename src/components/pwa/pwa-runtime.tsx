'use client';

/**
 * Registers the service worker, wires update prompts, install events and the
 * online monitor - TD-12 §3, §5.3, §6. Mounted once in the root layout.
 */

import { useEffect } from 'react';
import { startOnlineMonitor } from '@/lib/offline/use-online';
import { useInstall, type BeforeInstallPromptEvent } from '@/lib/pwa-store';
import { toast, useDirty } from '@/lib/ui-stores';
import { msg } from '@/messages/en';

function promptReload(reg: ServiceWorkerRegistration) {
  const apply = () => {
    reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
  };
  toast({
    tone: 'info',
    message: msg.pwa.updateAvailable(),
    undoLabel: msg.pwa.reload(),
    durationMs: 60_000,
    undo: () => {
      // Never auto-reload; if a form has unsaved input, ask first (TD-12 §6)
      if (useDirty.getState().count > 0) {
        toast({ tone: 'info', message: msg.pwa.unsavedChanges(), undoLabel: msg.pwa.reloadAnyway(), durationMs: 30_000, undo: apply });
      } else apply();
    },
  });
}

export function PwaRuntime() {
  useEffect(() => {
    startOnlineMonitor();

    // display-mode (installed) + install prompt
    const mq = window.matchMedia('(display-mode: standalone)');
    const sync = () => useInstall.getState().setStandalone(mq.matches || (navigator as { standalone?: boolean }).standalone === true);
    sync();
    mq.addEventListener?.('change', sync);
    const onBip = (e: Event) => {
      e.preventDefault();
      useInstall.getState().setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBip);
    const onInstalled = () => useInstall.getState().setDeferred(null);
    window.addEventListener('appinstalled', onInstalled);

    // session counter for the "after the 3rd session" install card
    try {
      if (!sessionStorage.getItem('pwa-session-counted')) {
        sessionStorage.setItem('pwa-session-counted', '1');
        localStorage.setItem('pwa-sessions', String(Number(localStorage.getItem('pwa-sessions') ?? 0) + 1));
      }
    } catch {
      /* ignore */
    }

    // service worker (production only; the file does not exist in dev)
    let cancelled = false;
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((reg) => {
          if (cancelled) return;
          if (reg.waiting && navigator.serviceWorker.controller) promptReload(reg);
          reg.addEventListener('updatefound', () => {
            const sw = reg.installing;
            sw?.addEventListener('statechange', () => {
              if (sw.state === 'installed' && navigator.serviceWorker.controller) promptReload(reg);
            });
          });
          // reload once the new worker has taken control (after the user asked)
          let reloaded = false;
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (reloaded) return;
            reloaded = true;
            window.location.reload();
          });
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('appinstalled', onInstalled);
      mq.removeEventListener?.('change', sync);
    };
  }, []);

  return null;
}
