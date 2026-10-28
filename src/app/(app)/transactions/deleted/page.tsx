import { requireUser } from '@/server/auth/session';
import { listRecentlyDeleted } from '@/server/actions/recently-deleted';
import { envelopeNames } from '@/server/queries/envelope-names';
import { EmptyState } from '@/components/ui/states';
import { TxRows } from '@/components/lists/tx-rows';
import { msg } from '@/messages/en';

export const dynamic = 'force-dynamic';

export default async function DeletedPage() {
  const { userId } = await requireUser();
  const [res, names] = await Promise.all([listRecentlyDeleted.as(userId, {}), envelopeNames(userId)]);
  const items = res.ok ? res.data.transactions : [];
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold">{msg.page.deleted()}</h1>
      {items.length === 0 ? (
        <EmptyState title={msg.page.noTx()} />
      ) : (
        <TxRows mode="restore" names={names} items={items.map((t) => ({ ...t, amountPaisa: String(t.amountPaisa), occurredOn: String(t.occurredOn).slice(0, 10) }))} />
      )}
    </div>
  );
}
