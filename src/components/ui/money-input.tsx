'use client';

/**
 * <MoneyInput> - TD-10 §6.2
 * Controlled text input. Never reformats while typing (no cursor jumps);
 * normalises Arabic-Indic digits and pasted currency text; supports `1200+350`.
 */

import { forwardRef, useId } from 'react';
import { evaluateAmountExpression, parseMoney, type ParseResult } from '@/domain/money';
import { cn } from '@/lib/cn';

export function parseInput(text: string, allowExpression: boolean): ParseResult {
  return allowExpression ? evaluateAmountExpression(text) : parseMoney(text);
}

/** Strip currency words/symbols on paste: "PKR 2,500" -> "2,500". */
export function cleanPasted(text: string): string {
  return text.replace(/pkr|rs\.?|₨|rupees?/gi, '').trim();
}

interface Props {
  value: string;
  onChange: (text: string, parsed: ParseResult) => void;
  label: string;
  describedBy?: string;
  allowExpression?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  className?: string;
  testId?: string;
}

export const MoneyInput = forwardRef<HTMLInputElement, Props>(function MoneyInput(
  { value, onChange, label, describedBy, allowExpression = true, autoFocus, invalid, className, testId = 'amount-input' },
  ref
) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        data-testid={testId}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        autoFocus={autoFocus}
        enterKeyHint="done"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={value}
        placeholder="0"
        onChange={(e) => onChange(e.target.value, parseInput(e.target.value, allowExpression))}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          const cleaned = cleanPasted(text);
          if (cleaned !== text) {
            e.preventDefault();
            onChange(cleaned, parseInput(cleaned, allowExpression));
          }
        }}
        className={cn(
          'money h-16 w-full rounded-2xl border bg-background px-4 text-3xl font-semibold outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring',
          invalid && 'border-destructive'
        )}
      />
    </div>
  );
});
