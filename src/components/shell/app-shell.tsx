'use client';

/**
 * App shell - TD-10 §2. Bottom nav (<1024px) / sidebar (>=1024px), header with
 * search + hide-balances + add, quick-add host, toaster, live region.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Eye, EyeOff, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { msg } from '@/messages/en';
import { cn } from '@/lib/cn';
import { useFormat } from '@/lib/format-context';
import { BOTTOM_LEFT, BOTTOM_RIGHT, MORE_ICON, MORE_ITEMS, SIDEBAR, isActive, type NavItem } from './nav-items';
import { QuickAddHost, useQuickAdd } from '@/components/quick-add/quick-add-host';
import { Toaster } from '@/components/ui/toaster';
import { LiveRegion } from '@/components/ui/live-region';
import { OfflineBanner } from '@/components/pwa/offline-banner';
import { InstallCard } from '@/components/pwa/install-card';
import { LogoutButton } from '@/components/pwa/logout-button';
import { OfflineExplain, useWriteGuard } from '@/lib/offline/write-guard';

function NavLink({ item, pathname, layout }: { item: NavItem; pathname: string; layout: 'bottom' | 'side' }) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center rounded-2xl text-sm font-medium transition-colors',
        layout === 'bottom'
          ? 'min-h-14 min-w-11 flex-1 flex-col justify-center gap-0.5 text-xs'
          : 'min-h-11 gap-3 px-3',
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <Icon aria-hidden="true" className="size-5" />
      <span>{item.label()}</span>
    </Link>
  );
}

function MoreSheet({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const Icon = MORE_ICON;
  const active = MORE_ITEMS.some((i) => isActive(pathname, i.href));
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex min-h-14 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl text-xs font-medium',
          active ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
        )}
      >
        <Icon aria-hidden="true" className="size-5" />
        <span>{msg.nav.more()}</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 rounded-t-3xl border bg-card p-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
          <Dialog.Title className="px-2 pb-2 text-lg font-semibold">{msg.nav.more()}</Dialog.Title>
          <Dialog.Description className="sr-only">{msg.nav.more()}</Dialog.Description>
          <ul className="grid gap-1">
            {MORE_ITEMS.map((i) => (
              <li key={i.href}>
                <NavLink item={i} pathname={pathname} layout="side" />
              </li>
            ))}
          </ul>
          <LogoutButton className="mt-1" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HideToggle() {
  const { hidden, setHidden } = useFormat();
  const Icon = hidden ? EyeOff : Eye;
  return (
    <button
      type="button"
      className="icon-btn"
      aria-pressed={hidden}
      aria-label={hidden ? msg.nav.showBalances() : msg.nav.hideBalances()}
      onClick={() => setHidden(!hidden)}
    >
      <Icon aria-hidden="true" className="size-5" />
    </button>
  );
}

export function AppShell({ userName, children }: { userName: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { open } = useQuickAdd();
  const { guardProps } = useWriteGuard();

  // ⌘K / Ctrl+K -> search (TD-05 §8)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        router.push('/search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[70] focus:rounded-xl focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground"
      >
        {msg.nav.skip()}
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col gap-1 border-e p-4 lg:flex" aria-label={msg.nav.primary()}>
        <p className="px-3 pb-4 text-lg font-bold">Envelope Finance</p>
        <nav className="grid gap-1">
          {SIDEBAR.map((i) => (
            <NavLink key={i.href} item={i} pathname={pathname} layout="side" />
          ))}
        </nav>
        <div className="mt-auto grid gap-1">
          <p className="truncate px-3 text-sm text-muted-foreground">{userName}</p>
          <LogoutButton />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b bg-background/90 px-4 pt-[env(safe-area-inset-top)] backdrop-blur lg:h-16 lg:px-8">
          <p className="font-bold lg:hidden">Envelope Finance</p>
          <div className="ms-auto flex items-center gap-1">
            <Link href="/search" className="icon-btn" aria-label={msg.nav.search()}>
              <Search aria-hidden="true" className="size-5" />
            </Link>
            <HideToggle />
            <button type="button" className="btn-primary hidden lg:inline-flex" data-testid="header-add" onClick={() => open('expense')} {...guardProps}>
              <Plus aria-hidden="true" className="size-5" />
              {msg.nav.add()}
            </button>
          </div>
        </header>

        <OfflineBanner />
        <main id="main" className="mx-auto w-full max-w-5xl px-4 pt-4 pb-32 lg:px-8 lg:pb-12">
          <div className="mb-4 empty:hidden"><InstallCard /></div>
          {children}
        </main>
      </div>

      <nav
        aria-label={msg.nav.primary()}
        className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-1 border-t bg-background/95 px-2 pt-1 pb-[max(env(safe-area-inset-bottom),0.5rem)] backdrop-blur lg:hidden"
      >
        {BOTTOM_LEFT.map((i) => (
          <NavLink key={i.href} item={i} pathname={pathname} layout="bottom" />
        ))}
        <div className="flex flex-1 justify-center">
          <button
            type="button"
            aria-label={msg.nav.add()}
            data-testid="quick-add-fab"
            {...guardProps}
            onClick={() => open()}
            className="-mt-6 inline-flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg disabled:opacity-50"
          >
            <Plus aria-hidden="true" className="size-7" />
          </button>
        </div>
        {BOTTOM_RIGHT.map((i) => (
          <NavLink key={i.href} item={i} pathname={pathname} layout="bottom" />
        ))}
        <MoreSheet pathname={pathname} />
      </nav>

      <QuickAddHost />
      <Toaster />
      <LiveRegion />
      <OfflineExplain />
    </div>
  );
}
