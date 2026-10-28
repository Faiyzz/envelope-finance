import { requireUser } from '@/server/auth/session';
import { listLoans } from '@/server/repositories/loans';
import { EmptyState } from '@/components/ui/states';
import { Money } from '@/components/ui/money';
import { ActionButton } from '@/components/forms/action-form';
import { AddButton } from '@/components/lists/add-button';
import { msg } from '@/messages/en';

export const dynamic = 'force-dynamic';

export default async function LoansPage() {
  const { userId } = await requireUser();
  const loans = await listLoans(userId);
  const groups = [
    { title: msg.page.activeLoans(), items: loans.filter((l) => l.status === 'active') },
    { title: msg.page.paidLoans(), items: loans.filter((l) => l.status === 'paid') },
  ];
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{msg.nav.loans()}</h1>
        <AddButton kind="loan" label={msg.quick.actions.loan()} />
      </div>
      {loans.length === 0 && <EmptyState title={msg.page.noLoans()} />}
      {groups.filter((g) => g.items.length).map((g) => (
        <section key={g.title} className="grid gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground">{g.title}</h2>
          <ul className="card-surface divide-y">
            {g.items.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-medium">{l.borrower.icon} {l.borrower.name} → {l.lender.icon} {l.lender.name}</p>
                  <p className="text-sm text-muted-foreground">{l.loanDate}{l.note && ` · ${l.note}`}</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-end">
                    <Money value={l.remaining.toString()} className="font-semibold" />
                    <p className="text-xs text-muted-foreground">{msg.page.remaining()} / <Money value={l.original.toString()} currency={false} /></p>
                  </div>
                  {l.status === 'active' && (
                    <ActionButton action="repayAll" label={msg.page.repayAll()} confirm
                      input={{ borrowerEnvelopeId: l.borrower.id, lenderEnvelopeId: l.lender.id }} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
