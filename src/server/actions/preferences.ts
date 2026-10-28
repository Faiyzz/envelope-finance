/**
 * Preferences actions - TD-03 §3.1
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { ValidationError } from '@/domain/errors';

const UpdatePreferencesSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  numberGrouping: z.enum(['western', 'lakh']).optional(),
  weekStart: z.number().int().min(0).max(6).optional(),
  hideBalancesDefault: z.boolean().optional(),
  timezone: z.string().optional(),
});

export const updatePreferences = defineAction({
  name: 'settings.updatePreferences',
  input: UpdatePreferencesSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();

    // Validate timezone if provided
    if (input.timezone) {
      const supportedTimezones = Intl.supportedValuesOf('timeZone');
      if (!supportedTimezones.includes(input.timezone)) {
        throw new ValidationError({ timezone: 'Invalid timezone' });
      }
    }

    const pool = getPool();
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (input.theme !== undefined) {
      updates.push(`theme = $${paramIndex++}`);
      values.push(input.theme);
    }
    if (input.numberGrouping !== undefined) {
      updates.push(`number_grouping = $${paramIndex++}`);
      values.push(input.numberGrouping);
    }
    if (input.weekStart !== undefined) {
      updates.push(`week_start = $${paramIndex++}`);
      values.push(input.weekStart);
    }
    if (input.hideBalancesDefault !== undefined) {
      updates.push(`hide_balances_default = $${paramIndex++}`);
      values.push(input.hideBalancesDefault);
    }
    if (input.timezone !== undefined) {
      updates.push(`timezone = $${paramIndex++}`);
      values.push(input.timezone);
    }

    if (updates.length === 0) {
      return { success: true };
    }

    values.push(userId);

    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    return { success: true };
  },
  revalidate: () => ['/'],
});
