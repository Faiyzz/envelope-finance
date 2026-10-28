'use client';

/**
 * <Money> is the ONLY component that renders amounts (TD-10 §3).
 * - tabular numerals, true minus (U+2212), never colour-only meaning
 * - honours hide-balances (••••) and exposes a screen-reader label
 */

import { useEffect, useRef, useState } from 'react';
import { animate } from 'framer-motion';
import { ArrowDownRight } from 'lucide-react';
import { useFormat } from '@/lib/format-context';
import { useMotion } from '@/lib/use-motion';
import { cn } from '@/lib/cn';

type MoneyValue = string | bigint;

interface MoneyProps {
  value: MoneyValue;
  sign?: 'auto' | 'always';
  currency?: boolean;
  /** Show a non-colour cue (icon) for negative values. */
  cue?: boolean;
  className?: string;
}

function spoken(fmt: ReturnType<typeof useFormat>['fmt'], v: MoneyValue) {
  const b = BigInt(v);
  const abs = b < 0n ? -b : b;
  return `${b < 0n ? 'minus ' : ''}${fmt(abs, { currency: false })} rupees`;
}

export function Money({ value, sign = 'auto', currency = true, cue = false, className }: MoneyProps) {
  const { fmt, hidden } = useFormat();
  const negative = BigInt(value) < 0n;

  if (hidden) {
    return (
      <span className={cn('money', className)} aria-label="Amount hidden">
        <span aria-hidden="true">••••</span>
      </span>
    );
  }
  return (
    <span className={cn('money', className)} aria-label={spoken(fmt, value)}>
      {cue && negative && <ArrowDownRight aria-hidden="true" className="me-1 inline size-[0.9em]" />}
      <span aria-hidden="true">{fmt(value, { sign, currency })}</span>
    </span>
  );
}

/**
 * Count transition (~400 ms). Interpolates with bigint maths so no float ever
 * touches money; the final frame is always the exact value.
 */
export function AnimatedMoney({ value, className, testId }: { value: string; className?: string; testId?: string }) {
  const { fmt, hidden } = useFormat();
  const { reduced } = useMotion();
  const [shown, setShown] = useState(value);
  const prev = useRef(value);

  useEffect(() => {
    if (reduced || hidden || prev.current === value) {
      prev.current = value;
      setShown(value);
      return;
    }
    const from = BigInt(prev.current);
    const to = BigInt(value);
    prev.current = value;
    const controls = animate(0, 1000, {
      duration: 0.4,
      ease: 'easeOut',
      onUpdate: (t) => setShown((from + ((to - from) * BigInt(Math.round(t))) / 1000n).toString()),
      onComplete: () => setShown(value),
    });
    return () => controls.stop();
  }, [value, reduced, hidden]);

  if (hidden) {
    return (
      <span data-testid={testId} className={cn('money', className)} aria-label="Amount hidden">
        <span aria-hidden="true">••••</span>
      </span>
    );
  }
  return (
    <span data-testid={testId} data-value={value} className={cn('money', className)} aria-label={spoken(fmt, value)}>
      <span aria-hidden="true">{fmt(shown)}</span>
    </span>
  );
}
