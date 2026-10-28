import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireUser } from '@/server/auth/session';
import { FormatProvider } from '@/lib/format-context';
import { AppShell } from '@/components/shell/app-shell';

/**
 * Authenticated area - TD-10 §1. Session is validated server-side on every
 * request (TD-02 §3.3); the Edge middleware only checks cookie presence.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let session;
  try {
    session = await requireUser();
  } catch {
    redirect('/login');
  }

  // hide-balances is mirrored in a cookie so the first paint is already masked (TD-03 §3.2)
  const jar = await cookies();
  const hiddenCookie = jar.get('hide_balances')?.value;
  const initialHidden = hiddenCookie === undefined ? false : hiddenCookie === '1';
  const grouping = session.user.numberGrouping === 'lakh' ? 'lakh' : 'western';

  return (
    <FormatProvider grouping={grouping} initialHidden={initialHidden}>
      <AppShell userName={session.user.name}>{children}</AppShell>
    </FormatProvider>
  );
}
