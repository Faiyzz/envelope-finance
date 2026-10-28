import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '@/server/auth/session';
import { getEnvelopeDetail } from '@/server/repositories/envelopes';
import { listTransactions } from '@/server/repositories/transactions';
import { Money } from '@/components/ui/money';
import { EmptyState } from '@/components/ui/states';
import { TxRows } from '@/components/lists/tx-rows';
import { ActionButton } from '@/components/forms/action-form';
import { msg } from '@/messages/en';

export const dynamic = 'force-dynamic';

export default async function EnvelopeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const { userId } = await requireUser();
  const env = await getEnvelopeDetail(userId, id).catch(() => null);
  if (!env) notFound();
  const { items } = await listTransactions(userId, { envelopeIds: [id], limit: 30 });
  const stats: Array<[string, bigint]> = [[msg.page.spent(), env.month.spent], [msg.forms.add(), env.month.added]];

  return (
    <div className="grid gap-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><span aria-hidden="true">{env.icon}</span>{env.name}</h1>
          {env.ownerType === 'other' && env.ownerName && <p className="text-sm text-muted-foreground">{msg.dash.heldBadge({ owner: env.ownerName })}</p>}
        </div>
        {env.status === 'active' ? (
          <ActionButton action="archiveEnvelope" input={{ id, ...(env.ownerType === 'other' ? { resolution: 'return_to_owner' } : { resolution: 'to_unallocated' }) }} label={msg.page.archive()} confirm />
        ) : (
          <ActionButton action="unarchiveEnvelope" input={{ id }} label={msg.page.unarchive()} />
        )}
      </header>
      <div className="card-surface p-5">
        <p className="text-sm text-muted-foreground">{msg.page.balance()}</p>
        <Money value={env.balance.toString()} cue className="text-3xl font-bold" />
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          {stats.map(([k, v]) => (
            <div key={k}><dt className="text-muted-foreground">{k}</dt><dd><Money value={v.toString()} className="font-medium" /></dd></div>
          ))}
        </dl>
      </div>
      {items.length === 0 ? (
        <EmptyState title={msg.page.noTx()} />
      ) : (
        <TxRows
          mode="none"
          names={{ [id]: env.name }}
          items={items.map((t) => ({ ...t, amountPaisa: t.amountPaisa.toString() }))}
        />
      )}
    </div>
  );
}
