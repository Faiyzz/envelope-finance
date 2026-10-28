'use client';

/**
 * Config-driven form + row-action button for server actions (runAction).
 * Money fields accept `1200+350`, are parsed to paisa strings, and every
 * submit attempt carries a fresh-per-edit idempotency key.
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { runAction, type ActionName } from '@/app/ui-actions';
import { MoneyInput, parseInput } from '@/components/ui/money-input';
import { useWriteGuard } from '@/lib/offline/write-guard';
import { toast } from '@/lib/ui-stores';
import { msg } from '@/messages/en';
import { cn } from '@/lib/cn';

export type Field =
  | { name: string; label: string; type: 'money'; required?: boolean }
  | { name: string; label: string; type: 'text' | 'date' | 'number'; required?: boolean; initial?: string }
  | { name: string; label: string; type: 'select'; options: Array<{ value: string; label: string }>; required?: boolean; initial?: string; empty?: string }
  | { name: string; label: string; type: 'checkbox'; initial?: boolean };

type Values = Record<string, string | boolean>;

const INPUT = 'h-12 w-full rounded-2xl border bg-background px-4';

function initialValues(fields: Field[]): Values {
  return Object.fromEntries(fields.map((f) => [f.name, f.type === 'checkbox' ? !!f.initial : f.type === 'money' ? '' : f.initial ?? '']));
}

export function ActionForm({
  action,
  fields,
  submitLabel = msg.general.save(),
  successMessage,
  transform,
  onDone,
}: {
  action: ActionName;
  fields: Field[];
  submitLabel?: string;
  successMessage?: string;
  /** Maps parsed values (money as paisa strings, '' omitted) to the action input. */
  transform?: (v: Record<string, any>) => Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  onDone?: () => void;
}) {
  const router = useRouter();
  const { guardProps } = useWriteGuard();
  const [values, setValues] = useState<Values>(() => initialValues(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());

  const set = (name: string, v: string | boolean) => {
    key.current = crypto.randomUUID();
    setValues((prev) => ({ ...prev, [name]: v }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const out: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    const errs: Record<string, string> = {};
    for (const f of fields) {
      const raw = values[f.name];
      if (f.type === 'checkbox') out[f.name] = raw === true;
      else if (typeof raw === 'string' && raw.trim() !== '') {
        if (f.type === 'money') {
          const p = parseInput(raw, true);
          if (p.ok) out[f.name] = p.value.toString();
          else errs[f.name] = msg.quick.amountInvalid();
        } else out[f.name] = f.type === 'number' ? Number(raw) : raw.trim();
      } else if ('required' in f && f.required) errs[f.name] = msg.forms.required();
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setBusy(true);
    setFormError(null);
    const input = { idempotencyKey: key.current, ...(transform ? transform(out) : out) };
    const res = await runAction(action, input).catch(() => null);
    setBusy(false);
    if (!res) return setFormError(msg.quick.offline());
    if (!res.ok) {
      setErrors(res.error.fieldErrors ?? {});
      return setFormError(res.error.message);
    }
    toast({ tone: 'success', message: successMessage ?? msg.forms.saved() });
    key.current = crypto.randomUUID();
    setValues(initialValues(fields));
    router.refresh();
    onDone?.();
  }

  return (
    <form onSubmit={submit} className="grid gap-4 pb-2" noValidate>
      {fields.map((f) => {
        const err = errors[f.name];
        const id = `f-${f.name}`;
        if (f.type === 'money')
          return (
            <div key={f.name}>
              <MoneyInput label={f.label} value={values[f.name] as string} testId={id} invalid={!!err} onChange={(t) => set(f.name, t)} />
              {err && <p className="mt-1 text-sm text-destructive">{err}</p>}
            </div>
          );
        if (f.type === 'checkbox')
          return (
            <label key={f.name} className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" checked={values[f.name] === true} onChange={(e) => set(f.name, e.target.checked)} className="size-5" />
              {f.label}
            </label>
          );
        return (
          <label key={f.name} htmlFor={id} className="grid gap-1 text-sm font-medium">
            {f.label}
            {f.type === 'select' ? (
              <select id={id} className={INPUT} value={values[f.name] as string} onChange={(e) => set(f.name, e.target.value)} aria-invalid={!!err}>
                <option value="">{f.empty ?? msg.forms.choose()}</option>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input id={id} type={f.type} className={INPUT} value={values[f.name] as string} onChange={(e) => set(f.name, e.target.value)} aria-invalid={!!err} />
            )}
            {err && <span className="text-sm font-normal text-destructive">{err}</span>}
          </label>
        );
      })}
      {formError && <p role="alert" className="rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-sm">{formError}</p>}
      <button type="submit" className="btn-primary" disabled={busy} {...guardProps}>{busy ? msg.general.loading() : submitLabel}</button>
    </form>
  );
}

/** One-click row action; destructive ones need a second tap. */
export function ActionButton({
  action,
  input,
  label,
  confirm,
  className,
  successMessage,
}: {
  action: ActionName;
  input: Record<string, unknown>;
  label: string;
  confirm?: boolean;
  className?: string;
  successMessage?: string;
}) {
  const router = useRouter();
  const { guardProps } = useWriteGuard();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function go() {
    if (confirm && !armed) return setArmed(true);
    setBusy(true);
    const res = await runAction(action, { idempotencyKey: crypto.randomUUID(), ...input }).catch(() => null);
    setBusy(false);
    setArmed(false);
    if (res?.ok) {
      if (successMessage) toast({ tone: 'success', message: successMessage });
      router.refresh();
    } else toast({ tone: 'error', message: res?.ok === false ? res.error.message : msg.quick.offline() });
  }

  return (
    <button type="button" onClick={go} disabled={busy} {...guardProps} className={cn('btn-secondary', armed && 'border-destructive text-destructive', className)}>
      {armed ? msg.forms.sure({ label }) : label}
    </button>
  );
}
