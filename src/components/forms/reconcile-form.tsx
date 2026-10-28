'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { runAction } from '@/app/ui-actions';
import { MoneyInput, parseInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';
import { useWriteGuard } from '@/lib/offline/write-guard';
import { toast } from '@/lib/ui-stores';
import { msg } from '@/messages/en';
import type { ParseResult } from '@/domain/money';

interface Preview { expected: string; actual: string; difference: string; status: 'match' | 'more' | 'less' }

export function ReconcileForm() {
  const router = useRouter();
  const { guardProps } = useWriteGuard();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParseResult>({ ok: false, reason: 'EMPTY' });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [adjust, setAdjust] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());

  async function check(e: React.FormEvent) {
    e.preventDefault();
    if (!parsed.ok) return setError(msg.quick.amountInvalid());
    setBusy(true);
    setError(null);
    const res = await runAction('previewReconciliation', { actual: parsed.value.toString() }).catch(() => null);
    setBusy(false);
    if (res?.ok) setPreview(res.data);
    else setError(res?.ok === false ? res.error.message : msg.quick.offline());
  }

  async function save() {
    if (!preview) return;
    if (adjust && !reason.trim()) return setError(msg.forms.required());
    setBusy(true);
    const res = await runAction('saveReconciliation', {
      idempotencyKey: key.current,
      actual: preview.actual,
      ...(adjust ? { adjustment: { target: 'unallocated', note: reason.trim(), confirmation: true } } : {}),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError(res?.ok === false ? res.error.message : msg.quick.offline());
    toast({ tone: 'success', message: msg.forms.saved() });
    key.current = crypto.randomUUID();
    setPreview(null);
    setText('');
    setAdjust(false);
    setReason('');
    router.refresh();
  }

  return (
    <div className="card-surface grid gap-4 p-5">
      <form onSubmit={check} className="grid gap-3">
        <MoneyInput label={msg.page.actual()} value={text} allowExpression={false}
          onChange={(t) => { setText(t); setPreview(null); setParsed(parseInput(t, false)); }} />
        <button className="btn-secondary" disabled={busy || !parsed.ok}>{msg.page.check()}</button>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {preview && (
        <div className="grid gap-3">
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div><dt className="text-muted-foreground">{msg.page.expected()}</dt><dd><Money value={preview.expected} className="font-semibold" /></dd></div>
            <div><dt className="text-muted-foreground">{msg.page.actual()}</dt><dd><Money value={preview.actual} className="font-semibold" /></dd></div>
            <div><dt className="text-muted-foreground">{msg.page.difference()}</dt><dd><Money value={preview.difference} sign="always" cue className="font-semibold" /></dd></div>
          </dl>
          {preview.status === 'match' ? (
            <p className="text-sm">{msg.page.matches()}</p>
          ) : (
            <>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" className="size-5" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} />
                {msg.page.adjust()}
              </label>
              {adjust && (
                <input aria-label={msg.page.adjustNote()} placeholder={msg.page.adjustNote()} value={reason} onChange={(e) => setReason(e.target.value)}
                  className="h-12 rounded-2xl border bg-background px-4" />
              )}
            </>
          )}
          <button type="button" className="btn-primary" onClick={save} disabled={busy} {...guardProps}>{msg.page.saveCheck()}</button>
        </div>
      )}
    </div>
  );
}
