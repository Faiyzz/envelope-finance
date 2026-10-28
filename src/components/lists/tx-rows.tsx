'use client';

import { Money } from '@/components/ui/money';
import { ActionButton } from '@/components/forms/action-form';
import { msg } from '@/messages/en';

export interface TxItem {
  id: string;
  type: string;
  amountPaisa: string;
  occurredOn: string;
  envelopeId: string | null;
  counterpartEnvelopeId: string | null;
  note: string | null;
}

const INFLOW = new Set(['income', 'opening_balance', 'external_deposit', 'allocation']);
const label = (t: string) => t.replace(/_/g, ' ');

export function TxRows({ items, names, mode = 'delete' }: { items: TxItem[]; names: Record<string, string>; mode?: 'delete' | 'restore' | 'none' }) {
  return (
    <ul className="card-surface divide-y" data-testid="tx-list">
      {items.map((t) => {
        const from = t.envelopeId ? names[t.envelopeId] : null;
        const to = t.counterpartEnvelopeId ? names[t.counterpartEnvelopeId] : null;
        return (
          <li key={t.id} className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="truncate font-medium capitalize">{label(t.type)}{from && ` · ${from}`}{to && ` → ${to}`}</p>
              <p className="truncate text-sm text-muted-foreground">{t.occurredOn}{t.note && ` · ${t.note}`}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Money value={t.amountPaisa} sign={INFLOW.has(t.type) ? 'always' : 'auto'} className="font-semibold" />
              {mode === 'delete' && <ActionButton action="deleteTransaction" input={{ id: t.id }} label={msg.general.delete()} confirm successMessage={msg.page.deleted()} />}
              {mode === 'restore' && <ActionButton action="restoreTransaction" input={{ transactionId: t.id }} label={msg.page.restore()} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
