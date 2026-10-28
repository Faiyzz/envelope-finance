'use client';

/** Quick-add forms other than expense: thin field configs over <ActionForm>. */

import { useEffect, useState } from 'react';
import { loadFormOptions, type FormOptions } from '@/app/ui-actions';
import { ActionForm, type Field } from '@/components/forms/action-form';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { msg } from '@/messages/en';

const f = msg.forms;
const opts = <T extends { id: string }>(xs: T[], label: (x: T) => string) => xs.map((x) => ({ value: x.id, label: label(x) }));

export function useFormOptions() {
  const [data, setData] = useState<FormOptions | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void loadFormOptions().then((r) => (r.ok ? setData(r.data) : setFailed(true))).catch(() => setFailed(true));
  }, []);
  return { data, failed };
}

const common: Field[] = [
  { name: 'date', label: f.date(), type: 'date' },
  { name: 'note', label: f.note(), type: 'text' },
];

export type OtherKind = 'income' | 'allocate' | 'transfer' | 'loan' | 'repay' | 'envelope' | 'recurring' | 'held_in' | 'held_out';

export function OtherForm({ kind, onDone }: { kind: OtherKind; onDone: () => void }) {
  const { data, failed } = useFormOptions();
  if (failed) return <ErrorState />;
  if (!data) return <Skeleton className="h-48" />;
  return <Built kind={kind} o={data} onDone={onDone} />;
}

function Built({ kind, o, onDone }: { kind: OtherKind; o: FormOptions; onDone: () => void }) {
  const mine = opts(o.envelopes.filter((e) => e.ownerType === 'mine'), (e) => `${e.icon} ${e.name}`);
  const held = opts(o.envelopes.filter((e) => e.ownerType === 'other'), (e) => `${e.icon} ${e.name}`);
  const amount: Field = { name: 'amount', label: f.amount(), type: 'money', required: true };
  const p = { onDone };

  switch (kind) {
    case 'income':
      return (
        <ActionForm action="createIncome" submitLabel={f.record()} {...p}
          fields={[amount, { name: 'categoryId', label: f.category(), type: 'select', options: opts(o.incomeCategories, (c) => c.name), empty: msg.dash.unallocated() },
            { name: 'envelopeId', label: f.envelope(), type: 'select', options: mine, empty: msg.dash.unallocated() }, ...common]}
          transform={({ envelopeId, ...rest }) => ({ ...rest, ...(envelopeId ? { splits: [{ envelopeId, amount: rest.amount }] } : {}) })} />
      );
    case 'allocate':
      return <ActionForm action="allocate" submitLabel={f.add()} {...p} fields={[amount, { name: 'toEnvelopeId', label: f.to(), type: 'select', options: mine, required: true }, ...common]} />;
    case 'transfer':
      return (
        <ActionForm action="transfer" submitLabel={f.move()} {...p}
          fields={[amount, { name: 'fromEnvelopeId', label: f.from(), type: 'select', options: mine, required: true },
            { name: 'toEnvelopeId', label: f.to(), type: 'select', options: mine, required: true }, ...common]} />
      );
    case 'loan':
      return (
        <ActionForm action="createLoan" submitLabel={f.create()} {...p}
          fields={[amount, { name: 'lenderEnvelopeId', label: f.lender(), type: 'select', options: mine, required: true },
            { name: 'borrowerEnvelopeId', label: f.borrower(), type: 'select', options: mine, required: true }, ...common]} />
      );
    case 'repay':
      return (
        <ActionForm action="repayLoan" submitLabel={f.repay()} {...p}
          fields={[{ name: 'loanId', label: f.loan(), type: 'select', options: o.loans.map((l) => ({ value: l.id, label: l.label })), required: true }, amount,
            { name: 'date', label: f.date(), type: 'date' }]} />
      );
    case 'envelope':
      return (
        <ActionForm action="createEnvelope" submitLabel={f.create()} {...p}
          fields={[{ name: 'name', label: f.name(), type: 'text', required: true },
            { name: 'ownerType', label: f.owner(), type: 'select', initial: 'mine', options: [{ value: 'mine', label: f.mine() }, { value: 'other', label: f.other() }] },
            { name: 'ownerName', label: f.ownerName(), type: 'text' },
            { name: 'kind', label: f.kind(), type: 'select', initial: 'standard', options: [{ value: 'standard', label: f.standard() }, { value: 'savings', label: f.savings() }] },
            { name: 'goalAmount', label: f.goal(), type: 'money' },
            { name: 'initialFunding', label: `${f.amount()} (${msg.dash.unallocated()})`, type: 'money' }]}
          transform={({ initialFunding, ...rest }) => ({ ...rest, ownerType: rest.ownerType ?? 'mine', kind: rest.kind ?? 'standard',
            ...(initialFunding ? { initialFunding: { amount: initialFunding, source: 'unallocated' } } : {}) })} />
      );
    case 'recurring':
      return (
        <ActionForm action="createRule" submitLabel={f.create()} {...p}
          fields={[{ name: 'name', label: f.name(), type: 'text', required: true },
            { name: 'type', label: f.ruleType(), type: 'select', initial: 'expense', options: [{ value: 'expense', label: f.expense() }, { value: 'income', label: f.income() }] },
            amount,
            { name: 'envelopeId', label: f.envelope(), type: 'select', options: mine },
            { name: 'categoryId', label: f.category(), type: 'select', required: true,
              options: [...opts(o.expenseCategories, (c) => `${c.name} (${f.expense()})`), ...opts(o.incomeCategories, (c) => `${c.name} (${f.income()})`)] },
            { name: 'frequency', label: f.frequency(), type: 'select', initial: 'monthly', options: [{ value: 'weekly', label: f.weekly() }, { value: 'monthly', label: f.monthly() }, { value: 'yearly', label: f.yearly() }] },
            { name: 'startDate', label: f.startDate(), type: 'date', required: true }]}
          transform={(v) => ({ ...v, type: v.type ?? 'expense', frequency: v.frequency ?? 'monthly' })} />
      );
    case 'held_in':
    case 'held_out':
      return (
        <ActionForm action={kind === 'held_in' ? 'recordHeldMoney' : 'returnHeldMoney'} submitLabel={f.record()} {...p}
          fields={[amount, { name: 'envelopeId', label: f.envelope(), type: 'select', options: held, required: true }, ...common]} />
      );
  }
}

export function CommitteeForm({ onDone }: { onDone?: () => void }) {
  const { data, failed } = useFormOptions();
  if (failed) return <ErrorState />;
  if (!data) return <Skeleton className="h-48" />;
  return (
    <ActionForm action="createCommittee" submitLabel={f.create()} onDone={onDone}
      fields={[{ name: 'name', label: f.name(), type: 'text', required: true },
        { name: 'monthlyAmount', label: f.amount(), type: 'money', required: true },
        { name: 'months', label: f.months(), type: 'number', required: true },
        { name: 'envelopeId', label: f.envelope(), type: 'select', required: true, options: opts(data.envelopes.filter((e) => e.ownerType === 'mine'), (e) => `${e.icon} ${e.name}`) },
        { name: 'startDate', label: f.startDate(), type: 'date', required: true }]} />
  );
}
