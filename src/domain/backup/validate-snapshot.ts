/**
 * Snapshot ledger validation - TD-11 §4.3.4. Pure.
 *
 * Applies the SAME rules as the live system to a parsed backup so a bad file
 * is rejected before anything is written. Collects up to MAX_PROBLEMS readable
 * problems (plus a total count).
 */

import type { BackupBody } from './schema';
import { timelinePostings, balancesOf, type LedgerTx, type TxType } from '@/domain/ledger/effects';
import { findFirstViolation, findFirstLoanViolation, type LocalDate, type SortKey } from '@/domain/validation/timeline';
import type { Paisa } from '@/domain/money';

export const MAX_PROBLEMS = 20;
export const MIN_DATE = '2000-01-01';

export interface Problem {
  path: string;
  message: string;
}
export interface SnapshotReport {
  ok: boolean;
  problems: Problem[];
  totalProblems: number;
}

class Collector {
  problems: Problem[] = [];
  total = 0;
  add(path: string, message: string) {
    this.total++;
    if (this.problems.length < MAX_PROBLEMS) this.problems.push({ path, message });
  }
}

const norm = (s: string) => s.trim().toLowerCase();

export function validateSnapshot(doc: BackupBody, today: string): SnapshotReport {
  const c = new Collector();
  const envs = new Map(doc.envelopes.map((e) => [e.id, e]));
  const cats = new Map(doc.categories.map((x) => [x.id, x]));
  const txs = new Map(doc.transactions.map((t) => [t.id, t]));
  const loans = new Map(doc.loans.map((l) => [l.id, l]));
  const rules = new Map(doc.recurring_rules.map((r) => [r.id, r]));
  const envName = (id: string | null) => (id ? envs.get(id)?.name ?? id : 'Unallocated');

  // --- duplicate ids -------------------------------------------------------
  const dupCheck = (name: string, ids: string[]) => {
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (seen.has(id)) c.add(`${name}[${i}]`, `Duplicate id ${id}.`);
      seen.add(id);
    });
  };
  dupCheck('envelopes', doc.envelopes.map((x) => x.id));
  dupCheck('categories', doc.categories.map((x) => x.id));
  dupCheck('transactions', doc.transactions.map((x) => x.id));
  dupCheck('loans', doc.loans.map((x) => x.id));
  dupCheck('recurring_rules', doc.recurring_rules.map((x) => x.id));

  // --- envelopes / categories ---------------------------------------------
  const activeNames = new Set<string>();
  doc.envelopes.forEach((e, i) => {
    if (e.owner_type === 'other' && !e.owner_name?.trim()) c.add(`envelopes[${i}]`, `“${e.name}” is held for someone else but has no owner name.`);
    if ((e.status === 'archived') !== (e.archived_at !== null)) c.add(`envelopes[${i}]`, `“${e.name}” has inconsistent archive information.`);
    if (e.status === 'active') {
      const k = norm(e.name);
      if (activeNames.has(k)) c.add(`envelopes[${i}]`, `Two active envelopes are both called “${e.name}”.`);
      activeNames.add(k);
    }
  });
  const catNames = new Set<string>();
  const systemCount: Record<string, number> = { expense: 0, income: 0 };
  doc.categories.forEach((x, i) => {
    const k = `${x.kind}:${norm(x.name)}`;
    if (catNames.has(k)) c.add(`categories[${i}]`, `Two ${x.kind} categories are both called “${x.name}”.`);
    catNames.add(k);
    if (x.is_system) systemCount[x.kind] = (systemCount[x.kind] ?? 0) + 1;
  });
  for (const kind of ['expense', 'income']) {
    if (systemCount[kind] !== 1) c.add('categories', `Expected exactly one system “Uncategorized” ${kind} category, found ${systemCount[kind]}.`);
  }

  // --- transactions --------------------------------------------------------
  let liveOpening = 0;
  const live: LedgerTx[] = [];
  const splitsByTx = new Map<string, typeof doc.transaction_splits>();
  for (const s of doc.transaction_splits) {
    const list = splitsByTx.get(s.transaction_id) ?? [];
    list.push(s);
    splitsByTx.set(s.transaction_id, list);
  }

  doc.transaction_splits.forEach((s, i) => {
    const t = txs.get(s.transaction_id);
    if (!t) return c.add(`transaction_splits[${i}]`, 'A split points to a transaction that is not in the file.');
    if (t.type !== 'income') c.add(`transaction_splits[${i}]`, 'Only income can be split between envelopes.');
    const env = envs.get(s.envelope_id);
    if (!env) c.add(`transaction_splits[${i}]`, 'A split points to an envelope that is not in the file.');
    else if (env.owner_type !== 'mine') c.add(`transaction_splits[${i}]`, `Income can't be split into money held for ${env.owner_name ?? 'someone else'}.`);
    if (BigInt(s.amount_paisa) <= 0n) c.add(`transaction_splits[${i}]`, 'A split amount must be more than zero.');
  });

  doc.transactions.forEach((t, i) => {
    const p = `transactions[${i}]`;
    const amount = BigInt(t.amount_paisa);
    const max = 99_999_999_999n;
    // amount rules
    if (t.type === 'adjustment') {
      if (amount === 0n || amount > max || amount < -max) c.add(p, 'An adjustment must be a non-zero amount within limits.');
    } else if (t.type === 'opening_balance') {
      if (amount < 0n || amount > max) c.add(p, 'The opening balance is out of range.');
    } else if (amount < 1n || amount > max) c.add(p, `A ${t.type.replace('_', ' ')} amount is out of range.`);

    if (t.occurred_on < MIN_DATE) c.add(p, `A transaction is dated before ${MIN_DATE}.`);
    if (t.occurred_on > today) c.add(p, `A transaction is dated in the future (${t.occurred_on}).`);

    // references exist
    for (const [field, id] of [['envelope_id', t.envelope_id], ['counterpart_envelope_id', t.counterpart_envelope_id]] as const) {
      if (id && !envs.has(id)) c.add(p, `Points to an envelope that is not in the file (${field}).`);
    }
    if (t.category_id && !cats.has(t.category_id)) c.add(p, 'Points to a category that is not in the file.');
    if (t.loan_id && !loans.has(t.loan_id)) c.add(p, 'Points to a loan that is not in the file.');
    if (t.recurring_id && !rules.has(t.recurring_id)) c.add(p, 'Points to a recurring rule that is not in the file.');
    if (t.parent_transaction_id && !txs.has(t.parent_transaction_id)) c.add(p, 'Points to a parent transaction that is not in the file.');

    // shape (tx_shape CHECK equivalent)
    const e1 = t.envelope_id !== null, e2 = t.counterpart_envelope_id !== null;
    const cat = t.category_id !== null, loan = t.loan_id !== null;
    let shapeOk: boolean;
    switch (t.type) {
      case 'opening_balance': shapeOk = !e1 && !e2 && !cat && !loan; break;
      case 'income': shapeOk = !e1 && !e2 && cat && !loan; break;
      case 'expense': shapeOk = e1 && !e2 && cat && !loan; break;
      case 'external_deposit': case 'external_withdrawal': case 'allocation': case 'deallocation':
        shapeOk = e1 && !e2 && !cat && !loan; break;
      case 'transfer': shapeOk = e1 && e2 && t.envelope_id !== t.counterpart_envelope_id && !cat && !loan; break;
      case 'loan': case 'loan_repayment': shapeOk = e1 && e2 && t.envelope_id !== t.counterpart_envelope_id && !cat && loan; break;
      case 'adjustment': shapeOk = !e2 && !cat && !loan; break;
    }
    if (!shapeOk) c.add(p, `A ${t.type.replace('_', ' ')} has the wrong combination of envelopes/category/loan.`);

    // ownership
    const from = t.envelope_id ? envs.get(t.envelope_id) : undefined;
    const to = t.counterpart_envelope_id ? envs.get(t.counterpart_envelope_id) : undefined;
    if ((t.type === 'external_deposit' || t.type === 'external_withdrawal') && from && from.owner_type !== 'other') {
      c.add(p, `Held-money transactions must use an envelope held for someone else (“${from.name}” is yours).`);
    }
    if ((t.type === 'transfer' || t.type === 'loan' || t.type === 'loan_repayment') && ((from && from.owner_type !== 'mine') || (to && to.owner_type !== 'mine'))) {
      c.add(p, `Money held for others can't be ${t.type === 'transfer' ? 'transferred' : 'lent or repaid'} (${envName(t.envelope_id)} → ${envName(t.counterpart_envelope_id)}).`);
    }
    const catKind = t.category_id ? cats.get(t.category_id)?.kind : undefined;
    if (catKind && ((t.type === 'expense' && catKind !== 'expense') || (t.type === 'income' && catKind !== 'income'))) {
      c.add(p, `A ${t.type} uses a ${catKind} category.`);
    }

    // splits
    const sp = splitsByTx.get(t.id) ?? [];
    if (t.type === 'income' && sp.length) {
      const sum = sp.reduce((s, x) => s + BigInt(x.amount_paisa), 0n);
      if (sum > amount) c.add(p, 'An income is split into more than its total amount.');
      if (new Set(sp.map((x) => x.envelope_id)).size !== sp.length) c.add(p, 'An income is split twice into the same envelope.');
    }

    if (t.deleted_at === null) {
      if (t.type === 'opening_balance') liveOpening++;
      live.push({
        id: t.id,
        type: t.type as TxType,
        amountPaisa: amount,
        occurredOn: t.occurred_on,
        occurredAt: t.occurred_at,
        createdAt: t.created_at,
        envelopeId: t.envelope_id,
        counterpartEnvelopeId: t.counterpart_envelope_id,
        splits: sp.map((x) => ({ envelopeId: x.envelope_id, amountPaisa: BigInt(x.amount_paisa) })),
      });
    }
  });
  if (liveOpening > 1) c.add('transactions', `There are ${liveOpening} opening balances; only one is allowed.`);

  // --- loans ---------------------------------------------------------------
  const originByLoan = new Map<string, typeof doc.transactions>();
  const repayByLoan = new Map<string, typeof doc.transactions>();
  for (const t of doc.transactions) {
    if (!t.loan_id || t.deleted_at !== null) continue;
    const map = t.type === 'loan' ? originByLoan : t.type === 'loan_repayment' ? repayByLoan : null;
    if (!map) continue;
    const l = map.get(t.loan_id) ?? [];
    l.push(t);
    map.set(t.loan_id, l);
  }
  doc.loans.forEach((l, i) => {
    const p = `loans[${i}]`;
    if (!envs.has(l.lender_envelope_id) || !envs.has(l.borrower_envelope_id)) c.add(p, 'A loan points to an envelope that is not in the file.');
    if (l.lender_envelope_id === l.borrower_envelope_id) c.add(p, 'A loan has the same envelope as lender and borrower.');
    if (l.deleted_at === null) {
      const origins = originByLoan.get(l.id) ?? [];
      if (origins.length !== 1) c.add(p, `A loan between ${envName(l.lender_envelope_id)} and ${envName(l.borrower_envelope_id)} has ${origins.length} starting transactions (needs exactly 1).`);
      else if (origins[0]!.envelope_id !== l.lender_envelope_id || origins[0]!.counterpart_envelope_id !== l.borrower_envelope_id) {
        c.add(p, 'A loan’s lender/borrower do not match its transaction.');
      }
      for (const r of repayByLoan.get(l.id) ?? []) {
        if (r.envelope_id !== l.borrower_envelope_id || r.counterpart_envelope_id !== l.lender_envelope_id) c.add(p, 'A repayment goes the wrong way for its loan.');
      }
    } else if ((repayByLoan.get(l.id)?.length ?? 0) > 0 || (originByLoan.get(l.id)?.length ?? 0) > 0) {
      c.add(p, 'A deleted loan still has live transactions.');
    }
  });
  const loanPostings: Parameters<typeof findFirstLoanViolation>[0] = [];
  for (const t of live) {
    if (t.type !== 'loan' && t.type !== 'loan_repayment') continue;
    const raw = txs.get(t.id)!;
    if (!raw.loan_id) continue;
    loanPostings.push({
      loanId: raw.loan_id,
      txId: t.id,
      type: t.type,
      amount: t.amountPaisa as Paisa,
      seq: [t.occurredOn as LocalDate, t.occurredAt as never, t.createdAt, t.id] as unknown as SortKey,
    });
  }
  const lv = findFirstLoanViolation(loanPostings);
  if (lv) c.add('transactions', `A loan would be over-repaid (or repaid before it started) on ${lv.at}, by ${(lv.shortfall / 100n).toString()} PKR.`);

  // --- timeline replay (INV-1…3, 10) ---------------------------------------
  const v = findFirstViolation(timelinePostings(live));
  if (v) {
    const where = v.kind === 'envelope' ? envName(v.envelopeId) : v.kind === 'unallocated' ? 'Unallocated' : 'a loan';
    const short = `${(v.shortfall / 100n).toString()}${v.shortfall % 100n ? '.' + (v.shortfall % 100n).toString().padStart(2, '0') : ''}`;
    c.add('transactions', `${where} would be ${short} PKR below zero on ${v.at}. The history in this file isn't possible.`);
  }

  // archived envelopes end at zero and have no active loan
  const bal = balancesOf(live);
  doc.envelopes.forEach((e, i) => {
    if (e.status === 'archived' && (bal.envelopes.get(e.id) ?? 0n) !== 0n) c.add(`envelopes[${i}]`, `“${e.name}” is archived but still holds money.`);
  });

  // --- recurring -----------------------------------------------------------
  doc.recurring_rules.forEach((r, i) => {
    const p = `recurring_rules[${i}]`;
    if ((r.type === 'expense') !== (r.envelope_id !== null)) c.add(p, `“${r.name}” has the wrong envelope setting for its type.`);
    if (r.envelope_id && !envs.has(r.envelope_id)) c.add(p, `“${r.name}” points to an envelope that is not in the file.`);
    if (!cats.has(r.category_id)) c.add(p, `“${r.name}” points to a category that is not in the file.`);
    for (const t of r.split_template ?? []) if (!envs.has(t.envelopeId)) c.add(p, `“${r.name}” splits into an envelope that is not in the file.`);
    if (r.is_committee && (r.type !== 'expense' || r.max_occurrences === null)) c.add(p, `Committee “${r.name}” needs a fixed number of payments.`);
  });
  const dueKeys = new Set<string>();
  const slotKeys = new Set<string>();
  doc.recurring_occurrences.forEach((o, i) => {
    const p = `recurring_occurrences[${i}]`;
    if (!rules.has(o.rule_id)) return c.add(p, 'An occurrence points to a rule that is not in the file.');
    const dk = `${o.rule_id}:${o.due_date}`, sk = `${o.rule_id}:${o.slot_index}`;
    if (dueKeys.has(dk)) c.add(p, `A rule has two occurrences on ${o.due_date}.`);
    if (slotKeys.has(sk)) c.add(p, `A rule has two occurrences for slot ${o.slot_index}.`);
    dueKeys.add(dk);
    slotKeys.add(sk);
    if (o.status === 'generated') {
      const t = o.transaction_id ? txs.get(o.transaction_id) : undefined;
      if (!t || t.deleted_at !== null) c.add(p, `The occurrence on ${o.due_date} is marked generated but its transaction is missing.`);
    }
    if (o.transaction_id && !txs.has(o.transaction_id)) c.add(p, 'An occurrence points to a transaction that is not in the file.');
  });

  // --- reconciliations -----------------------------------------------------
  doc.reconciliations.forEach((r, i) => {
    const p = `reconciliations[${i}]`;
    if (BigInt(r.actual_paisa) < 0n) c.add(p, 'A bank balance check has a negative actual balance.');
    if (BigInt(r.difference_paisa) !== BigInt(r.actual_paisa) - BigInt(r.expected_paisa)) c.add(p, 'A bank check’s difference does not equal actual − expected.');
    if (r.adjustment_transaction_id && !txs.has(r.adjustment_transaction_id)) c.add(p, 'A bank check points to an adjustment that is not in the file.');
  });

  return { ok: c.total === 0, problems: c.problems, totalProblems: c.total };
}
