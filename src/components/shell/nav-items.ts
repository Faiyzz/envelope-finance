import { BarChart3, CalendarClock, Handshake, Home, ListOrdered, Menu, Scale, Settings, Wallet, type LucideIcon } from 'lucide-react';
import { msg } from '@/messages/en';

export interface NavItem {
  href: string;
  label: () => string;
  icon: LucideIcon;
}

// Mobile bottom nav (the centre ＋ is rendered separately)
export const BOTTOM_LEFT: NavItem[] = [
  { href: '/', label: msg.nav.home, icon: Home },
  { href: '/envelopes', label: msg.nav.envelopes, icon: Wallet },
];
export const BOTTOM_RIGHT: NavItem[] = [
  { href: '/transactions', label: msg.nav.activity, icon: ListOrdered },
];
export const MORE_ITEMS: NavItem[] = [
  { href: '/analytics', label: msg.nav.analytics, icon: BarChart3 },
  { href: '/recurring', label: msg.nav.recurring, icon: CalendarClock },
  { href: '/reconciliation', label: msg.nav.reconciliation, icon: Scale },
  { href: '/loans', label: msg.nav.loans, icon: Handshake },
  { href: '/settings', label: msg.nav.settings, icon: Settings },
];
// Desktop sidebar
export const SIDEBAR: NavItem[] = [
  { href: '/', label: msg.nav.dashboard, icon: Home },
  { href: '/envelopes', label: msg.nav.envelopes, icon: Wallet },
  { href: '/transactions', label: msg.nav.transactions, icon: ListOrdered },
  ...MORE_ITEMS.filter((i) => i.href !== '/settings'),
  { href: '/settings', label: msg.nav.settings, icon: Settings },
];
export const MORE_ICON = Menu;

export function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
}
