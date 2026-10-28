'use client';

/** Settings → Data: exports and the guarded Replace-import flow (TD-11 §2–4). */

import { useRef, useState } from 'react';
import { Download, Share2, Upload } from 'lucide-react';
import { msg } from '@/messages/en';
import { useFormat } from '@/lib/format-context';
import { cn } from '@/lib/cn';

interface Problem { path: string; message: string }
type Failure = { ok: false; message: string; problems: Problem[]; totalProblems: number };
type Dry = { ok: true; dryRun: true; counts: Record<string, number> };
type Done = { ok: true; counts: Record<string, number>; remapped: boolean; sameAsPrevious: boolean; before: { total: string; unallocated: string }; after: { total: string; unallocated: string } };

const MAX_BYTES = 20 * 1024 * 1024;
const JSON_URL = '/api/export/json'; // a file download, not a page route

function upload(url: string, form: FormData, onProgress?: (pct: number) => void): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new Error('network'));
    xhr.onload = () => {
      try { resolve({ status: xhr.status, body: JSON.parse(xhr.responseText) }); } catch { reject(new Error('bad response')); }
    };
    xhr.send(form);
  });
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card-surface grid gap-3 p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function DataPanel() {
  const { fmt } = useFormat();

  // CSV
  const [kind, setKind] = useState('transactions');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const csvUrl = `/api/export/csv?kind=${kind}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`;

  // JSON backup
  const canShare = typeof navigator !== 'undefined' && 'canShare' in navigator;
  async function shareBackup() {
    const res = await fetch('/api/export/json', { cache: 'no-store' });
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'envelope-backup.json';
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
    else window.location.href = '/api/export/json';
  }

  // Import
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'ready' | 'importing' | 'done'>('idle');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [dry, setDry] = useState<Dry | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [progress, setProgress] = useState(0);
  const [backedUp, setBackedUp] = useState(false);
  const [waived, setWaived] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);

  async function pick(f: File | null) {
    setFailure(null); setDry(null); setDone(null); setFileError(null); setBackedUp(false); setWaived(false); setConfirm('');
    setFile(f);
    if (!f) return setPhase('idle');
    if (!f.name.toLowerCase().endsWith('.json')) { setFile(null); return setFileError(msg.data.notJson()); }
    if (f.size > MAX_BYTES) { setFile(null); return setFileError(msg.data.tooLarge()); }
    setPhase('checking');
    const fd = new FormData();
    fd.set('file', f);
    try {
      const r = await upload('/api/import?dryRun=1', fd);
      if ((r.body as { ok: boolean }).ok) { setDry(r.body as Dry); setPhase('ready'); }
      else { setFailure(r.body as Failure); setPhase('idle'); }
    } catch {
      setFailure({ ok: false, message: msg.quick.offline(), problems: [], totalProblems: 0 }); setPhase('idle');
    }
  }

  async function commit() {
    if (!file) return;
    setPhase('importing'); setProgress(0);
    const fd = new FormData();
    fd.set('file', file);
    fd.set('confirm', confirm);
    try {
      const r = await upload('/api/import', fd, setProgress);
      if ((r.body as { ok: boolean }).ok) { setDone(r.body as Done); setPhase('done'); }
      else { setFailure(r.body as Failure); setPhase('ready'); }
    } catch {
      setFailure({ ok: false, message: msg.quick.offline(), problems: [], totalProblems: 0 }); setPhase('ready');
    }
  }

  const canImport = phase === 'ready' && (backedUp || waived) && confirm === 'REPLACE';

  return (
    <div className="grid gap-5">
      <Card title={msg.data.exportTitle()}>
        <p className="text-sm text-muted-foreground">{msg.data.exportJsonHelp()}</p>
        <div className="flex flex-wrap gap-2">
          <a href={JSON_URL} className="btn-primary" onClick={() => setBackedUp(true)}>
            <Download aria-hidden="true" className="size-5" />{msg.data.exportJson()}
          </a>
          {canShare && (
            <button type="button" className="btn-secondary" onClick={() => void shareBackup()}>
              <Share2 aria-hidden="true" className="size-5" />{msg.data.shareJson()}
            </button>
          )}
        </div>
      </Card>

      <Card title={msg.data.exportCsvTitle()}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-sm font-medium sm:col-span-3">
            {msg.data.csvKind()}
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="h-12 rounded-2xl border bg-background px-3">
              <option value="transactions">{msg.data.csvTransactions()}</option>
              <option value="expenses">{msg.data.csvExpenses()}</option>
              <option value="income">{msg.data.csvIncome()}</option>
              <option value="reconciliations">{msg.data.csvReconciliations()}</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            {msg.data.from()}
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-12 rounded-2xl border bg-background px-3" />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            {msg.data.to()}
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-12 rounded-2xl border bg-background px-3" />
          </label>
        </div>
        <a href={csvUrl} className="btn-secondary justify-self-start"><Download aria-hidden="true" className="size-5" />{msg.data.downloadCsv()}</a>
      </Card>

      <Card title={msg.data.importTitle()}>
        <p className="text-sm text-muted-foreground">{msg.data.importWarn()}</p>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label={msg.data.chooseFile()}
          onChange={(e) => void pick(e.target.files?.[0] ?? null)}
        />
        <button type="button" className="btn-secondary justify-self-start" onClick={() => input.current?.click()} disabled={phase === 'checking' || phase === 'importing'}>
          <Upload aria-hidden="true" className="size-5" />{msg.data.chooseFile()}
        </button>
        {file && <p className="text-sm">{file.name} · {(file.size / 1024).toFixed(0)} KB</p>}
        {fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}
        {phase === 'checking' && <p role="status" className="text-sm text-muted-foreground">{msg.data.checking()}</p>}

        {failure && (
          <div role="alert" className="rounded-2xl border border-destructive/50 p-4 text-sm">
            <p className="font-semibold">{failure.message}</p>
            {failure.problems.length > 0 && (
              <>
                <p className="mt-1 text-muted-foreground">{msg.data.problems({ shown: failure.problems.length, total: failure.totalProblems })}</p>
                <ul className="mt-2 list-disc ps-5">
                  {failure.problems.map((p, i) => <li key={i}>{p.message} <span className="text-muted-foreground">({p.path})</span></li>)}
                </ul>
              </>
            )}
            <p className="mt-2">{msg.data.nothingChanged()}</p>
          </div>
        )}

        {dry && phase !== 'done' && (
          <div className="grid gap-3">
            <p role="status" className="text-sm font-medium text-success">{msg.data.fileOk()}</p>
            <ul className="text-sm text-muted-foreground">
              {Object.entries(dry.counts).filter(([, n]) => n > 0).map(([k, n]) => <li key={k}>{k.replace(/_/g, ' ')}: {n}</li>)}
            </ul>
            <div className="grid gap-2 rounded-2xl border p-3">
              <a href={JSON_URL} className="btn-secondary justify-self-start" onClick={() => setBackedUp(true)}>{msg.data.backupFirst()}</a>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={waived} onChange={(e) => setWaived(e.target.checked)} className="size-5" />
                {msg.data.haveBackup()}
              </label>
            </div>
            <label className="grid gap-1 text-sm font-medium">
              {msg.data.typeReplace()}
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" className="h-12 rounded-2xl border bg-background px-3" />
            </label>
            <button type="button" disabled={!canImport} onClick={() => void commit()} className={cn('btn-primary justify-self-start', 'bg-destructive text-destructive-foreground')}>
              {msg.data.importNow()}
            </button>
          </div>
        )}

        {phase === 'importing' && (
          <div role="status" className="grid gap-1 text-sm">
            <p>{progress < 100 ? `${msg.data.importing()} ${progress}%` : msg.data.importing()}</p>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${progress}%` }} /></div>
          </div>
        )}

        {done && (
          <div role="status" className="grid gap-1 rounded-2xl border border-success/50 p-4 text-sm">
            <p className="font-semibold">{msg.data.importDone()}</p>
            {done.sameAsPrevious && <p>{msg.data.importSame()}</p>}
            {done.remapped && <p>{msg.data.importRemapped()}</p>}
            <p>{msg.data.totalBefore({ amount: fmt(done.before.total) })}</p>
            <p>{msg.data.totalAfter({ amount: fmt(done.after.total) })}</p>
          </div>
        )}
      </Card>
    </div>
  );
}
