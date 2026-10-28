import { requireUser } from '@/server/auth/session';
import { getDashboard } from '@/server/queries/dashboard';
import { DashboardView } from '@/components/dashboard/dashboard-view';

export const dynamic = 'force-dynamic'; // balances are never cached (TD-10 §4.1)

export default async function DashboardPage() {
  const { userId, user } = await requireUser();
  const data = await getDashboard(userId, user.timezone);
  return <DashboardView data={data} userName={user.name} userId={userId} />;
}
