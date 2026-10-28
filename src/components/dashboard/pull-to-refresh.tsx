'use client';

/** Touch pull-to-refresh at scroll-top; disabled offline (TD-10 §4.2). */

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { RefreshCw } from 'lucide-react';
import { msg } from '@/messages/en';

const THRESHOLD = 72;

export function PullToRefresh({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pulled, setPulled] = useState(0);
  const [isPending, startTransition] = useTransition();
  const startY = useRef<number | null>(null);

  const onStart = (e: React.TouchEvent) => {
    if (window.scrollY <= 0 && navigator.onLine) startY.current = e.touches[0]!.clientY;
  };
  const onMove = (e: React.TouchEvent) => {
    if (startY.current === null) return;
    const dy = e.touches[0]!.clientY - startY.current;
    setPulled(dy > 0 ? Math.min(dy * 0.5, THRESHOLD * 1.5) : 0);
  };
  const onEnd = () => {
    if (startY.current !== null && pulled >= THRESHOLD) startTransition(() => router.refresh());
    startY.current = null;
    setPulled(0);
  };

  return (
    <div onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={onEnd}>
      <div
        aria-hidden={pulled === 0 && !isPending}
        className="flex items-center justify-center overflow-hidden text-sm text-muted-foreground transition-[height] motion-reduce:transition-none"
        style={{ height: isPending ? 40 : pulled }}
      >
        <RefreshCw className={isPending ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
        <span className="ms-2">{isPending ? msg.general.loading() : msg.dash.pullToRefresh()}</span>
      </div>
      {children}
    </div>
  );
}
