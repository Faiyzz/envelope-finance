import { describe, expect, it } from 'vitest';
import { buildAttention } from '@/domain/dashboard/attention';
import { applyPendingExpenses } from '@/domain/dashboard/optimistic';
import { describeTx, shortDate, upcomingLabel } from '@/domain/dashboard/labels';
import { orderCategories } from '@/domain/transactions/category-order';
import { evaluateAmountExpression } from '@/domain/money';
import type { DashboardDTO } from '@/domain/dashboard/types';

const base: DashboardDTO = {
  total: '19750000',
  yourMoney: '17750000',
  heldForOthers: '2000000',
  unallocated: '2000000',
  recon: { status: 'never_verified' },
  attention: [],
  envelopes: [
    { id: 'home', name: 'Home', icon: '🏠', ownerType: 'mine', ownerName: null, kind: 'standard', balance: '4750000', txCount: 3, borrowed: '0', loanedOut: '0', ownFunds: '4750000' },
    { id: 'ahmed', name: 'Ahmed', icon: '🤝', ownerType: 'other', ownerName: 'Ahmed', kind: 'standard', balance: '2000000', txCount: 1, borrowed: '0', loanedOut: '0', ownFunds: '2000000' },
  ],
  upcoming: [],
  recent: [],
  setup: { hasOpeningBalance: true, hasEnvelopes: true },
  today: '2026-10-06',
  fetchedAt: '2026-10-06T00:00:00Z',
};

describe('[URD-51] optimistic expense', () => {
  it('reduces total, your money and the envelope (reference step 2: 47,500 -> 45,000)', () => {
    const out = applyPendingExpenses(base, [{ key: 'k', envelopeId: 'home', amount: '250000', label: 'Groceries', occurredOn: '2026-10-06' }]);
    expect(out.total).toBe('19500000');
    expect(out.yourMoney).toBe('17500000');
    expect(out.heldForOthers).toBe('2000000');
    expect(out.envelopes[0]!.balance).toBe('4500000');
    expect(out.recent[0]!.signedAmount).toBe('-250000');
  });
  it("spending someone else's money reduces Held for Others, not Your Money", () => {
    const out = applyPendingExpenses(base, [{ key: 'k', envelopeId: 'ahmed', amount: '100000', label: 'x', occurredOn: '2026-10-06' }]);
    expect(out.heldForOthers).toBe('1900000');
    expect(out.yourMoney).toBe(base.yourMoney);
  });
  it('is pure and exact for paisa amounts; rollback = removing the pending item', () => {
    const p = { key: 'k', envelopeId: 'home', amount: '1', label: 'x', occurredOn: '2026-10-06' };
    expect(applyPendingExpenses(base, [p]).total).toBe('19749999');
    expect(applyPendingExpenses(base, [])).toBe(base);
    expect(base.total).toBe('19750000');
  });
});

describe('attention strip (TD-10 §4.4)', () => {
  const needs = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'needs_attention' as const, id: String(i), ruleName: 'r', amount: '1', dueDate: '2026-11-01' }));
  it('orders by priority and caps at 3 with a "more" count', () => {
    const r = buildAttention({ needsAttention: needs(2), integrityFailed: true, daysSinceCheck: 20, pausedRules: [{ ruleId: 'a', ruleName: 'Netflix' }] });
    expect(r.shown.map((i) => i.kind)).toEqual(['needs_attention', 'needs_attention', 'integrity_failed']);
    expect(r.more).toBe(2);
  });
  it('nags about verification only after more than 14 days, never when never verified', () => {
    const none = { needsAttention: [], integrityFailed: false, pausedRules: [] };
    expect(buildAttention({ ...none, daysSinceCheck: 14 }).all).toEqual([]);
    expect(buildAttention({ ...none, daysSinceCheck: 15 }).all).toEqual([{ kind: 'recon_stale', days: 15 }]);
    expect(buildAttention({ ...none, daysSinceCheck: null }).all).toEqual([]);
  });
});

describe('labels', () => {
  it('upcoming labels', () => {
    expect(upcomingLabel(0, false)).toEqual({ kind: 'today' });
    expect(upcomingLabel(1, false)).toEqual({ kind: 'tomorrow' });
    expect(upcomingLabel(4, false)).toEqual({ kind: 'inDays', n: 4 });
    expect(upcomingLabel(-2, false)).toEqual({ kind: 'overdue' });
    expect(upcomingLabel(3, true)).toEqual({ kind: 'overdue' });
  });
  it('short dates do not shift with timezone', () => {
    expect(shortDate('2026-10-06')).toBe('Oct 6');
    expect(shortDate('2026-01-31')).toBe('Jan 31');
  });
  it('describes on-behalf-of and transfers', () => {
    const r = { id: '1', type: 'expense', signedAmount: '-1', envelopeName: 'Ahmed', counterpartName: null, categoryName: 'Food', note: null, occurredOn: '2026-10-06', onBehalfOf: 'Ahmed' };
    expect(describeTx(r).subtitle).toContain('On behalf of Ahmed');
    expect(describeTx({ ...r, type: 'transfer', envelopeName: 'A', counterpartName: 'B', onBehalfOf: null }).subtitle).toBe('A → B');
  });
});

describe('category picker order (TD-05 §9.3)', () => {
  const cats = [
    { id: 'u', name: 'Uncategorized', groupName: null, isSystem: true },
    { id: 'f', name: 'Food', groupName: 'personal' as const, isSystem: false },
    { id: 'g', name: 'Groceries', groupName: 'home' as const, isSystem: false },
    { id: 'e', name: 'Electricity', groupName: 'home' as const, isSystem: false },
  ];
  it('recent first, home group first for home-ish envelopes, Uncategorized last', () => {
    expect(orderCategories(cats, 'My House', ['f']).map((c) => c.id)).toEqual(['f', 'e', 'g', 'u']);
  });
  it('personal first otherwise', () => {
    expect(orderCategories(cats, 'Personal', []).map((c) => c.id)).toEqual(['f', 'e', 'g', 'u']);
  });
});

describe('quick expense amount (calculator, no eval)', () => {
  it('1200+350 -> 1,550.00', () => {
    const r = evaluateAmountExpression('1200+350');
    expect(r.ok && r.value).toBe(155000n);
  });
  it('rejects garbage and trailing +', () => {
    expect(evaluateAmountExpression('12abc').ok).toBe(false);
    expect(evaluateAmountExpression('1200+').ok).toBe(false);
    expect(evaluateAmountExpression('process.exit()').ok).toBe(false);
  });
});
