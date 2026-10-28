'use client';

import { AlertTriangle, Inbox } from 'lucide-react';
import { cn } from '@/lib/cn';
import { msg } from '@/messages/en';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-2xl bg-muted', className)} />;
}

export function EmptyState({
  title,
  body,
  cta,
  className,
}: {
  title: string;
  body?: string;
  cta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-3xl border border-dashed p-8 text-center', className)}>
      <Inbox aria-hidden="true" className="size-8 text-muted-foreground" />
      <p className="text-base font-semibold">{title}</p>
      {body && <p className="max-w-sm text-sm text-muted-foreground">{body}</p>}
      {cta && <div className="mt-2">{cta}</div>}
    </div>
  );
}

export function ErrorState({
  title = msg.states.errorDefault(),
  body,
  onRetry,
  className,
}: {
  title?: string;
  body?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-2 rounded-3xl border p-6 text-center', className)}>
      <AlertTriangle aria-hidden="true" className="size-6 text-warning" />
      <p className="font-medium">{title}</p>
      {body && <p className="text-sm text-muted-foreground">{body}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-secondary mt-1">
          {msg.general.retry()}
        </button>
      )}
    </div>
  );
}
