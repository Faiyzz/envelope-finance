/**
 * Domain error model - TD-00 §5
 * 
 * All domain errors extend DomainError and are caught in defineAction
 * to map to ActionResult. Never throw to the client except for unexpected bugs.
 */

import { formatMoney, type Paisa } from '@/domain/money';

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_FUNDS'
  | 'TIMELINE_VIOLATION'
  | 'RULE_VIOLATION'
  | 'DUPLICATE_SUSPECTED'
  | 'RATE_LIMITED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_FEATURE'
  | 'INTERNAL';

export abstract class DomainError extends Error {
  abstract code: ErrorCode;
  details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

export class ValidationError extends DomainError {
  code = 'VALIDATION' as const;
  constructor(public fieldErrors: Record<string, string>) {
    super('Validation failed', { fieldErrors });
  }
}

export class NotFound extends DomainError {
  code = 'NOT_FOUND' as const;
  constructor(public resource: string, public id: string = '') {
    super(`${resource} not found`, { resource, id });
  }
}

export class Conflict extends DomainError {
  code = 'CONFLICT' as const;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class InsufficientFunds extends DomainError {
  code = 'INSUFFICIENT_FUNDS' as const;
  constructor(
    public envelopeId: string,
    public available: bigint,
    public required: bigint,
    envelopeName?: string
  ) {
    super(
      envelopeName
        ? `${envelopeName} has only ${formatMoney(available as Paisa)} available.`
        : 'Insufficient funds',
      { envelopeId, available: available.toString(), required: required.toString() }
    );
  }
}

export class TimelineViolation extends DomainError {
  code = 'TIMELINE_VIOLATION' as const;
  constructor(
    public violation: Violation,
    public operation: OpContext
  ) {
    super(violation.message || 'Timeline violation', {
      date: violation.date,
      envelopeId: violation.envelopeId,
      shortfall: violation.shortfall.toString(),
      operation,
    });
  }
}

export class RuleViolation extends DomainError {
  code = 'RULE_VIOLATION' as const;
  public rule: string;
  public context: Record<string, unknown>;
  /** Accepts `(rule, ctx)` or a single context object carrying a `code`. */
  constructor(rule: string | Record<string, unknown>, context: Record<string, unknown> = {}) {
    const r = typeof rule === 'string' ? rule : String(rule.code ?? 'RULE_VIOLATION');
    const c = typeof rule === 'string' ? context : rule;
    super(`Rule violation: ${r}`, { rule: r, context: c });
    this.rule = r;
    this.context = c;
  }
}

export class DuplicateSuspected extends DomainError {
  code = 'DUPLICATE_SUSPECTED' as const;
  constructor(public details: Record<string, unknown>) {
    super('Looks like a duplicate — add anyway?', details);
  }
}

export class RateLimited extends DomainError {
  code = 'RATE_LIMITED' as const;
  constructor(public retryAfter: number) {
    super('Rate limited', { retryAfter });
  }
}

export class Unauthenticated extends DomainError {
  code = 'UNAUTHENTICATED' as const;
  constructor() {
    super('Authentication required');
  }
}

export class ForbiddenFeature extends DomainError {
  code = 'FORBIDDEN_FEATURE' as const;
  constructor(public feature: string) {
    super(`Feature not available: ${feature}`, { feature });
  }
}

// Types for timeline violations (will be expanded in TD-01)
export interface Violation {
  date: string;
  envelopeId?: string;
  shortfall: bigint;
  message: string;
}

export interface OpContext {
  type: string;
  entityId?: string;
  changes: Record<string, unknown>;
}

// Suggested actions for UI (TD-00 §5)
export interface SuggestedAction {
  kind: 'borrow' | 'add_money' | 'fund' | 'skip' | 'confirm_duplicate';
  envelopeId?: string;
  amount?: string;
  targetEnvelopeId?: string;
  label: string;
}

// ActionResult - the only shape returned to clients (TD-00 §5)
export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: ErrorCode;
        message: string;
        fieldErrors?: Record<string, string>;
        details?: Record<string, unknown>;
        actions?: SuggestedAction[];
        ref?: string;
      };
    };
