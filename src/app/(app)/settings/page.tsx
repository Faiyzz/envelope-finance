import Link from 'next/link';
import { ChevronRight, Database } from 'lucide-react';
import { msg } from '@/messages/en';

export default function SettingsIndex() {
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold">{msg.nav.settings()}</h1>
      <ul className="card-surface divide-y">
        <li>
          <Link href="/settings/data" className="flex min-h-14 items-center justify-between gap-3 p-4">
            <span className="flex items-center gap-3"><Database aria-hidden="true" className="size-5 text-muted-foreground" />{msg.data.dataLink()}</span>
            <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground rtl:rotate-180" />
          </Link>
        </li>
        <li>
          <Link href="/transactions/deleted" className="flex min-h-14 items-center justify-between gap-3 p-4">
            <span>{msg.page.deleted()}</span>
            <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground rtl:rotate-180" />
          </Link>
        </li>
        <li>
          <Link href="/settings/about" className="flex min-h-14 items-center justify-between gap-3 p-4">
            <span>{msg.pwa.aboutTitle()}</span>
            <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground rtl:rotate-180" />
          </Link>
        </li>
      </ul>
    </div>
  );
}
