'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Clock, ShieldQuestion } from 'lucide-react';
import { StatusChip, type Tone } from '@/components/ui/status-chip';
import { useFormat } from '@/lib/format-context';
import { msg } from '@/messages/en';
import { shortDate } from '@/domain/dashboard/labels';
import type { ReconChipDTO } from '@/domain/dashboard/types';

export function ReconChip({ recon }: { recon: ReconChipDTO }) {
  const { fmt } = useFormat();
  const date = recon.checkedOn ? shortDate(recon.checkedOn) : '';
  const diff = recon.difference ? BigInt(recon.difference) : 0n;
  const absDiff = fmt(diff < 0n ? -diff : diff);

  let icon = <ShieldQuestion className="size-4" />;
  let tone: Tone = 'neutral';
  let text: string = msg.recon.neverVerified();

  switch (recon.status) {
    case 'reconciled':
      icon = <CheckCircle2 className="size-4" />;
      tone = 'success';
      text = recon.current ? msg.recon.reconciled({ date }) : msg.recon.reconciledBased({ date });
      break;
    case 'changes_since':
      icon = <Clock className="size-4" />;
      tone = 'warning';
      text = msg.recon.changesSince({ n: recon.changeCount ?? 0, date });
      break;
    case 'mismatch':
      icon = <AlertTriangle className="size-4" />;
      tone = 'danger';
      text = msg.recon.mismatch({ amount: fmt(diff, { sign: 'always' }) });
      break;
    case 'changes_since_still_off':
      icon = <AlertTriangle className="size-4" />;
      tone = 'warning';
      text = msg.recon.stillOff({ amount: absDiff });
      break;
  }

  return (
    <Link href="/reconciliation" className="inline-flex min-h-11 items-center" aria-label={text}>
      <StatusChip icon={icon} tone={tone}>
        {text}
      </StatusChip>
    </Link>
  );
}
