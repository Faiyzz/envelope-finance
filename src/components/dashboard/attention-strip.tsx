'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertCircle, CalendarClock, PauseCircle, ShieldAlert } from 'lucide-react';
import { ATTENTION_MAX } from '@/domain/dashboard/attention';
import { shortDate } from '@/domain/dashboard/labels';
import type { AttentionItem } from '@/domain/dashboard/types';
import { useFormat } from '@/lib/format-context';
import { msg } from '@/messages/en';

const DISMISS_KEY = 'attn_recon_dismissed_until';
const DAY = 24 * 60 * 60 * 1000;

export function AttentionStrip({ items }: { items: AttentionItem[] }) {
  const { fmt } = useFormat();
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Reconciliation nudge is dismissible for 7 days (TD-10 §4.4)
  useEffect(() => {
    try {
      const until = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
      setDismissed(until > Date.now());
    } catch {
      /* storage unavailable */
    }
  }, []);

  const visible = items.filter((i) => !(i.kind === 'recon_stale' && dismissed));
  if (visible.length === 0) return null;
  const shown = expanded ? visible : visible.slice(0, ATTENTION_MAX);
  const more = visible.length - shown.length;

  const dismissRecon = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + 7 * DAY));
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <section aria-label="Needs your attention" className="grid gap-2">
      {shown.map((item, idx) => (
        <div key={idx} className="card-surface flex items-start gap-3 p-4">
          {item.kind === 'needs_attention' && <CalendarClock aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />}
          {item.kind === 'integrity_failed' && <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />}
          {item.kind === 'recon_stale' && <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />}
          {item.kind === 'rule_paused' && <PauseCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1 text-sm">
            {item.kind === 'needs_attention' && (
              <>
                <p>
                  {msg.dash.needsAttention({
                    name: item.ruleName,
                    amount: fmt(item.amount),
                    due: shortDate(item.dueDate),
                    envelope: item.envelopeName ?? 'The envelope',
                    available: item.available ? fmt(item.available) : undefined,
                  })}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link href="/recurring" className="btn-secondary">{msg.action.addMoney()}</Link>
                  <Link href="/recurring" className="btn-secondary">{msg.action.borrow()}</Link>
                  <Link href="/recurring" className="btn-secondary">{msg.action.skip()}</Link>
                </div>
              </>
            )}
            {item.kind === 'integrity_failed' && (
              <>
                <p>{msg.dash.integrityFailed()}</p>
                <Link href="/settings/data" className="btn-secondary mt-2">{msg.nav.settings()}</Link>
              </>
            )}
            {item.kind === 'recon_stale' && (
              <>
                <p>{msg.dash.reconStale({ days: item.days })}</p>
                <div className="mt-2 flex gap-2">
                  <Link href="/reconciliation" className="btn-primary min-h-11">{msg.dash.verifyNow()}</Link>
                  <button type="button" className="btn-secondary" onClick={dismissRecon}>{msg.dash.dismiss()}</button>
                </div>
              </>
            )}
            {item.kind === 'rule_paused' && (
              <>
                <p>{msg.dash.rulePaused({ name: item.ruleName })}</p>
                <Link href="/recurring" className="btn-secondary mt-2">{msg.nav.recurring()}</Link>
              </>
            )}
          </div>
        </div>
      ))}
      {more > 0 && (
        <button type="button" className="btn-secondary justify-self-start" onClick={() => setExpanded(true)}>
          {msg.dash.moreItems({ n: more })}
        </button>
      )}
    </section>
  );
}
