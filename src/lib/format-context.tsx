'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { formatMoney, type Paisa } from '@/domain/money';

interface FormatCtx {
  grouping: 'western' | 'lakh';
  hidden: boolean;
  setHidden: (h: boolean) => void;
  /** Format a paisa string/bigint; honours grouping. Not affected by `hidden`. */
  fmt: (v: string | bigint, o?: { sign?: 'auto' | 'always'; currency?: boolean }) => string;
}

const Ctx = createContext<FormatCtx | null>(null);

const COOKIE = 'hide_balances';

export function FormatProvider({
  grouping,
  initialHidden,
  children,
}: {
  grouping: 'western' | 'lakh';
  initialHidden: boolean;
  children: React.ReactNode;
}) {
  const [hidden, setHiddenState] = useState(initialHidden);

  // localStorage mirrors the cookie (TD-03 §3.2); cookie is what SSR reads.
  useEffect(() => {
    try {
      const v = localStorage.getItem(COOKIE);
      if (v !== null && (v === '1') !== hidden) setHiddenState(v === '1');
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setHidden = useCallback((h: boolean) => {
    setHiddenState(h);
    try {
      localStorage.setItem(COOKIE, h ? '1' : '0');
    } catch {
      /* ignore */
    }
    document.cookie = `${COOKIE}=${h ? 1 : 0}; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const fmt = useCallback<FormatCtx['fmt']>(
    (v, o) => formatMoney(BigInt(v) as Paisa, { grouping, sign: o?.sign, currency: o?.currency }),
    [grouping]
  );

  const value = useMemo(() => ({ grouping, hidden, setHidden, fmt }), [grouping, hidden, setHidden, fmt]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFormat(): FormatCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useFormat must be used inside <FormatProvider>');
  return c;
}
