import { cn } from '@/lib/cn';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const tones: Record<Tone, string> = {
  neutral: 'bg-secondary text-secondary-foreground border-border',
  success: 'bg-success/15 text-success border-success/40',
  warning: 'bg-warning/15 text-warning border-warning/40',
  danger: 'bg-destructive/15 text-destructive border-destructive/40',
  info: 'bg-primary/10 text-primary border-primary/30',
};

/** Icon + text always; colour is only reinforcement (TD-10 §3). */
export function StatusChip({
  icon,
  tone = 'neutral',
  children,
  className,
}: {
  icon: React.ReactNode;
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium',
        tones[tone],
        className
      )}
    >
      <span aria-hidden="true" className="inline-flex">{icon}</span>
      <span>{children}</span>
    </span>
  );
}
