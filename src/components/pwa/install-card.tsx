'use client';

/** Android prompt card (after 3rd session) and one-time iOS help card - TD-12 §3. */

import { useEffect, useState } from 'react';
import { Share, X } from 'lucide-react';
import { isIosSafari, useInstall } from '@/lib/pwa-store';
import { msg } from '@/messages/en';

const DISMISSED = 'pwa-install-dismissed';
const IOS_SEEN = 'pwa-ios-help-seen';

export function InstallCard() {
  const { deferred, standalone, setDeferred } = useInstall();
  const [show, setShow] = useState<'android' | 'ios' | null>(null);

  useEffect(() => {
    if (standalone) return setShow(null);
    try {
      const sessions = Number(localStorage.getItem('pwa-sessions') ?? 0);
      if (deferred && sessions >= 3 && !localStorage.getItem(DISMISSED)) return setShow('android');
      if (!deferred && isIosSafari(navigator.userAgent, navigator.platform) && !localStorage.getItem(IOS_SEEN)) return setShow('ios');
    } catch {
      /* ignore */
    }
    setShow(null);
  }, [deferred, standalone]);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(show === 'ios' ? IOS_SEEN : DISMISSED, '1');
    } catch {
      /* ignore */
    }
    setShow(null);
  };

  return (
    <section aria-label={msg.pwa.installTitle()} className="card-surface relative flex items-start gap-3 p-4">
      <Share aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">{show === 'ios' ? msg.pwa.iosTitle() : msg.pwa.installTitle()}</p>
        <p className="text-muted-foreground">{show === 'ios' ? msg.pwa.iosBody() : msg.pwa.installBody()}</p>
        <div className="mt-2 flex gap-2">
          {show === 'android' ? (
            <>
              <button
                type="button"
                className="btn-primary min-h-11"
                onClick={async () => {
                  await deferred?.prompt();
                  await deferred?.userChoice;
                  setDeferred(null);
                  dismiss();
                }}
              >
                {msg.pwa.installCta()}
              </button>
              <button type="button" className="btn-secondary" onClick={dismiss}>{msg.pwa.notNow()}</button>
            </>
          ) : (
            <button type="button" className="btn-secondary" onClick={dismiss}>{msg.pwa.gotIt()}</button>
          )}
        </div>
      </div>
      <button type="button" className="icon-btn -me-2 -mt-2" aria-label={msg.quick.close()} onClick={dismiss}>
        <X aria-hidden="true" className="size-4" />
      </button>
    </section>
  );
}
