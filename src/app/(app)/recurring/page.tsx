import { requireUser } from '@/server/auth/session';
import { getUpcoming, listRules } from '@/server/repositories/recurring';
import { EmptyState } from '@/components/ui/states';
import { Money } from '@/components/ui/money';
import { ActionButton } from '@/components/forms/action-form';
import { AddButton } from '@/components/lists/add-button';
import { CommitteeForm } from '@/components/quick-add/other-forms';
import { msg } from '@/messages/en';

export const dynamic = 'force-dynamic';

export default async function RecurringPage() {
  const { userId } = await requireUser();
  const [rules, upcoming] = await Promise.all([listRules(userId), getUpcoming(userId)]);
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{msg.nav.recurring()}</h1>
        <AddButton kind="recurring" label={msg.quick.actions.recurring()} />
      </div>

      {upcoming.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{msg.page.upcoming()}</h2>
          <ul className="card-surface divide-y">
            {upcoming.map((u) => (
              <li key={`${u.ruleId}-${u.dueDate}`} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-medium">{u.ruleName}</p>
                  <p className="text-sm text-muted-foreground">{u.dueDate}{u.status === 'needs_attention' && ` · ${msg.page.attention()}`}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Money value={u.amountPaisa.toString()} className="font-semibold" />
                  {u.status === 'needs_attention' && (
                    <>
                      <ActionButton action="retryOccurrence" input={{ occurrenceId: u.id }} label={msg.page.retry()} />
                      <ActionButton action="skipOccurrence" input={{ occurrenceId: u.id }} label={msg.page.skip()} />
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="grid gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">{msg.page.rules()}</h2>
        {rules.length === 0 ? (
          <EmptyState title={msg.page.noRules()} />
        ) : (
          <ul className="card-surface divide-y">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-medium">{r.name}{r.isCommittee && ' 🤝'}</p>
                  <p className="text-sm capitalize text-muted-foreground">{r.frequency} · {r.status}{r.envelopeName && ` · ${r.envelopeName}`}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Money value={r.amountPaisa.toString()} className="font-semibold" />
                  {r.status === 'active' && <ActionButton action="pauseRule" input={{ ruleId: r.id }} label={msg.page.pause()} />}
                  {r.status === 'paused' && <ActionButton action="resumeRule" input={{ ruleId: r.id }} label={msg.page.resume()} />}
                  {(r.status === 'active' || r.status === 'paused') && <ActionButton action="endRule" input={{ ruleId: r.id }} label={msg.page.end()} confirm />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="card-surface p-4">
        <summary className="min-h-11 cursor-pointer font-medium">{msg.forms.committee()}</summary>
        <div className="pt-3"><CommitteeForm /></div>
      </details>
    </div>
  );
}
