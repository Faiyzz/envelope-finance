/**
 * Password reset - TD-02 §3.5
 * 
 * Only used when SMTP is configured
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { getEnv } from '@/lib/env';
import { hashPassword, verifyPassword, hashToken, generateToken, normalisePassword, isCommonPassword } from './password';
import { getPool } from '@/server/db/client';
import { uuidv7 } from 'uuidv7';
import { Conflict, ValidationError } from '@/domain/errors';

const RequestResetSchema = z.object({
  email: z.string().email(),
});

const ResetPasswordSchema = z.object({
  token: z.string(),
  newPassword: z.string().min(10).max(128),
});

/**
 * Request password reset
 * Always returns the same message (no enumeration)
 */
export const requestPasswordReset = defineAction({
  name: 'auth.requestPasswordReset',
  input: RequestResetSchema,
  async run(ctx, input) {
    const env = getEnv();

    // Check if SMTP is configured
    if (!env.SMTP_HOST) {
      throw new ValidationError({ email: 'Password reset is not configured' });
    }

    const normalisedEmail = input.email.toLowerCase().trim();
    const pool = getPool();
    const client = await pool.connect();

    try {
      // Look up user by email
      const result = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [normalisedEmail]
      );

      // If user exists, create token and send email
      if (result.rows.length > 0) {
        const userId = result.rows[0].id;
        const token = generateToken();
        const tokenHash = hashToken(token);
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

        await client.query(
          `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [uuidv7(), userId, tokenHash, expiresAt]
        );

        // TODO: Send email with reset link
        // Link: /reset-password/${token}
      }

      // Always return success (no enumeration)
      return { success: true };
    } finally {
      client.release();
    }
  },
  revalidate: () => [],
});

/**
 * Reset password with token
 */
export const resetPassword = defineAction({
  name: 'auth.resetPassword',
  input: ResetPasswordSchema,
  async run(ctx, input) {
    const env = getEnv();

    if (!env.SMTP_HOST) {
      throw new ValidationError({ token: 'Password reset is not configured' });
    }

    const normalisedPasswordInput = normalisePassword(input.newPassword);

    // Validate password
    if (isCommonPassword(normalisedPasswordInput)) {
      throw new ValidationError({ newPassword: 'Password is too common' });
    }

    const tokenHash = hashToken(input.token);
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Find valid token
      const tokenResult = await client.query(
        `SELECT id, user_id, used_at 
         FROM password_reset_tokens 
         WHERE token_hash = $1 AND expires_at > now() AND used_at IS NULL`,
        [tokenHash]
      );

      if (tokenResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new ValidationError({ token: 'Invalid or expired token' });
      }

      const tokenRow = tokenResult.rows[0];
      const userId = tokenRow.user_id;

      // Hash new password
      const passwordHash = await hashPassword(normalisedPasswordInput);

      // Update password
      await client.query(
        `UPDATE users 
         SET password_hash = $1, password_changed_at = now()
         WHERE id = $2`,
        [passwordHash, userId]
      );

      // Mark token as used
      await client.query(
        'UPDATE password_reset_tokens SET used_at = now() WHERE id = $1',
        [tokenRow.id]
      );

      // Revoke all sessions
      await client.query(
        `UPDATE sessions 
         SET revoked_at = now() 
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );

      await client.query('COMMIT');

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => [],
});
