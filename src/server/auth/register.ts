/**
 * Registration flow - TD-02 §3.1
 * 
 * Server Action for user registration
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { getEnv } from '@/lib/env';
import { hashPassword, normalisePassword, isCommonPassword } from './password';
import { getPool } from '@/server/db/client';
import { uuidv7 } from 'uuidv7';
import { seedDefaultCategories } from '@/server/actions/categories';
import { Conflict, ValidationError } from '@/domain/errors';

const RegisterSchema = z.object({
  name: z.string().trim().min(1).max(60),
  email: z.string().email().max(254).toLowerCase(),
  password: z.string().min(10).max(128),
});

export const register = defineAction({
  name: 'auth.register',
  input: RegisterSchema,
  async run(ctx, input) {
    const env = getEnv();

    // Check registration is allowed
    if (!env.ALLOW_REGISTRATION) {
      throw new ValidationError({ registration: 'Registration is not allowed' });
    }

    // Validate password
    const normalisedPassword = normalisePassword(input.password);
    if (isCommonPassword(normalisedPassword)) {
      throw new ValidationError({ password: 'Password is too common' });
    }

    // Check password not equal to email local-part
    const emailLocal = input.email.split('@')[0] ?? '';
    if (normalisedPassword.toLowerCase() === emailLocal.toLowerCase()) {
      throw new ValidationError({ password: 'Password cannot be your email' });
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check for existing user
      const existing = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [input.email]
      );

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new Conflict('We could not create that account. If you already have one, try signing in.');
      }

      // Hash password
      const passwordHash = await hashPassword(normalisedPassword);
      const userId = uuidv7();

      // Insert user
      await client.query(
        `INSERT INTO users (id, name, email, password_hash, timezone, currency, theme, number_grouping, week_start)
         VALUES ($1, $2, $3, $4, 'Asia/Karachi', 'PKR', 'system', 'western', 1)`,
        [userId, input.name.trim(), input.email, passwordHash]
      );

      // Create session
      const sessionId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await client.query(
        `INSERT INTO sessions (id, user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [sessionId, userId, expiresAt]
      );

      await client.query('COMMIT');
      await seedDefaultCategories(userId, pool);

      return {
        userId,
        sessionId,
        redirectTo: '/onboarding',
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => [],
});
