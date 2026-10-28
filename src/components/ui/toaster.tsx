'use client';

import { useEffect, useRef } from 'react';
import { useToasts, type ToastItem } from '@/lib/ui-stores';
import { msg } from '@/messages/en';
import { cn } from '@/lib/cn';

function Toast({ t }: { t: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => dismiss(t.id), t.durationMs);
  };
  const stop = () => clearTimeout(timer.current);

  useEffect(() => {
    start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="status"
      onMouseEnter={stop}
      onMouseLeave={start}
      onFocus={stop}
      onBlur={start}
      className={cn(
        'pointer-events-auto flex min-h-12 items-center justify-between gap-3 rounded-2xl border bg-card px-4 py-2 text-sm shadow-lg',
        t.tone === 'error' && 'border-destructive'
      )}
    >
      <span>{t.message}</span>
      {t.undo && (
        <button
          type="button"
          className="min-h-11 min-w-11 rounded-lg px-2 font-semibold text-primary"
          onClick={async () => {
            dismiss(t.id);
            await t.undo?.();
          }}
        >
          {t.undoLabel ?? msg.quick.undoAction()}
        </button>
      )}
    </div>
  );
}

/** Queue of max 3, auto-dismiss 6 s, pause on hover/focus (TD-10 §6.3). */
export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] mx-auto flex w-full max-w-md flex-col gap-2 px-4 lg:bottom-6"
    >
      {items.map((t) => (
        <Toast key={t.id} t={t} />
      ))}
    </div>
  );
}
