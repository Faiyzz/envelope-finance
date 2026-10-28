import { requireUser } from '@/server/auth/session';
import { getEnvelopeList } from '@/server/repositories/envelopes';
import { EnvelopeCard } from '@/components/dashboard/envelope-card';
import { EmptyState } from '@/components/ui/states';
import { AddButton } from '@/components/lists/add-button';
import { msg } from '@/messages/en';

export const dynamic = 'force-dynamic';

export default async function EnvelopesPage() {
  const { userId } = await requireUser();
  const list = await getEnvelopeList(userId, { includeArchived: true });
  const dto = (e: (typeof list)[number]) => ({
    ...e,
    balance: e.balance.toString(), borrowed: e.borrowed.toString(), loanedOut: e.loanedOut.toString(), ownFunds: e.ownFunds.toString(),
    goal: undefined, loanChips: [],
  });
  const groups = [
    { title: msg.page.owned(), items: list.filter((e) => e.status === 'active' && e.ownerType === 'mine') },
    { title: msg.page.held(), items: list.filter((e) => e.status === 'active' && e.ownerType === 'other') },
    { title: msg.page.archived(), items: list.filter((e) => e.status === 'archived') },
  ];
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{msg.nav.envelopes()}</h1>
        <AddButton kind="envelope" label={msg.quick.actions.envelope()} />
      </div>
      {list.length === 0 && <EmptyState title={msg.page.noEnvelopes()} />}
      {groups.filter((g) => g.items.length).map((g) => (
        <section key={g.title} className="grid gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground">{g.title}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((e) => <EnvelopeCard key={e.id} e={dto(e) as never} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
