/**
 * Environment variable validation - TD-00 §9
 * 
 * Validated at boot by Zod. App refuses to start on invalid config.
 */

import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),
  DATABASE_URL_UNPOOLED: z.string().url(),

  // Auth
  AUTH_SECRET: z.string().min(32),
  AUTH_URL: z.string().url(),

  // Registration
  ALLOW_REGISTRATION: z.string().transform((val) => val === 'true').default('true'),

  // Seed
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(10).optional(),
  SEED_ADMIN_NAME: z.string().min(1).optional(),
  ALLOW_SEED: z.string().transform((val) => val === 'true').default('false'),

  // Cron
  CRON_SECRET: z.string().min(32),

  // Email (optional)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().transform(Number).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().email().optional(),

  // Sentry (optional)
  SENTRY_DSN: z.string().url().optional(),

  // App version
  APP_VERSION: z.string().default('dev'),
  NEXT_PUBLIC_APP_VERSION: z.string().default('dev'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  try {
    // blank values in .env mean "unset"
    cachedEnv = envSchema.parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));
    return cachedEnv;
  } catch (error) {
    console.error('Invalid environment configuration:');
    if (error instanceof z.ZodError) {
      console.error(error.errors);
    }
    throw new Error('Environment validation failed. Check .env.example for required variables.');
  }
}
