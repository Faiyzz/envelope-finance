/**
 * defineAction write pipeline - TD-00 §6, TD-01 §6-§7.
 *
 * Every mutation is declared through this wrapper so locking, idempotency,
 * timeline verification, ledger revision, audit, revalidation and error
 * mapping cannot be forgotten:
 *
 *   auth -> Zod parse (strict) -> ONE transaction under the per-user advisory lock
 *   -> idempotency lookup -> run -> verify touched accounts (apply -> verify ->
 *   rollback on violation) -> ledger_revision++ -> audit -> store idempotent
 *   response -> commit -> revalidate tags.
 */

import { z, ZodError } from 'zod';
import { randomBytes, createHash } from 'crypto';
import pino from 'pino';
import { uuidv7 } from 'uuidv7';
import {
  Conflict,
  DomainError,
  InsufficientFunds,
  ValidationError,
  type ActionResult,
  type SuggestedAction,
} from '@/domain/errors';
import { canonicalJson } from '@/domain/backup/canonical';
import { requireUser } from '@/server/auth/session';
import { runLocked, type Tx } from '@/server/db/withUserWrite';
import { verifyTimeline } from '@/server/backup/verify';
import { violationToError } from '@/server/db/violation';

const logger = pino({ level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' });

// Tag names for revalidation
export const tags = {
  dashboard: (userId: string) => `u:${userId}:dashboard`,
  envelope: (userId: string, envelopeId: string) => `u:${userId}:envelope:${envelopeId}`,
  transactions: (userId: string) => `u:${userId}:transactions`,
  analytics: (userId: string) => `u:${userId}:analytics`,
  recurring: (userId: string) => `u:${userId}:recurring`,
  reconciliation: (userId: string) => `u:${userId}:reconciliation`,
};

interface AuditEntry {
  entity: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
}

/** Write context passed to an action's run function. */
export interface WriteCtx {
  /** THE transaction client (already inside the per-user lock). */
  tx: Tx;
  userId: string;
  clock: { now: () => number };
  ref: string;
  /** Envelope ids whose timeline must be re-verified after the change (Unallocated is always included). */
  touchedAccounts: Set<string>;
  /** Register envelopes touched by the old AND new version of the change. */
  touch: (...envelopeIds: Array<string | null | undefined>) => void;
  /** Mark the transaction created/changed by this action (used to say "has only X available"). */
  setSubject: (txId: string, op?: 'create' | 'edit' | 'delete' | 'restore') => void;
  audit: (entity: string, entityId: string, action: string, before?: unknown, after?: unknown) => void;
  /** Declare that ledger-affecting data changed (bumps users.ledger_revision). */
  bumpLedger: () => void;
}

export interface ActionConfig<TInput, TOutput> {
  name: string;
  input: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  /** default true: honour `idempotencyKey` in the input when present */
  idempotent?: boolean;
  run: (ctx: WriteCtx, input: TInput) => Promise<TOutput>;
  revalidate?: (result: TOutput) => string[];
}

const bigintReplacer = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

function zodToValidation(e: ZodError): ValidationError {
  const fieldErrors: Record<string, string> = {};
  for (const issue of e.issues) fieldErrors[issue.path.join('.') || '_'] ??= issue.message;
  return new ValidationError(fieldErrors);
}

function mapError<T>(error: unknown, name: string, ref: string, startTime: number): ActionResult<T> {
  const duration = Date.now() - startTime;
  const err = error instanceof ZodError ? zodToValidation(error) : error;

  if (err instanceof DomainError) {
    logger.warn({ ref, action: name, code: err.code, duration }, 'Domain error');
    const actions: SuggestedAction[] | undefined =
      err instanceof InsufficientFunds
        ? [
            { kind: 'add_money', envelopeId: err.envelopeId, label: 'Add money to envelope' },
            { kind: 'borrow', envelopeId: err.envelopeId, amount: (err.required - err.available).toString(), label: 'Borrow from another envelope' },
          ]
        : undefined;
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        fieldErrors: (err.details as { fieldErrors?: Record<string, string> } | undefined)?.fieldErrors,
        actions,
      },
    };
  }

  logger.error({ ref, action: name, err: err instanceof Error ? err.message : 'unknown', duration }, 'Unexpected error');
  return { ok: false, error: { code: 'INTERNAL', message: `Something went wrong. Your data was not changed. Reference ${ref.slice(0, 8).toUpperCase()}.`, ref } };
}

