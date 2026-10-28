/**
 * Account management - TD-02 §3.5, §3.6
 * 
 * Password change, email change, account deletion
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser, revokeAllSessions } from './session';
import { hashPassword, verifyPassword, normalisePassword, isCommonPassword } from './password';
import { getPool } from '@/server/db/client';
import { Conflict, ValidationError } from '@/domain/errors';

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(128),
});

const ChangeEmailSchema = z.object({
  password: z.string().min(1),
  newEmail: z.string().email().max(254),
});

const DeleteAccountSchema = z.object({
  password: z.string().min(1),
  confirmation: z.string().refine((v) => v === 'DELETE'),
});

export const changePassword = defineAction({
  name: 'auth.changePassword',
  input: ChangePasswordSchema,
  async run(ctx, input) {
    const { userId, sid } = await requireUser();

    const normalisedCurrent = normalisePassword(input.currentPassword);
    const normalisedNew = normalisePassword(input.newPassword);

    // Validate new password
    if (isCommonPassword(normalisedNew)) {
      throw new ValidationError({ newPassword: 'Password is too common' });
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get current password hash
      const result = await client.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        throw new ValidationError({ currentPassword: 'Invalid password' });
      }

      // Verify current password
      const isValid = await verifyPassword(result.rows[0].password_hash, normalisedCurrent);
      if (!isValid) {
        throw new ValidationError({ currentPassword: 'Invalid password' });
      }

      // Hash new password
      const newHash = await hashPassword(normalisedNew);

      // Update password
      await client.query(
        `UPDATE users 
         SET password_hash = $1, password_changed_at = now()
         WHERE id = $2`,
        [newHash, userId]
      );

      // Revoke all sessions except current
      await client.query(
        `UPDATE sessions 
         SET revoked_at = now() 
         WHERE user_id = $1 AND id != $2 AND revoked_at IS NULL`,
        [userId, sid]
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

export const changeEmail = defineAction({
  name: 'auth.changeEmail',
  input: ChangeEmailSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();

    const normalisedPassword = normalisePassword(input.password);
    const normalisedEmail = input.newEmail.toLowerCase().trim();

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Verify current password
      const userResult = await client.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new ValidationError({ password: 'Invalid password' });
      }

      const isValid = await verifyPassword(userResult.rows[0].password_hash, normalisedPassword);
      if (!isValid) {
        throw new ValidationError({ password: 'Invalid password' });
      }

      // Check email uniqueness
      const existing = await client.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [normalisedEmail, userId]
      );

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new Conflict('Email is already in use');
      }

      // Update email
      await client.query(
        'UPDATE users SET email = $1 WHERE id = $2',
        [normalisedEmail, userId]
      );

      // TODO: Send notice to old address if SMTP configured

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

export const deleteAccount = defineAction({
  name: 'auth.deleteAccount',
  input: DeleteAccountSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();

    const normalisedPassword = normalisePassword(input.password);

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Verify password
      const userResult = await client.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new ValidationError({ password: 'Invalid password' });
      }

      const isValid = await verifyPassword(userResult.rows[0].password_hash, normalisedPassword);
      if (!isValid) {
        throw new ValidationError({ password: 'Invalid password' });
      }

      // Delete user (cascades to all data)
      await client.query('DELETE FROM users WHERE id = $1', [userId]);

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
