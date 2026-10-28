'use client';

/**
 * Quick expense - TD-10 §5.2 / §5.3.
 *
 * Keypad-first. Defaults come from the server (last-used envelope/category).
 * Optimistic: the expense is painted onto visible balances immediately via
 * `usePending`, then reconciled with the authoritative server refresh, or
 * rolled back on failure with the form state kept.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { msg } from '@/messages/en';
import { MoneyInput, parseInput } from '@/components/ui/money-input';
import { ErrorState, Skeleton, EmptyState } from '@/components/ui/states';
import { Money } from '@/components/ui/money';
import { loadQuickAdd, submitExpense, undoTransaction } from '@/app/actions';
import type { QuickAddData } from '@/server/queries/quick-add';
import { orderCategories } from '@/domain/transactions/category-order';
import { addDays, type LocalDate } from '@/domain/dates';
import type { ParseResult } from '@/domain/money';
import { cn } from '@/lib/cn';
import { toast, useDirty, useLive, usePending } from '@/lib/ui-stores';
import { useFormat } from '@/lib/format-context';
import { useWriteGuard } from '@/lib/offline/write-guard';

type DateMode = 'today' | 'yesterday' | 'pick';
interface FormError {
  code: string;
  message: string;
  actions?: Array<{ kind: string; label: string }>;
}

export function ExpenseForm({ onDone }: { onDone: () => void }) {
  const [data, setData] = useState<QuickAddData | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    const res = await loadQuickAdd().catch(() => null);
    if (res?.ok) setData(res.data);
    else setLoadError(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) return <ErrorState onRetry={load} />;
  if (!data) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <Skeleton className="h-16" />
        <Skeleton className="h-20" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (data.envelopes.length === 0) {
    return (
      <EmptyState
        title={msg.dash.emptyEnvelopesTitle()}
        body={msg.quick.noEnvelopes()}
        cta={<Link href="/?add=envelope" className="btn-primary">{msg.nav.add()}</Link>}
      />
    );
  }
  return <Form data={data} onDone={onDone} />;
}

function Form({ data, onDone }: { data: QuickAddData; onDone: () => void }) {
  const router = useRouter();
  const { fmt } = useFormat();
  const { guardProps } = useWriteGuard();
  const announce = useLive((s) => s.announce);
  const pending = usePending();

  const [amountText, setAmountText] = useState('');
  const [parsed, setParsed] = useState<ParseResult>({ ok: false, reason: 'EMPTY' });
  const [touched, setTouched] = useState(false);
  const [envelopeId, setEnvelopeId] = useState(
    data.lastEnvelopeId && data.envelopes.some((e) => e.id === data.lastEnvelopeId)
      ? data.lastEnvelopeId
      : data.envelopes[0]!.id
  );
  const envelope = data.envelopes.find((e) => e.id === envelopeId)!;

  const ordered = useMemo(
    () => orderCategories(data.categories.map((c) => ({ ...c })), envelope.name, data.recentByEnvelope[envelopeId] ?? []),
    [data, envelope.name, envelopeId]
  );
  const defaultCategory = data.recentByEnvelope[envelopeId]?.[0] ?? null;
  const [categoryId, setCategoryId] = useState<string | null>(defaultCategory);
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [catQuery, setCatQuery] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [note, setNote] = useState('');
  const [dateMode, setDateMode] = useState<DateMode>('today');
  const [pickedDate, setPickedDate] = useState<string>(data.today);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  // Unsaved input blocks silent app updates (TD-12 §6)
  const dirty = amountText.trim() !== '' || note.trim() !== '';
  useEffect(() => {
    if (!dirty) return;
    useDirty.getState().inc();
    return () => useDirty.getState().dec();
  }, [dirty]);

  // One idempotency key per submit attempt; a new one when the inputs change
  const keyRef = useRef(crypto.randomUUID());
  const resetKey = () => {
    keyRef.current = crypto.randomUUID();
  };

  // Category follows the envelope's last-used default until the user chooses one
  useEffect(() => {
    if (!categoryTouched) setCategoryId(data.recentByEnvelope[envelopeId]?.[0] ?? null);
  }, [envelopeId, categoryTouched, data.recentByEnvelope]);

  const date: string = dateMode === 'today' ? data.today : dateMode === 'yesterday' ? addDays(data.today as LocalDate, -1) : pickedDate;

  const amount = parsed.ok ? parsed.value : null;
  const available = BigInt(envelope.balance);
  const insufficient = amount !== null && amount > available;
  const amountInvalid = touched && amountText.trim() !== '' && !parsed.ok;
  const canSave = amount !== null && !insufficient && !busy && date <= data.today;

  const filtered = ordered.filter((c) => c.name.toLowerCase().includes(catQuery.trim().toLowerCase()));
  const categoryName = data.categories.find((c) => c.id === categoryId)?.name ?? 'Uncategorized';

  async function save(another: boolean, confirmDuplicate = false) {
    if (!canSave || amount === null) return;
    if (!navigator.onLine) {
      setError({ code: 'INTERNAL', message: msg.quick.offline() });
      return;
    }
    setBusy(true);
    setError(null);
    setDuplicate(false);

    const key = keyRef.current;
    const paisaStr = amount.toString();
    pending.add({ key, envelopeId, amount: paisaStr, label: categoryName, occurredOn: date });

    const res = await submitExpense({
      idempotencyKey: key,
      amount: paisaStr,
      envelopeId,
      categoryId,
      note: note.trim() || undefined,
      date,
      confirmDuplicate: confirmDuplicate || undefined,
    }).catch(() => null);

    if (!res) {
      pending.remove(key); // rollback
      setError({ code: 'INTERNAL', message: msg.quick.offline() });
      setBusy(false);
      return;
    }
    if (!res.ok) {
      pending.remove(key); // rollback, keep the form populated
      if (res.error.code === 'DUPLICATE_SUSPECTED') {
        setDuplicate(true);
        resetKey(); // a deliberate re-submit is a new attempt
      } else {
        setError(res.error);
      }
      setBusy(false);
      return;
    }

    // Success: show confirmation, then refresh server data and drop the optimistic copy
    const txId = res.data.id;
    navigator.vibrate?.(10);
    setJustSaved(true);
    announce(`${envelope.name} is now ${fmt(available - amount)}`);
    toast({
      tone: 'success',
      message: msg.quick.saved({ amount: fmt(amount, { currency: false }), envelope: envelope.name }),
      undo: async () => {
        const u = await undoTransaction(txId);
        if (u.ok) {
          toast({ tone: 'info', message: msg.quick.undone() });
        } else {
          toast({ tone: 'error', message: msg.quick.undoFailed({ reason: u.error.message }) });
        }
        router.refresh();
      },
    });
    router.refresh();
    // drop the optimistic row once fresh data has had a moment to arrive
    setTimeout(() => pending.remove(key), 1200);
    resetKey();

    if (another) {
      setAmountText('');
      setParsed({ ok: false, reason: 'EMPTY' });
      setTouched(false);
      setNote('');
      setBusy(false);
      setTimeout(() => setJustSaved(false), 900);
    } else {
      setTimeout(onDone, 450);
    }
  }

  const unchangedOnEdit = <T,>(setter: (v: T) => void) => (v: T) => {
    resetKey();
    setError(null);
    setDuplicate(false);
    setter(v);
  };

  const errMsg = error?.message ?? null;
  const errActions = error?.actions;

  return (
    <form
      className="grid gap-5 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      {/* 1. Amount */}
      <div>
        <MoneyInput
          autoFocus
          label={msg.quick.amount()}
          value={amountText}
          invalid={amountInvalid}
          describedBy="amount-hint"
          onChange={unchangedOnEdit((t: string) => {
            setAmountText(t);
            setTouched(true);
            setParsed(parseInput(t, true));
          })}
        />
        <p id="amount-hint" aria-live="polite" className={cn('mt-1 min-h-5 text-sm', amountInvalid ? 'text-destructive' : 'text-muted-foreground')}>
          {amountInvalid ? msg.quick.amountInvalid() : parsed.ok && /\+/.test(amountText) ? <Money value={parsed.value} /> : msg.quick.amountHint()}
        </p>
      </div>

      {/* 2. Envelope */}
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{msg.quick.envelope()}</legend>
        <div role="radiogroup" className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
          {data.envelopes.map((e) => {
            const bal = BigInt(e.balance);
            const selected = e.id === envelopeId;
            return (
              <button
                key={e.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => unchangedOnEdit(setEnvelopeId)(e.id)}
                className={cn(
                  'flex min-h-16 min-w-28 shrink-0 flex-col items-start justify-center rounded-2xl border px-3 text-start',
                  selected ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'bg-secondary'
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <span aria-hidden="true">{e.icon}</span>
                  {e.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {bal === 0n ? msg.quick.zeroLeft() : <Money value={bal} currency={false} />}
                </span>
              </button>
            );
          })}
        </div>
        {envelope.ownerType === 'other' && envelope.ownerName && (
          <p className="mt-1 text-sm text-muted-foreground">{msg.quick.heldHint({ owner: envelope.ownerName })}</p>
        )}
      </fieldset>

      {insufficient && (
        <div role="alert" className="rounded-2xl border border-warning/50 bg-warning/10 p-3 text-sm">
          <p className="font-medium">{msg.quick.insufficient({ envelope: envelope.name, available: fmt(available) })}</p>
          {envelope.ownerType === 'mine' && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Link href="/?add=allocate" className="btn-secondary">{msg.action.addMoney()}</Link>
              <Link href="/?add=loan" className="btn-secondary">{msg.action.borrow()}</Link>
            </div>
          )}
        </div>
      )}

      {/* 3. Category */}
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{msg.quick.category()}</legend>
        <input
          type="search"
          value={catQuery}
          onChange={(e) => setCatQuery(e.target.value)}
          placeholder={msg.quick.categorySearch()}
          aria-label={msg.quick.categorySearch()}
          className="mb-2 h-11 w-full rounded-2xl border bg-background px-4"
        />
        <div role="radiogroup" aria-label={msg.quick.category()} className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
          {filtered.length === 0 && <p className="text-sm text-muted-foreground">{msg.quick.noCategoryMatch()}</p>}
          {filtered.map((c) => {
            const selected = c.id === categoryId;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  resetKey();
                  setCategoryTouched(true);
                  setCategoryId(c.id);
                }}
                className={cn('chip', selected ? 'border-primary bg-primary/10 font-semibold ring-2 ring-primary' : 'bg-secondary')}
              >
                {selected && <Check aria-hidden="true" className="size-4" />}
                {c.name}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* 4. Note & date */}
      <div>
        <button
          type="button"
          aria-expanded={showMore}
          onClick={() => setShowMore((v) => !v)}
          className="min-h-11 text-sm font-medium text-primary"
        >
          {msg.quick.notesAndDate()}
        </button>
        {showMore && (
          <div className="mt-2 grid gap-3">
            <div role="radiogroup" aria-label={msg.quick.date()} className="flex flex-wrap gap-2">
              {(['today', 'yesterday', 'pick'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={dateMode === m}
                  onClick={() => {
                    resetKey();
                    setDateMode(m);
                  }}
                  className={cn('chip', dateMode === m ? 'border-primary bg-primary/10 ring-2 ring-primary' : 'bg-secondary')}
                >
                  {m === 'today' ? msg.quick.dateToday() : m === 'yesterday' ? msg.quick.dateYesterday() : msg.quick.datePick()}
                </button>
              ))}
            </div>
            {dateMode === 'pick' && (
              <input
                type="date"
                aria-label={msg.quick.date()}
                min="2000-01-01"
                max={data.today}
                value={pickedDate}
                onChange={(e) => {
                  resetKey();
                  setPickedDate(e.target.value || data.today);
                }}
                className="h-12 rounded-2xl border bg-background px-4"
              />
            )}
            <div>
              <label htmlFor="qa-note" className="mb-1 block text-sm font-medium">{msg.quick.note()}</label>
              <textarea
                id="qa-note"
                maxLength={500}
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full rounded-2xl border bg-background p-3"
              />
              <p className="text-end text-xs text-muted-foreground">{msg.quick.noteCount({ n: note.length })}</p>
            </div>
          </div>
        )}
      </div>

      {errMsg && (
        <div role="alert" className="rounded-2xl border border-destructive/50 p-3 text-sm">
          <p>{errMsg}</p>
          {errActions && errActions.length > 0 && envelope.ownerType === 'mine' && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Link href="/?add=allocate" className="btn-secondary">{msg.action.addMoney()}</Link>
              <Link href="/?add=loan" className="btn-secondary">{msg.action.borrow()}</Link>
            </div>
          )}
        </div>
      )}

      {duplicate && (
        <div role="alertdialog" aria-labelledby="dup-title" className="rounded-2xl border border-warning/50 bg-warning/10 p-3 text-sm">
          <p id="dup-title" className="font-semibold">{msg.quick.duplicateTitle()}</p>
          <p>{msg.quick.duplicateBody()}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary min-h-11" onClick={() => void save(false, true)}>{msg.quick.addAnyway()}</button>
            <button type="button" className="btn-secondary" onClick={() => setDuplicate(false)}>{msg.general.cancel()}</button>
          </div>
        </div>
      )}

      {/* 5. Save */}
      <div className="sticky bottom-0 -mx-5 grid gap-2 border-t bg-card px-5 pt-3">
        <button
          type="submit"
          data-testid="save-expense"
          disabled={!canSave || !!guardProps.disabled}
          aria-describedby={guardProps['aria-describedby']}
          className={cn('btn-primary h-14 text-base transition-transform motion-reduce:transition-none', justSaved && 'scale-105')}
        >
          {justSaved ? <Check aria-hidden="true" className="size-5" /> : null}
          {busy ? msg.quick.saving() : msg.quick.save()}
        </button>
        <button type="button" disabled={!canSave || !!guardProps.disabled} aria-describedby={guardProps['aria-describedby']} onClick={() => void save(true)} className="btn-secondary">
          {msg.quick.saveAnother()}
        </button>
      </div>
    </form>
  );
}
