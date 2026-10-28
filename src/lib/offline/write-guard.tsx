'use client';

import { useOnline } from './use-online';
import { msg } from '@/messages/en';

export const OFFLINE_EXPLAIN_ID = 'offline-explain';

/** Props to spread on any control that writes (TD-12 §5.3): disabled + described when offline. */
export function useWriteGuard() {
  const online = useOnline();
  return {
    online,
    guardProps: online ? ({} as const) : ({ disabled: true, 'aria-describedby': OFFLINE_EXPLAIN_ID } as const),
  };
}

/** Rendered once; gives disabled controls an accessible explanation. */
export function OfflineExplain() {
  return (
    <p id={OFFLINE_EXPLAIN_ID} className="sr-only">
      {msg.pwa.writesDisabled()}
    </p>
  );
}
