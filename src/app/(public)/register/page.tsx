'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { registerAction } from './actions';
import { msg } from '@/messages/en';

export default function RegisterPage() {
  const [state, action, pending] = useActionState(registerAction, undefined);
  return (
    <main className="mx-auto grid min-h-dvh max-w-sm content-center gap-5 px-4">
      <h1 className="text-2xl font-bold">{msg.auth.registerTitle()}</h1>
      <form action={action} className="grid gap-4">
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium">{msg.auth.name()}</label>
          <input id="name" name="name" type="text" autoComplete="name" required maxLength={60} className="h-12 w-full rounded-2xl border bg-background px-4" />
        </div>
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium">{msg.auth.email()}</label>
          <input id="email" name="email" type="email" autoComplete="username" required className="h-12 w-full rounded-2xl border bg-background px-4" />
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium">{msg.auth.password()}</label>
          <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} className="h-12 w-full rounded-2xl border bg-background px-4" />
          <p className="mt-1 text-sm text-muted-foreground">{msg.auth.passwordHint()}</p>
        </div>
        <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">{state?.error}</p>
        <button type="submit" disabled={pending} className="btn-primary">{pending ? msg.general.loading() : msg.auth.registerSubmit()}</button>
      </form>
      <Link href="/login" className="text-center text-sm font-medium text-primary">{msg.auth.haveAccount()}</Link>
    </main>
  );
}