/** Runs an action for a known user (the authenticated path resolves the user first). */
export async function executeAction<TInput, TOutput>(
  config: ActionConfig<TInput, TOutput>,
  userId: string,
  rawInput: unknown
): Promise<ActionResult<TOutput>> {
  const ref = randomBytes(8).toString('hex');
  const startTime = Date.now();

  try {
    const parsed = config.input.parse(rawInput);

    // mass-assignment guard: the user is never taken from input
    if (typeof parsed === 'object' && parsed !== null && ('user_id' in parsed || 'userId' in parsed)) {
      throw new ValidationError({ _: 'user_id cannot be provided in input' });
    }

    const idemKey =
      config.idempotent !== false && typeof parsed === 'object' && parsed !== null && 'idempotencyKey' in parsed
        ? String((parsed as { idempotencyKey: unknown }).idempotencyKey)
        : null;
    const { idempotencyKey: _k, ...hashable } = (parsed ?? {}) as Record<string, unknown>;
    const requestHash = createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(hashable, bigintReplacer)))).digest('hex');

    const outcome = await runLocked(userId, async (tx) => {
      // 1. idempotency (inside the lock, so concurrent retries cannot race)
      if (idemKey) {
        const hit = await tx.query(`SELECT request_hash, response FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND expires_at > now()`, [userId, idemKey]);
        const row = hit.rows[0];
        if (row) {
          if (row.request_hash !== requestHash) throw new Conflict('This request key was already used for a different action.');
          return { replayed: true as const, data: row.response as TOutput };
        }
      }

      // 2. run
      const touched = new Set<string>();
      let dirty = false;
      let subject: { id: string; op: 'create' | 'edit' | 'delete' | 'restore' } | null = null;
      const audits: AuditEntry[] = [];
      const ctx: WriteCtx = {
        tx,
        userId,
        clock: { now: () => Date.now() },
        ref,
        touchedAccounts: touched,
        touch: (...ids) => {
          for (const id of ids) if (id) touched.add(id);
          dirty = true;
        },
        setSubject: (id, op = 'create') => {
          subject = { id, op };
        },
        audit: (entity, entityId, action, before, after) => {
          audits.push({ entity, entityId, action, before, after });
        },
        bumpLedger: () => {
          dirty = true;
        },
      };
      const data = await config.run(ctx, parsed);

      // 3. apply -> verify -> rollback on violation
      if (touched.size > 0 || dirty) {
        const violation = await verifyTimeline(tx, userId, [...touched]);
        if (violation) {
          const s = subject as { id: string; op: 'create' | 'edit' | 'delete' | 'restore' } | null;
          throw await violationToError(tx, userId, violation, { createdTxId: s?.id, op: s?.op });
        }
      }

      // 4. ledger revision (reconciliation status, TD-08)
      if (dirty) await tx.query(`UPDATE users SET ledger_revision = ledger_revision + 1 WHERE id = $1`, [userId]);

      // 5. audit trail
      for (const a of audits) {
        await tx.query(
          `INSERT INTO audit_log (id, user_id, entity, entity_id, action, before_json, after_json) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [uuidv7(), userId, a.entity, a.entityId, a.action, a.before === undefined ? null : JSON.stringify(a.before, bigintReplacer), a.after === undefined ? null : JSON.stringify(a.after, bigintReplacer)]
        );
      }

      // 6. remember the response for retries (24 h)
      if (idemKey) {
        await tx.query(
          `INSERT INTO idempotency_keys (user_id, key, action, request_hash, response) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, key) DO NOTHING`,
          [userId, idemKey, config.name, requestHash, JSON.stringify(data ?? null, bigintReplacer)]
        );
      }
      return { replayed: false as const, data };
    });

    if (!outcome.replayed && config.revalidate) {
      try {
        const { revalidateTag } = await import('next/cache');
        for (const tag of config.revalidate(outcome.data)) revalidateTag(tag);
      } catch {
        /* outside the Next runtime (tests, CLI): nothing to revalidate */
      }
    }

    logger.info({ ref, action: config.name, duration: Date.now() - startTime, replayed: outcome.replayed }, 'Action completed');
    return { ok: true, data: outcome.data as TOutput };
  } catch (error) {
    return mapError<TOutput>(error, config.name, ref, startTime);
  }
}

export interface DefinedAction<TInput, TOutput> {
  (input: TInput): Promise<ActionResult<TOutput>>;
  /** Run as a specific user (tests, jobs). Same pipeline, no session lookup. */
  as: (userId: string, input: unknown) => Promise<ActionResult<TOutput>>;
}

export function defineAction<TInput, TOutput>(config: ActionConfig<TInput, TOutput>): DefinedAction<TInput, TOutput> {
  const fn = (async (input: TInput): Promise<ActionResult<TOutput>> => {
    let userId: string;
    try {
      userId = (await requireUser()).userId;
    } catch {
      return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.' } };
    }
    return executeAction(config, userId, input);
  }) as DefinedAction<TInput, TOutput>;
  fn.as = (userId, input) => executeAction(config, userId, input);
  return fn;
}
