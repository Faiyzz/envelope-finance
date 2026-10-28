/**
 * Logout actions - TD-02 §3.4
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser, revokeSession as revokeSessionDb, revokeAllSessions, listSessions as listSessionsDb } from './session';
import { signOut } from './config';

export const logout = defineAction({
  name: 'auth.logout',
  input: z.object({}),
  async run(ctx, input) {
    const { sid } = await requireUser();
    
    // Revoke session in DB
    await revokeSessionDb(sid);
    
    // Clear cookie via Auth.js
    // Note: This happens client-side by calling signOut()
    
    return { success: true };
  },
  revalidate: () => [],
});

export const logoutAllDevices = defineAction({
  name: 'auth.logoutAllDevices',
  input: z.object({}),
  async run(ctx, input) {
    const { userId } = await requireUser();
    
    await revokeAllSessions(userId);
    
    return { success: true };
  },
  revalidate: () => [],
});

export const revokeSessionAction = defineAction({
  name: 'auth.revokeSession',
  input: z.object({ sessionId: z.string() }),
  async run(ctx, input) {
    const { userId, sid } = await requireUser();
    
    // Revoke the specified session
    await revokeSessionDb(input.sessionId);
    
    // If revoking current session, return logout flag
    const isCurrent = input.sessionId === sid;
    
    return { success: true, isCurrent };
  },
  revalidate: () => [],
});

export const listSessionsAction = defineAction({
  name: 'auth.listSessions',
  input: z.object({}),
  async run(ctx, input) {
    const { userId, sid } = await requireUser();
    
    const sessions = await listSessionsDb(userId, sid);
    
    return { sessions };
  },
  revalidate: () => [],
});
