'use client';

/**
 * Quick-add host - TD-10 §5.1. URL-driven (`?add=expense`) so deep links and
 * the PWA shortcut work. `?add=menu` shows the actions grid.
 */

import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import {
  ArrowLeftRight, Banknote, CalendarPlus, HandCoins, Handshake, PiggyBank, Plus, Receipt, TrendingUp, Undo2, Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Sheet } from '@/components/ui/sheet';
import { msg } from '@/messages/en';
import { ExpenseForm } from './expense-form';
import { OtherForm } from './other-forms';

export type QuickKind =
  | 'expense' | 'income' | 'allocate' | 'transfer' | 'loan' | 'repay' | 'envelope' | 'recurring' | 'held_in' | 'held_out';

const ACTIONS: Array<{ kind: QuickKind; icon: LucideIcon; label: () => string }> = [
  { kind: 'expense', icon: Receipt, label: msg.quick.actions.expense },
  { kind: 'income', icon: TrendingUp, label: msg.quick.actions.income },
  { kind: 'allocate', icon: PiggyBank, label: msg.quick.actions.allocate },
  { kind: 'transfer', icon: ArrowLeftRight, label: msg.quick.actions.transfer },
  { kind: 'loan', icon: Handshake, label: msg.quick.actions.loan },
  { kind: 'repay', icon: Undo2, label: msg.quick.actions.repay },
  { kind: 'envelope', icon: Wallet, label: msg.quick.actions.envelope },
  { kind: 'recurring', icon: CalendarPlus, label: msg.quick.actions.recurring },
  { kind: 'held_in', icon: HandCoins, label: msg.quick.actions.held_in },
  { kind: 'held_out', icon: Banknote, label: msg.quick.actions.held_out },
];

const KINDS = new Set<string>(ACTIONS.map((a) => a.kind));

export function useQuickAdd() {
  const router = useRouter();
  const pathname = usePathname();
  const open = useCallback(
    (kind: QuickKind | 'menu' = 'menu') => router.push(`${pathname}?add=${kind}`, { scroll: false }),
    [router, pathname]
  );
  const close = useCallback(() => router.replace(pathname, { scroll: false }), [router, pathname]);
  return { open, close };
}

function Inner() {
  const params = useSearchParams();
  const { open, close } = useQuickAdd();
  const add = params.get('add');
  const isOpen = add === 'menu' || (add !== null && KINDS.has(add));
  const kind = add && KINDS.has(add) ? (add as QuickKind) : null;
  const meta = ACTIONS.find((a) => a.kind === kind);

  const title = kind ? meta!.label() : msg.quick.title();

  return (
    <Sheet open={isOpen} onOpenChange={(o) => !o && close()} title={title}>
      {!kind && (
        <ul className="grid grid-cols-2 gap-3 pb-4">
          {ACTIONS.map(({ kind: k, icon: Icon, label }) => (
            <li key={k}>
              <button
                type="button"
                onClick={() => open(k)}
                className="flex min-h-24 w-full flex-col items-center justify-center gap-2 rounded-2xl border bg-secondary p-3 text-center text-sm font-medium hover:bg-accent"
              >
                <Icon aria-hidden="true" className="size-6 text-primary" />
                {label()}
              </button>
            </li>
          ))}
        </ul>
      )}
      {kind === 'expense' && <ExpenseForm onDone={close} />}
      {kind && kind !== 'expense' && <OtherForm kind={kind} onDone={close} />}
    </Sheet>
  );
}

export function QuickAddHost() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}

// re-exported for symmetry with the FAB
export { Plus as QuickAddIcon };
