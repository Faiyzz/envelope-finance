/**
 * Transaction validation pipeline - TD-05 §1
 * 
 * Pure validation logic for transaction creation/editing
 */

import type { Paisa } from '@/domain/money';
import { parseMoney } from '@/domain/money';
import { assertDateAllowed, todayIn, type LocalDate } from '@/domain/dates';

export interface NormalizedTx {
  amount: Paisa;
  date: string;
  time: string;
  note: string | null;
  envelopeId: string | null;
  categoryId: string | null;
  // Type-specific fields
  splits?: Array<{ envelopeId: string; amount: Paisa }>;
  counterpartEnvelopeId?: string | null;
}

export interface ValidationResultSuccess {
  ok: true;
  tx: NormalizedTx;
}

export interface ValidationResultError {
  ok: false;
  errors: Record<string, string>;
}

export type ValidationResult = ValidationResultSuccess | ValidationResultError;

/**
 * Clean text - strip control chars except \n and \t
 */
function cleanText(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Validate common transaction fields
 */
export function validateCommonTx(input: {
  amount: string;
  date?: string;
  time?: string;
  note?: string;
  envelopeId?: string;
  categoryId?: string;
}): ValidationResult {
  const errors: Record<string, string> = {};
  
  // 1. Amount validation
  const amountResult = parseMoney(input.amount, { allowZero: false });
  if (!amountResult.ok) {
    errors.amount = 'Invalid amount';
  }
  
  // 2. Date validation
  const today = todayIn('Asia/Karachi', Date.now());
  const date = (input.date || today) as LocalDate;
  try {
    assertDateAllowed(date, today);
  } catch (e) {
    errors.date = e instanceof Error ? e.message : 'Invalid date';
  }
  
  // 3. Note validation
  let note: string | null = null;
  if (input.note !== undefined) {
    const cleaned = cleanText(input.note);
    if (cleaned.length > 500) {
      errors.note = 'Note must be 500 characters or less';
    } else {
      note = cleaned || null;
    }
  }
  
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors } as ValidationResultError;
  }
  
  return {
    ok: true,
    tx: {
      amount: (amountResult as { ok: true; value: Paisa }).value,
      date,
      time: input.time || '12:00:00',
      note,
      envelopeId: input.envelopeId || null,
      categoryId: input.categoryId || null,
    },
  } as ValidationResultSuccess;
}

/**
 * Validate expense transaction
 */
export function validateExpense(input: {
  amount: string;
  envelopeId: string;
  categoryId?: string;
  note?: string;
  date?: string;
  time?: string;
}, envelopeExists: (id: string) => boolean, categoryExists: (id: string) => boolean): ValidationResult {
  const common = validateCommonTx(input);
  if (!common.ok) return common;
  
  const errors: Record<string, string> = {};
  
  // 4. Envelope exists and is active
  if (!envelopeExists(input.envelopeId)) {
    errors.envelopeId = 'Envelope not found';
  }
  
  // 5. Category exists and is expense kind
  if (input.categoryId && !categoryExists(input.categoryId)) {
    errors.categoryId = 'Category not found';
  }
  
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors } as ValidationResultError;
  }
  
  return {
    ok: true,
    tx: { ...common.tx, envelopeId: input.envelopeId, categoryId: input.categoryId || null },
  } as ValidationResultSuccess;
}

/**
 * Validate income transaction with splits
 */
export function validateIncome(input: {
  amount: string;
  categoryId?: string;
  note?: string;
  date?: string;
  time?: string;
  splits?: Array<{ envelopeId: string; amount: string }>;
}, envelopeExists: (id: string) => boolean, categoryExists: (id: string) => boolean): ValidationResult {
  const common = validateCommonTx(input);
  if (!common.ok) return common;
  
  const errors: Record<string, string> = {};
  
  // 5. Category exists and is income kind
  if (input.categoryId && !categoryExists(input.categoryId)) {
    errors.categoryId = 'Category not found';
  }
  
  // 6. Splits validation
  let totalSplits = 0n;
  const splitEnvelopeIds = new Set<string>();
  
  if (input.splits && input.splits.length > 0) {
    for (const split of input.splits) {
      // Envelope exists and is active
      if (!envelopeExists(split.envelopeId)) {
        errors.splits = 'Envelope not found in splits';
        break;
      }
      
      // No duplicate envelope
      if (splitEnvelopeIds.has(split.envelopeId)) {
        errors.splits = 'Duplicate envelope in splits';
        break;
      }
      splitEnvelopeIds.add(split.envelopeId);
      
      // Parse amount
      const splitResult = parseMoney(split.amount, { allowZero: false });
      if (!splitResult.ok) {
        errors.splits = 'Invalid split amount';
        break;
      }
      
      totalSplits += splitResult.value;
    }
    
    // Σ splits ≤ amount
    if (totalSplits > common.tx.amount) {
      errors.splits = 'Splits exceed income amount';
    }
  }
  
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors } as ValidationResultError;
  }
  
  return {
    ok: true,
    tx: {
      ...common.tx,
      categoryId: input.categoryId || null,
      splits: input.splits?.map(s => ({
        envelopeId: s.envelopeId,
        amount: (parseMoney(s.amount, { allowZero: false }) as { ok: true; value: Paisa }).value,
      })),
    },
  } as ValidationResultSuccess;
}
