import { requireUser } from '@/server/auth/session';
import { globalSearch } from '@/server/actions/search';
import { envelopeNames } from '@/server/queries/envelope-names';
import { EmptyState } from '@/components/ui/states';
import { TxRows } from '@/components/lists/tx-rows';
import Link from 'next/link';
import { msg } from '@/messages/en';

export const dynamic = 'force-dynamic';

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? '').trim();
  const { userId } = await requireUser();
  const res = q.length >= 2 ? await globalSearch.as(userId, { q }) : null;
  const names = res?.ok ? await envelopeNames(userId) : {};
  const data = res?.ok ? res.data : null;
  const empty = data && !data.envelopes.length && !data.transactions.length;

  return (
    <div className="grid gap-5">
      <h1 className="text-2xl font-bold">{msg.nav.search()}</h1>
      <form role="search" className="flex gap-2">
        <input name="q" defaultValue={q} placeholder={msg.page.searchPlaceholder()} aria-label={msg.nav.search()} className="h-12 min-w-0 flex-1 rounded-2xl border bg-background px-4" />
        <button className="btn-primary">{msg.nav.search()}</button>
      </form>
      {!data && <p className="text-sm text-muted-foreground">{msg.page.searchHint()}</p>}
      {res && !res.ok && <p role="alert">{res.error.message}</p>}
      {empty && <EmptyState title={msg.page.noResults()} />}
      {data && data.envelopes.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{msg.nav.envelopes()}</h2>
          <ul className="card-surface divide-y">
            {data.envelopes.map((e) => (
              <li key={e.id}><Link href={`/envelopes/${e.id}`} className="block min-h-12 p-4 font-medium">{e.name}</Link></li>
            ))}
          </ul>
        </section>
      )}
      {data && data.transactions.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{msg.nav.transactions()}</h2>
          <TxRows mode="none" names={names}
            items={data.transactions.map((t) => ({ id: t.id, type: t.type, amountPaisa: t.amountPaisa.toString(), occurredOn: String(t.occurredOn), envelopeId: null, counterpartEnvelopeId: null, note: [t.envelopeName, t.note].filter(Boolean).join(' · ') || null }))} />
        </section>
      )}
    </div>
  );
}
