'use client';

import { useActionState } from 'react';
import { loginAction } from './actions';
import { msg } from '@/messages/en';

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return (
    <main className="mx-auto grid min-h-dvh max-w-sm content-center gap-5 px-4">
      <h1 className="text-2xl font-bold">{msg.auth.title()}</h1>
      <form action={action} className="grid gap-4">
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium">{msg.auth.email()}</label>
          <input id="email" name="email" type="email" autoComplete="username" required className="h-12 w-full rounded-2xl border bg-background px-4" />
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium">{msg.auth.password()}</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required className="h-12 w-full rounded-2xl border bg-background px-4" />
        </div>
        <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">{state?.error}</p>
        <button type="submit" disabled={pending} className="btn-primary">{pending ? msg.general.loading() : msg.auth.submit()}</button>
      </form>
    </main>
  );
}
