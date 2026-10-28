/**
 * Session helpers - TD-02 §3.3
 * 
 * requireUser() validates JWT sid against sessions table
 */

import { auth } from './config';
import { Unauthenticated } from '@/domain/errors';
import { getPool } from '@/server/db/client';

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

/**
 * Get current session without throwing
 */
export async function getSession(): Promise<{ userId: string; sid: string; user: UserCtx } | null> {
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  const { uid, sid } = session.user as { uid: string; sid: string };
  const pool = getPool();
  const client = await pool.connect();

  try {
    // Check session is active
    const sessionResult = await client.query(
      `SELECT s.user_id, s.last_seen_at, s.expires_at,
              u.name, u.email, u.timezone, u.theme, u.number_grouping, u.week_start, u.onboarding_completed_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sid, uid]
    );

    if (sessionResult.rows.length === 0) {
      return null;
    }

    const row = sessionResult.rows[0];
    const lastSeen = new Date(row.last_seen_at);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    // Rolling session: extend if last seen > 5 min ago
    if (lastSeen < fiveMinutesAgo) {
      const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await client.query(
        `UPDATE sessions 
         SET last_seen_at = now(), expires_at = $1
         WHERE id = $2`,
        [newExpiresAt, sid]
      );
    }

    return {
      userId: uid,
      sid,
      user: {
        id: row.user_id,
        name: row.name,
        email: row.email,
        timezone: row.timezone,
        theme: row.theme,
        numberGrouping: row.number_grouping,
        weekStart: row.week_start,
        onboardingCompletedAt: row.onboarding_completed_at,
      },
    };
  } finally {
    client.release();
  }
}

/**
 * Require authenticated user, throw Unauthenticated if not logged in
 */
export async function requireUser(): Promise<{ userId: string; sid: string; user: UserCtx }> {
  const session = await getSession();
  if (!session) {
    throw new Unauthenticated();
  }
  return session;
}

/**
 * Revoke current session
 */
export async function revokeSession(sid: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1`,
    [sid]
  );
}

/**
 * Revoke all sessions for a user
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE sessions SET revoked_at = now() 
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

/**
 * List active sessions for a user
 */
export async function listSessions(userId: string, currentSid: string): Promise<
  Array<{ id: string; device: string; createdAt: Date; lastSeenAt: Date; current: boolean }>
> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, user_agent, created_at, last_seen_at
     FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows.map((row: any) => ({
    id: row.id,
    device: parseUserAgent(row.user_agent),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    current: row.id === currentSid,
  }));
}

function parseUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  
  // Simple parsing - in production would use a proper UA parser
  if (userAgent.includes('Mobile')) {
    if (userAgent.includes('Android')) return 'Android';
    if (userAgent.includes('iPhone') || userAgent.includes('iPad')) return 'iOS';
    return 'Mobile';
  }
  
  if (userAgent.includes('Chrome')) return 'Chrome';
  if (userAgent.includes('Firefox')) return 'Firefox';
  if (userAgent.includes('Safari')) return 'Safari';
  
  return 'Desktop';
}
