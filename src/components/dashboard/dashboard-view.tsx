'use client';

/**
 * Dashboard composition - TD-10 §4.2. Server data + pending optimistic
 * expenses (applyPendingExpenses) -> every number on screen.
 */

import Link from 'next/link';
import { useMemo } from 'react';
import { CalendarClock, Wallet } from 'lucide-react';
import { AnimatedMoney, Money } from '@/components/ui/money';
import { EmptyState } from '@/components/ui/states';
import { SectionBoundary } from '@/components/ui/section-boundary';
import { applyPendingExpenses } from '@/domain/dashboard/optimistic';
import { describeTx, shortDate, upcomingLabel } from '@/domain/dashboard/labels';
import type { DashboardDTO } from '@/domain/dashboard/types';
import { usePending } from '@/lib/ui-stores';
import { useSnapshotWriter } from '@/lib/offline/snapshot';
import { useFormat } from '@/lib/format-context';
import { useQuickAdd } from '@/components/quick-add/quick-add-host';
import { msg } from '@/messages/en';
import { cn } from '@/lib/cn';
import { AttentionStrip } from './attention-strip';
import { EnvelopeCard } from './envelope-card';
import { PullToRefresh } from './pull-to-refresh';
import { ReconChip } from './recon-chip';

function Tile({ label, value, sub, href, onClick, disabled, hint, testId }: {
  testId?: string; label: string; value: string; sub?: string; href?: string; onClick?: () => void; disabled?: boolean; hint?: string;
}) {
  const body = (
    <>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Money value={value} className="text-lg font-semibold" />
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      {disabled && hint && <span className="sr-only">{hint}</span>}
    </>
  );
  const cls = 'card-surface flex min-h-24 flex-col items-start justify-center gap-0.5 p-3 text-start transition-colors hover:bg-accent';
  if (href) return <Link href={href} data-testid={testId} className={cls}>{body}</Link>;
  return (
    <button type="button" data-testid={testId} className={cn(cls, disabled && 'opacity-70')} aria-disabled={disabled || undefined} onClick={disabled ? undefined : onClick}>
      {body}
    </button>
  );
}

