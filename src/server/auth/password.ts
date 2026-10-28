/**
 * Password hashing - TD-02 §1, §4
 * 
 * Uses argon2id via @node-rs/argon2
 * OWASP minimum params: memory 19 MiB, iterations 2, parallelism 1
 */

import { hash, verify } from '@node-rs/argon2';
import crypto from 'crypto';

const HASH_OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Hash a password using argon2id
 */
export async function hashPassword(password: string): Promise<string> {
  return await hash(password, HASH_OPTIONS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return await verify(hash, password);
}

/**
 * Check if a hash needs rehashing (params changed)
 */
export async function needsRehash(encoded: string): Promise<boolean> {
  // $argon2id$v=19$m=19456,t=2,p=1$salt$hash
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encoded);
  if (!m) return true;
  return (
    Number(m[1]) !== HASH_OPTIONS.memoryCost ||
    Number(m[2]) !== HASH_OPTIONS.timeCost ||
    Number(m[3]) !== HASH_OPTIONS.parallelism
  );
}

/**
 * Hash IP address with AUTH_SECRET for storage (never raw IP)
 */
export function hashIp(ip: string, secret: string): string {
  return crypto.createHash('sha256').update(ip + secret).digest('hex');
}

/**
 * Hash a token for storage (password reset, etc.)
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a random token (base64url)
 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Common password list - top 10k (simplified for V1)
 * In production, load from bundled file
 */
const COMMON_PASSWORDS = new Set([
  'password', '123456', '12345678', 'qwerty', 'abc123',
  'monkey', 'letmein', 'dragon', '111111', 'baseball',
  // ... would be loaded from file in production
]);

/**
 * Check if password is in common password list
 */
export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

/**
 * NFKC-normalise password before hashing
 */
export function normalisePassword(password: string): string {
  return password.normalize('NFKC');
}
