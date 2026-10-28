/**
 * Auth.js v5 configuration - TD-02 §1, §3
 * 
 * Credentials provider with JWT sessions
 * JWT carries { uid, sid }, sid checked against sessions table
 */

import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { hashPassword, verifyPassword, normalisePassword, isCommonPassword } from './password';
import { getPool } from '@/server/db/client';

// JWT session data
export interface SessionData {
  uid: string;
  sid: string;
}

// User context returned to app
export interface UserCtx {
  id: string;
  name: string;
  email: string;
  timezone: string;
  theme: string;
  numberGrouping: string;
  weekStart: number;
  onboardingCompletedAt: Date | null;
}

// Login input schema
const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
    updateAge: 24 * 60 * 60, // 1 day rolling
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const parsed = LoginSchema.safeParse(credentials);
        if (!parsed.success) {
          return null;
        }

        const { email, password } = parsed.data;
        const normalisedEmail = email.toLowerCase().trim();
        const normalisedPassword = normalisePassword(password);

        const pool = getPool();
        const client = await pool.connect();

        try {
          // Look up user via SECURITY DEFINER function
          const result = await client.query(
            'SELECT id, password_hash, locked_until, failed_login_count FROM auth_find_user($1)',
            [normalisedEmail]
          );

          const user = result.rows[0];

          // Timing equalisation: verify against dummy hash if user not found
          const dummyHash = await hashPassword('dummy-password-for-timing');
          if (!user) {
            await verifyPassword(dummyHash, normalisedPassword);
            // Record failed attempt
            await recordLoginAttempt(client, normalisedEmail, null, false);
            return null;
          }

          // Check lockout
          if (user.locked_until && new Date(user.locked_until) > new Date()) {
            await verifyPassword(dummyHash, normalisedPassword);
            return null;
          }

          // Verify password
          const isValid = await verifyPassword(user.password_hash, normalisedPassword);
          if (!isValid) {
            await recordLoginAttempt(client, normalisedEmail, user.id, false);
            return null;
          }

          // Success: reset failed count, clear lockout, record success
          await client.query(
            `UPDATE users 
             SET failed_login_count = 0, locked_until = NULL 
             WHERE id = $1`,
            [user.id]
          );
          await recordLoginAttempt(client, normalisedEmail, user.id, true);

          // Create session
          const sessionId = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
          await client.query(
            `INSERT INTO sessions (id, user_id, expires_at)
             VALUES ($1, $2, $3)`,
            [sessionId, user.id, expiresAt]
          );

          // Return session data for JWT
          return {
            id: user.id,
            uid: user.id,
            sid: sessionId,
          };
        } finally {
          client.release();
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as unknown as { uid: string; sid: string };
        token.uid = u.uid;
        token.sid = u.sid;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.uid && token.sid) {
        session.user = {
          id: token.uid as string,
          uid: token.uid as string,
          sid: token.sid as string,
        } as unknown as typeof session.user;
      }
      return session;
    },
  },
});

async function recordLoginAttempt(
  client: any,
  email: string,
  userId: string | null,
  succeeded: boolean
): Promise<void> {
  // TODO: Get IP hash from request context
  const ipHash = 'placeholder-ip-hash';
  
  await client.query(
    `INSERT INTO login_attempts (email, ip_hash, succeeded)
     VALUES ($1, $2, $3)`,
    [email, ipHash, succeeded]
  );

  // Update failed_login_count if this was a failure
  if (!succeeded && userId) {
    await client.query(
      `UPDATE users 
       SET failed_login_count = failed_login_count + 1
       WHERE id = $1`,
      [userId]
    );
  }
}
