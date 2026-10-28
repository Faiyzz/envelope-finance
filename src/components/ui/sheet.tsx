'use client';

/**
 * Bottom sheet (mobile) / centred dialog (>= md) on Radix Dialog (TD-10 §6.1):
 * focus trap, Esc closes, focus returns to trigger, scroll lock. The footer
 * stays above the on-screen keyboard via visualViewport inset.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { msg } from '@/messages/en';
import { cn } from '@/lib/cn';

function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const inset = useKeyboardInset();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <Dialog.Content
          aria-describedby={description ? undefined : undefined}
          style={{ bottom: inset }}
          className={cn(
            'fixed inset-x-0 z-50 flex max-h-[92dvh] flex-col rounded-t-3xl border bg-card text-card-foreground shadow-lg outline-none',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom motion-reduce:animate-none',
            'md:inset-x-auto md:start-1/2 md:top-1/2 md:bottom-auto md:w-full md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-3xl rtl:md:translate-x-1/2'
          )}
        >
          <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-2">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label={msg.quick.close()}>
              <X aria-hidden="true" className="size-5" />
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description className="px-5 text-sm text-muted-foreground">{description}</Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{title}</Dialog.Description>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>
          {footer && (
            <div className="border-t px-5 pt-3 pb-[max(env(safe-area-inset-bottom),1rem)]">{footer}</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
