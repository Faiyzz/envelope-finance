'use server';

import { AuthError } from 'next-auth';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { msg } from '@/messages/en';
import { getEnv } from '@/lib/env';
import { hashPassword, normalisePassword } from '@/server/auth/password';
import { signIn } from '@/server/auth/config';
import { getPool } from '@/server/db/client';
import { seedDefaultCategories } from '@/server/actions/categories';

const RegisterFormSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(60, 'Name must be 60 characters or fewer'),
  email: z.string().trim().email('Enter a valid email').max(254),
  password: z.string().min(10, 'Use at least 10 characters').max(128, 'Password must be 128 characters or fewer'),
});

export async function registerAction(_prev: { error?: string } | undefined, formData: FormData) {
  if (!getEnv().ALLOW_REGISTRATION) {
    return { error: 'Registration is turned off.' };
  }

  const parsed = RegisterFormSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const name = parsed.data.name;
  const email = parsed.data.email.toLowerCase();
  const password = normalisePassword(parsed.data.password);
  const userId = uuidv7();
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query(
      `INSERT INTO users (id, name, email, password_hash, timezone, currency, theme, number_grouping, week_start)
       VALUES ($1, $2, $3, $4, 'Asia/Karachi', 'PKR', 'system', 'western', 1)`,
      [userId, name, email, await hashPassword(password)]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return { error: 'We could not create that account. If you already have one, try signing in.' };
    }
    console.error(error);
    return { error: msg.states.errorDefault() };
  } finally {
    client.release();
  }

  try {
    await seedDefaultCategories(userId, pool);
  } catch (error) {
    console.error(error);
  }

  try {
    await signIn('credentials', { email, password, redirectTo: '/onboarding' });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'Account created. Sign in with that email and password.' };
    }
    throw error;
  }
  return undefined;
}
