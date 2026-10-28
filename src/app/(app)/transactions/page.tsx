import Link from 'next/link';
import { requireUser } from '@/server/auth/session';
import { listTransactions } from '@/server/repositories/transactions';
import { envelopeNames } from '@/server/queries/envelope-names';
import { EmptyState } from '@/components/ui/states';
import { Money } from '@/components/ui/money';
import { TxRows } from '@/components/lists/tx-rows';
import { AddButton } from '@/components/lists/add-button';
import { cn } from '@/lib/cn';
import { msg } from '@/messages/en';

export const dynamic = 'force-dynamic';

const FILTERS = [
  { type: undefined, label: msg.page.filterAll() },
  { type: 'expense', label: msg.forms.expense() },
  { type: 'income', label: msg.forms.income() },
  { type: 'transfer', label: msg.quick.actions.transfer() },
];

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<{ type?: string; cursor?: string }> }) {
  const { type, cursor } = await searchParams;
  const { userId } = await requireUser();
  const [res, names] = await Promise.all([
    listTransactions(userId, { types: type ? [type] : undefined, cursor, limit: 30 }),
    envelopeNames(userId),
  ]);
  const href = (t?: string, c?: string) => {
    const q = new URLSearchParams();
    if (t) q.set('type', t);
    if (c) q.set('cursor', c);
    return `/transactions${q.size ? `?${q}` : ''}`;
  };

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{msg.nav.transactions()}</h1>
        <AddButton kind="income" label={msg.quick.actions.income()} />
      </div>
      <nav aria-label="Filter" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link key={f.label} href={href(f.type)} aria-current={type === f.type ? 'page' : undefined}
            className={cn('chip', type === f.type ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'bg-secondary')}>
            {f.label}
          </Link>
        ))}
        <Link href="/transactions/deleted" className="chip bg-secondary">{msg.page.deleted()}</Link>
      </nav>
      {!cursor && res.totals.count > 0 && (
        <p className="text-sm text-muted-foreground">
          {msg.page.spent()}: <Money value={res.totals.spent.toString()} /> · {msg.page.income()}: <Money value={res.totals.income.toString()} />
        </p>
      )}
      {res.items.length === 0 ? (
        <EmptyState title={msg.page.noTx()} />
      ) : (
        <TxRows names={names} items={res.items.map((t) => ({ ...t, amountPaisa: t.amountPaisa.toString() }))} />
      )}
      {res.nextCursor && <Link href={href(type, res.nextCursor)} className="btn-secondary justify-self-center">{msg.page.loadMore()}</Link>}
    </div>
  );
}
