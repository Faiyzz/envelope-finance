'use client';

import { LogOut } from 'lucide-react';
import { useTransition } from 'react';
import { logoutAction } from '@/app/actions';
import { purgeLocalData } from '@/lib/offline/purge';
import { msg } from '@/messages/en';
import { cn } from '@/lib/cn';

/** Purges IndexedDB/caches/local keys first, then ends the server session (TD-12 §7). */
export function LogoutButton({ className }: { className?: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className={cn('flex min-h-11 w-full items-center gap-3 rounded-2xl px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground', className)}
      onClick={() =>
        start(async () => {
          await purgeLocalData();
          await logoutAction();
        })
      }
    >
      <LogOut aria-hidden="true" className="size-5" />
      {msg.pwa.logout()}
    </button>
  );
}
