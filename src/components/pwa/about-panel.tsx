'use client';

import { useState } from 'react';
import { isIosSafari, useInstall } from '@/lib/pwa-store';
import { msg } from '@/messages/en';

export function AboutPanel({ version }: { version: string }) {
  const { deferred, standalone, setDeferred } = useInstall();
  const [help, setHelp] = useState(false);
  const ios = typeof navigator !== 'undefined' && isIosSafari(navigator.userAgent, navigator.platform);
  return (
    <section className="card-surface grid gap-3 p-5">
      <p className="text-sm text-muted-foreground">{msg.pwa.version({ v: version })}</p>
      {!standalone && deferred && (
        <button type="button" className="btn-primary justify-self-start" onClick={async () => { await deferred.prompt(); await deferred.userChoice; setDeferred(null); }}>
          {msg.pwa.installCta()}
        </button>
      )}
      <button type="button" className="btn-secondary justify-self-start" aria-expanded={help} onClick={() => setHelp((v) => !v)}>
        {msg.pwa.installHelp()}
      </button>
      {help && <p className="text-sm">{ios ? msg.pwa.iosBody() : msg.pwa.installBody()} {msg.pwa.iosBody()}</p>}
    </section>
  );
}
