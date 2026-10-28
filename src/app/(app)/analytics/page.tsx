import Link from 'next/link';
import { requireUser } from '@/server/auth/session';
import { getAnalyticsData } from '@/server/actions/analytics';
import { Money } from '@/components/ui/money';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import { msg } from '@/messages/en';

export const dynamic = 'force-dynamic';

const RANGES = ['this_month', 'prev_month', 'last_3', 'last_6', 'last_12'] as const;
type RangeKey = (typeof RANGES)[number];
const RANGE_LABEL: Record<RangeKey, string> = { this_month: 'This month', prev_month: 'Last month', last_3: '3 months', last_6: '6 months', last_12: '12 months' };

function Bars({ rows }: { rows: Array<{ key: string; name: string; amount: string; pct: number }> }) {
  return (
    <ul className="card-surface grid gap-3 p-4">
      {rows.map((r) => (
        <li key={r.key} className="grid gap-1">
          <div className="flex justify-between gap-3 text-sm">
            <span className="truncate">{r.name}</span>
            <span className="shrink-0"><Money value={r.amount} className="font-medium" /> · {r.pct}%</span>
          </div>
          <div role="presentation" className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${Math.min(100, r.pct)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const raw = (await searchParams).range;
  const range: RangeKey = RANGES.includes(raw as RangeKey) ? (raw as RangeKey) : 'this_month';
  const { userId } = await requireUser();
  const res = await getAnalyticsData.as(userId, { range });

  return (
    <div className="grid gap-5">
      <h1 className="text-2xl font-bold">{msg.nav.analytics()}</h1>
      <nav aria-label="Range" className="flex flex-wrap gap-2">
        {RANGES.map((r) => (
          <Link key={r} href={`/analytics?range=${r}`} aria-current={r === range ? 'page' : undefined}
            className={cn('chip', r === range ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'bg-secondary')}>
            {RANGE_LABEL[r]}
          </Link>
        ))}
      </nav>
      {!res.ok ? (
        <ErrorState body={res.error.message} />
      ) : res.data.summary.spent === '0' && res.data.summary.income === '0' ? (
        <EmptyState title={msg.page.noData()} />
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-3">
            {([[msg.page.spent(), res.data.summary.spent], [msg.page.income(), res.data.summary.income], [msg.page.net(), res.data.summary.net]] as const).map(([k, v]) => (
              <div key={k} className="card-surface p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd><Money value={v} className="font-semibold" /></dd></div>
            ))}
          </dl>
          {res.data.byCategory.length > 0 && (
            <section className="grid gap-2">
              <h2 className="text-sm font-semibold text-muted-foreground">{msg.page.byCategory()}</h2>
              <Bars rows={res.data.byCategory.map((c) => ({ key: c.categoryId ?? c.name, name: c.name, amount: c.amount, pct: c.pct }))} />
            </section>
          )}
          {res.data.byEnvelope.length > 0 && (
            <section className="grid gap-2">
              <h2 className="text-sm font-semibold text-muted-foreground">{msg.page.byEnvelope()}</h2>
              <Bars rows={res.data.byEnvelope.map((e) => ({ key: e.envelopeId, name: `${e.icon} ${e.name}`, amount: e.amount, pct: e.pct }))} />
            </section>
          )}
          {res.data.topExpenses.length > 0 && (
            <section className="grid gap-2">
              <h2 className="text-sm font-semibold text-muted-foreground">{msg.page.topExpenses()}</h2>
              <ul className="card-surface divide-y">
                {res.data.topExpenses.map((t) => (
                  <li key={t.txId} className="flex justify-between gap-3 p-4">
                    <span className="min-w-0 truncate">{t.categoryName} · {t.envelopeName}<span className="block text-sm text-muted-foreground">{t.date}</span></span>
                    <Money value={t.amount} className="font-semibold" />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
