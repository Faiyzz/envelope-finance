'use client';

import { Plus } from 'lucide-react';
import { useQuickAdd, type QuickKind } from '@/components/quick-add/quick-add-host';

/** Opens the quick-add sheet on a given form. */
export function AddButton({ kind, label }: { kind: QuickKind; label: string }) {
  const { open } = useQuickAdd();
  return (
    <button type="button" onClick={() => open(kind)} className="btn-primary">
      <Plus aria-hidden="true" className="size-4" />
      {label}
    </button>
  );
}
