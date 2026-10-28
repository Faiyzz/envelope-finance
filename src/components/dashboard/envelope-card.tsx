'use client';

import Link from 'next/link';
import { UserRound } from 'lucide-react';
import { Money } from '@/components/ui/money';
import { useFormat } from '@/lib/format-context';
import { msg } from '@/messages/en';
import type { EnvelopeCardDTO } from '@/domain/dashboard/types';

export function EnvelopeCard({ e }: { e: EnvelopeCardDTO }) {
  const { fmt } = useFormat();
  const borrowed = BigInt(e.borrowed);
  const loaned = BigInt(e.loanedOut);
  const own = BigInt(e.ownFunds);

  return (
    <Link href={`/envelopes/${e.id}`} data-testid={`envelope-card-${e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} className="card-surface flex min-h-32 flex-col gap-1 p-4 transition-colors hover:bg-accent">
      <span className="flex items-center gap-2 font-medium">
        <span aria-hidden="true" className="text-xl">{e.icon}</span>
        <span className="truncate">{e.name}</span>
      </span>
      <Money value={e.balance} cue className="text-2xl font-semibold" />
      {e.ownerType === 'other' && e.ownerName && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <UserRound aria-hidden="true" className="size-3.5" />
          {msg.dash.heldBadge({ owner: e.ownerName })}
        </span>
      )}
      {(borrowed > 0n || loaned > 0n) && (
        <span className="flex flex-wrap gap-1.5 pt-1">
          {borrowed > 0n && <span className="rounded-full border px-2 py-0.5 text-xs">{msg.dash.owes({ amount: fmt(borrowed) })}</span>}
          {loaned > 0n && <span className="rounded-full border px-2 py-0.5 text-xs">{msg.dash.owed({ amount: fmt(loaned) })}</span>}
        </span>
      )}
      {own < 0n && (
        <span className="text-xs text-muted-foreground">
          {msg.dash.ownFundsNote({ balance: fmt(e.balance), borrowed: fmt(borrowed) })}
        </span>
      )}
      {e.goal && (
        <span className="mt-1 block">
          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={e.goal.progressPct}
            aria-label={msg.dash.goalProgress({ pct: e.goal.progressPct })}
            className="block h-2 overflow-hidden rounded-full bg-muted"
          >
            <span className="block h-full bg-primary" style={{ width: `${e.goal.progressPct}%` }} />
          </span>
          <span className="text-xs text-muted-foreground">{msg.dash.goalProgress({ pct: e.goal.progressPct })}</span>
        </span>
      )}
      <span className="mt-auto pt-1 text-xs text-muted-foreground">{msg.dash.txCount({ n: e.txCount })}</span>
    </Link>
  );
}
