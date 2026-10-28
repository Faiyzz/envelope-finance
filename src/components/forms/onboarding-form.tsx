'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { runAction } from '@/app/ui-actions';
import { ActionForm } from '@/components/forms/action-form';
import { msg } from '@/messages/en';

export function OnboardingForm() {
  const router = useRouter();
  const [skipping, setSkipping] = useState(false);

  async function skip() {
    setSkipping(true);
    await runAction('skipOnboarding', {}).catch(() => null);
    router.push('/');
    router.refresh();
  }

  return (
    <div className="grid gap-4">
      <div className="card-surface p-5">
        <ActionForm
          action="completeOnboarding"
          submitLabel={msg.page.startSetup()}
          onDone={() => router.push('/')}
          fields={[
            { name: 'openingBalance', label: msg.page.openingBalance(), type: 'money', required: true },
            { name: 'name', label: msg.page.firstEnvelope(), type: 'text' },
            { name: 'allocate', label: msg.page.firstAllocation(), type: 'money' },
          ]}
          transform={({ openingBalance, name, allocate }) => ({
            openingBalance,
            envelopes: name ? [{ name, kind: 'standard', ownerType: 'mine', allocate: allocate ?? '0' }] : [],
          })}
        />
      </div>
      <button type="button" className="btn-secondary justify-self-center" onClick={skip} disabled={skipping}>{msg.page.skipSetup()}</button>
    </div>
  );
}
