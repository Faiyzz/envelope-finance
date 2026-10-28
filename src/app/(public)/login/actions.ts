'use server';

import { AuthError } from 'next-auth';
import { signIn } from '@/server/auth/config';
import { msg } from '@/messages/en';

export async function loginAction(_prev: { error?: string } | undefined, formData: FormData) {
  try {
    await signIn('credentials', {
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      redirectTo: '/',
    });
  } catch (e) {
    if (e instanceof AuthError) return { error: msg.auth.generic() }; // never reveal which part failed
    throw e; // the redirect on success is thrown by Next
  }
  return undefined;
}
