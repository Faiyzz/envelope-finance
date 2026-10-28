'use client';

/**
 * Read-only offline viewer - TD-12 §5.2. Client-rendered and precached; reads
 * the per-user IndexedDB snapshot. No write controls exist here.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { WifiOff } from 'lucide-react';
import { getSnapshot, lastUserId } from '@/lib/offline/idb';
import { ageDays, readable, STALE_AFTER_DAYS, type Snapshot } from '@/lib/offline/snapshot';
import { useOnline } from '@/lib/offline/use-online';
import { FormatProvider, useFormat } from '@/lib/format-context';
import { Money } from '@/components/ui/money';
import { EmptyState, Skeleton } from '@/components/ui/states';
import { describeTx, shortDate } from '@/domain/dashboard/labels';
import { msg } from '@/messages/en';
import { cn } from '@/lib/cn';

type Tab = 'dashboard' | 'envelopes' | 'recent';

function whenLabel(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const same = d.toDateString() === new Date().toDateString();
  return same ? `${time} ${msg.pwa.today()}` : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

function Viewer({ snap }: { snap: Snapshot }) {
  const online = useOnline();
  const { fmt } = useFormat();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [q, setQ] = useState('');
  const d = snap.dashboard;
  const age = ageDays(snap.fetchedAt);

  const recent = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return snap.recent100;
    return snap.recent100.filter((r) => {
      const { title, subtitle } = describeTx(r);
      return `${title} ${subtitle} ${r.categoryName ?? ''}`.toLowerCase().includes(needle);
    });
  }, [q, snap.recent100]);

  return (
    <div className="mx-auto grid max-w-3xl gap-4 px-4 pb-16">
      <div role="status" className="sticky top-0 z-10 -mx-4 flex items-center gap-2 border-b bg-warning/15 px-4 py-3 text-sm backdrop-blur">
        <WifiOff aria-hidden="true" className="size-4 shrink-0" />
        <span>{msg.pwa.offlineBanner({ when: whenLabel(snap.fetchedAt) })}</span>
        {online && <Link href="/" className="ms-auto font-semibold text-primary underline">{msg.dash.refresh()}</Link>}
      </div>
      {age >= STALE_AFTER_DAYS && <p role="alert" className="rounded-2xl border border-warning/50 bg-warning/10 p-3 text-sm font-medium">{msg.pwa.staleWarning({ days: age })}</p>}

      <h1 className="text-xl font-bold">{msg.pwa.offlineTitle()}</h1>
      <div role="tablist" aria-label={msg.pwa.offlineTitle()} className="flex gap-2">
        {(['dashboard', 'envelopes', 'recent'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('chip', tab === t ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'bg-secondary')}>
            {msg.pwa.tabs[t]()}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && (
        <>
          <section className="card-surface p-5">
            <h2 className="text-sm text-muted-foreground">{msg.dash.totalBalance()}</h2>
            <Money value={d.total} className="text-4xl font-bold" />
          </section>
          <section className="grid grid-cols-3 gap-3">
            {[[msg.dash.yourMoney(), d.yourMoney], [msg.dash.heldForOthers(), d.heldForOthers], [msg.dash.unallocated(), d.unallocated]].map(([label, v]) => (
              <div key={label} className="card-surface flex min-h-24 flex-col justify-center p-3">
                <span className="text-xs text-muted-foreground">{label}</span>
                <Money value={v!} className="text-lg font-semibold" />
              </div>
            ))}
          </section>
        </>
      )}

      {tab === 'envelopes' && (
        <ul className="grid grid-cols-2 gap-3">
          {d.envelopes.map((e) => (
            <li key={e.id} className="card-surface flex flex-col gap-1 p-4">
              <span className="flex items-center gap-2 font-medium"><span aria-hidden="true">{e.icon}</span>{e.name}</span>
              <Money value={e.balance} cue className="text-xl font-semibold" />
              {e.ownerType === 'other' && e.ownerName && <span className="text-xs text-muted-foreground">{msg.dash.heldBadge({ owner: e.ownerName })}</span>}
            </li>
          ))}
        </ul>
      )}

      {tab === 'recent' && (
        <>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={msg.pwa.searchOffline()} placeholder={msg.pwa.searchOffline()} className="h-12 rounded-2xl border bg-background px-4" />
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">{msg.dash.noRecent()}</p>
          ) : (
            <ul className="card-surface divide-y">
              {recent.map((r) => {
                const { title, subtitle } = describeTx(r);
                const s = BigInt(r.signedAmount);
                return (
                  <li key={r.id} className="flex items-center justify-between gap-3 p-4">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{subtitle} · {shortDate(r.occurredOn)}</span>
                    </span>
                    {s === 0n ? <span aria-hidden="true">→</span> : <Money value={s} sign="always" className="shrink-0" />}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <span className="sr-only">{fmt(d.total)}</span>
    </div>
  );
}

export function OfflineViewer() {
  const [state, setState] = useState<{ loading: boolean; snap: Snapshot | null }>({ loading: true, snap: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      const uid = lastUserId();
      const raw = uid ? await getSnapshot<unknown>(uid) : null;
      const snap = readable(raw);
      if (alive) setState({ loading: false, snap });
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state.loading) return <div className="mx-auto grid max-w-3xl gap-3 p-4" aria-busy="true"><Skeleton className="h-12" /><Skeleton className="h-32" /></div>;
  if (!state.snap) {
    return (
      <div className="mx-auto max-w-md p-4">
        <EmptyState title={msg.pwa.noSnapshot()} cta={<Link href="/" className="btn-primary">{msg.dash.refresh()}</Link>} />
      </div>
    );
  }
  return (
    <FormatProvider grouping={state.snap.grouping} initialHidden={false}>
      <Viewer snap={state.snap} />
    </FormatProvider>
  );
}