export function DashboardView({ data: server, userName, userId }: { data: DashboardDTO; userName: string; userId: string }) {
  const { grouping } = useFormat();
  const pending = usePending((s) => s.items);
  const data = useMemo(() => applyPendingExpenses(server, pending), [server, pending]);
  const { open } = useQuickAdd();
  useSnapshotWriter(userId, server, grouping); // offline snapshot reflects confirmed server data only

  const mine = data.envelopes.filter((e) => e.ownerType === 'mine');
  const others = data.envelopes.filter((e) => e.ownerType === 'other');
  const unallocated = BigInt(data.unallocated);

  return (
    <PullToRefresh>
      <div className="grid gap-5">
        <h1 className="sr-only">{msg.nav.dashboard()} — {userName}</h1>

        {/* 1. Total */}
        <section aria-labelledby="total-h" className="card-surface flex flex-col gap-2 p-5">
          <h2 id="total-h" className="text-sm font-medium text-muted-foreground">{msg.dash.totalBalance()}</h2>
          <AnimatedMoney testId="total-balance" value={data.total} className="text-4xl font-bold tracking-tight md:text-5xl" />
          <div><ReconChip recon={data.recon} /></div>
        </section>

        {/* 2. Tiles */}
        <section aria-label="Balance breakdown" className="grid grid-cols-3 gap-3">
          <Tile testId="tile-your-money" label={msg.dash.yourMoney()} value={data.yourMoney} href="/envelopes?owner=mine" />
          <Tile testId="tile-held" label={msg.dash.heldForOthers()} value={data.heldForOthers} sub={msg.dash.heldSub()} href="/envelopes?owner=other" />
          <Tile
            testId="tile-unallocated"
            label={msg.dash.unallocated()}
            value={data.unallocated}
            sub={unallocated > 0n ? msg.dash.assignMoney() : undefined}
            disabled={unallocated <= 0n}
            hint={msg.dash.nothingToAssign()}
            onClick={() => open('allocate')}
          />
        </section>

        {/* 3. Attention */}
        <SectionBoundary section="alerts"><AttentionStrip items={data.attention} /></SectionBoundary>

        {/* Setup empty states */}
        {!data.setup.hasOpeningBalance && (
          <EmptyState
            title={msg.dash.setOpeningTitle()}
            body={msg.dash.setOpeningBody()}
            cta={<Link href="/onboarding" className="btn-primary">{msg.dash.setOpeningCta()}</Link>}
          />
        )}

        {/* 4. Envelopes */}
        <SectionBoundary section="envelopes">
          <section aria-labelledby="env-h" className="grid gap-3">
            <h2 id="env-h" className="text-lg font-semibold">{msg.dash.envelopes()}</h2>
            {data.envelopes.length === 0 ? (
              <EmptyState
                title={msg.dash.emptyEnvelopesTitle()}
                body={msg.dash.emptyEnvelopesBody()}
                cta={<button type="button" className="btn-primary" onClick={() => open('envelope')}><Wallet aria-hidden="true" className="size-5" />{msg.quick.actions.envelope()}</button>}
              />
            ) : (
              <>
                <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                  {mine.map((e) => <li key={e.id}><EnvelopeCard e={e} /></li>)}
                </ul>
                {others.length > 0 && (
                  <>
                    <h3 className="pt-2 text-sm font-semibold text-muted-foreground">{msg.dash.heldHeader()}</h3>
                    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                      {others.map((e) => <li key={e.id}><EnvelopeCard e={e} /></li>)}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>
        </SectionBoundary>

        {/* 5. Upcoming */}
        <SectionBoundary section="upcoming">
          <section aria-labelledby="up-h" className="grid gap-2">
            <h2 id="up-h" className="text-lg font-semibold">{msg.dash.upcoming()}</h2>
            {data.upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">{msg.dash.noUpcoming()}</p>
            ) : (
              <ul className="card-surface divide-y">
                {data.upcoming.map((u) => {
                  const l = upcomingLabel(u.inDays, u.needsAttention);
                  const when =
                    l.kind === 'overdue' ? msg.dash.overdue() : l.kind === 'today' ? msg.dash.today() : l.kind === 'tomorrow' ? msg.dash.tomorrow() : msg.dash.inDays({ n: l.n });
                  return (
                    <li key={u.id} className="flex items-center justify-between gap-3 p-4">
                      <span className="flex min-w-0 items-center gap-3">
                        <CalendarClock aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{u.ruleName}</span>
                          <span className="block text-xs text-muted-foreground">{when} · {shortDate(u.dueDate)}</span>
                        </span>
                      </span>
                      <Money value={u.type === 'expense' ? -BigInt(u.amount) : BigInt(u.amount)} sign="always" className="shrink-0 text-end" />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </SectionBoundary>

        {/* 6. Recent */}
        <SectionBoundary section="recent activity">
          <section aria-labelledby="rec-h" className="grid gap-2">
            <div className="flex items-center justify-between">
              <h2 id="rec-h" className="text-lg font-semibold">{msg.dash.recent()}</h2>
              <Link href="/transactions" className="inline-flex min-h-11 items-center text-sm font-medium text-primary">{msg.dash.seeAll()}</Link>
            </div>
            {data.recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">{msg.dash.noRecent()}</p>
            ) : (
              <ul className="card-surface divide-y">
                {data.recent.map((r) => {
                  const { title, subtitle } = describeTx(r);
                  const signed = BigInt(r.signedAmount);
                  const isPending = r.id.startsWith('pending:');
                  return (
                    <li key={r.id} className={cn('flex items-center justify-between gap-3 p-4', isPending && 'opacity-60')}>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{subtitle} · {shortDate(r.occurredOn)}</span>
                      </span>
                      {signed === 0n ? (
                        <span aria-hidden="true" className="text-muted-foreground">→</span>
                      ) : (
                        <Money value={signed} sign="always" className="shrink-0 text-end" />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </SectionBoundary>
      </div>
    </PullToRefresh>
  );
}
