'use client';

import { WifiOff } from 'lucide-react';
import { useOnline } from '@/lib/offline/use-online';
import { msg } from '@/messages/en';

/** Persistent in-app banner when the connection drops (TD-12 §5.2). */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="sticky top-14 z-20 flex items-center gap-2 border-b bg-warning/15 px-4 py-2 text-sm lg:top-16">
      <WifiOff aria-hidden="true" className="size-4 shrink-0" />
      <span>{msg.pwa.offlineLive()}</span>
    </div>
  );
}
