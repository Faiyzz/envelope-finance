'use client';

import { useLive } from '@/lib/ui-stores';

/** Polite screen-reader announcements for balance changes (TD-10 §6.4). */
export function LiveRegion() {
  const message = useLive((s) => s.message);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
