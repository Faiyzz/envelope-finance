/**
 * Analytics action - TD-09
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getAnalytics } from '@/server/repositories/analytics';
import { resolveRange, previousRange, type RangeKey } from '@/domain/analytics/ranges';
import { ValidationError } from '@/domain/errors';

const AnalyticsSchema = z.object({
  range: z.union([
    z.literal('this_month'),
    z.literal('prev_month'),
    z.literal('last_3'),
    z.literal('last_6'),
    z.literal('last_12'),
    z.object({
      custom: z.object({
        from: z.string(),
        to: z.string(),
      }),
    }),
  ]),
  includeHeld: z.boolean().default(false),
  includeDaily: z.boolean().default(false),
});

export const getAnalyticsData = defineAction({
  name: 'analytics.get',
  input: AnalyticsSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const today = new Date().toISOString().split('T')[0] as string;

    // Resolve range
    const resolved = resolveRange(input.range as RangeKey, today);

    // Validate custom range
    if (typeof input.range === 'object' && 'custom' in input.range) {
      const custom = input.range.custom;
      const customDate = new Date(custom.to);
      const todayDate = new Date(today);

      if (customDate > todayDate) {
        throw new ValidationError({ range: 'Custom range cannot end in the future' });
      }

      const fromDate = new Date(custom.from);
      const toDate = new Date(custom.to);

      if (fromDate > toDate) {
        throw new ValidationError({ range: 'From date must be before or equal to to date' });
      }

      // Validate span ≤ 5 years
      const spanYears = (toDate.getFullYear() - fromDate.getFullYear());
      if (spanYears > 5) {
        throw new ValidationError({ range: 'Custom range cannot exceed 5 years' });
      }
    }

    // Get previous period for comparison
    const prev = previousRange(resolved, today);

    // Get analytics data
    const data = await getAnalytics(userId, {
      from: resolved.from,
      to: resolved.to,
      includeHeld: input.includeHeld ?? false,
      includeDaily: input.includeDaily ?? false,
    });

    return {
      ...data,
      range: {
        from: resolved.from,
        to: resolved.to,
        label: resolved.label,
      },
    };
  },
  revalidate: () => [],
});
