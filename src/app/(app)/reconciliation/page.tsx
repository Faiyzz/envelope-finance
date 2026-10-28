import { requireUser } from '@/server/auth/session';
import { getReconciliationHistory } from '@/server/repositories/reconciliation';
import { ReconcileForm } from '@/components/forms/reconcile-form';
import { Money } from '@/components/ui/money';
import { EmptyState } from '@/components/ui/states';
import { msg } from '@/messages/en';

export const dynamic = 'force-dynamic';

export default async function ReconciliationPage() {
  const { userId } = await requireUser();
  const { items } = await getReconciliationHistory(userId, { limit: 20 });
  return (
    <div className="grid gap-5">
      <h1 className="text-2xl font-bold">{msg.nav.reconciliation()}</h1>
      <ReconcileForm />
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">{msg.page.history()}</h2>
        {items.length === 0 ? (
          <EmptyState title={msg.page.noHistory()} />
        ) : (
          <ul className="card-surface divide-y">
            {items.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-medium">{r.statusIcon === 'check' ? '✓' : '⚠'} {String(r.checkedOn).slice(0, 10)}</p>
                  {r.note && <p className="truncate text-sm text-muted-foreground">{r.note}</p>}
                </div>
                <div className="text-end">
                  <Money value={r.actual.toString()} className="font-semibold" />
                  {r.difference !== 0n && <p className="text-xs"><Money value={r.difference.toString()} sign="always" cue /></p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
