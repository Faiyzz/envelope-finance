> **⚠ SUPERSEDED.** This single-file v1.0 contained invalid SQL, an incorrect posting view, impure/buggy sample code and missing feature designs (see `docs/technical-design/GAP_ANALYSIS.md`). The authoritative design is now the split set in `docs/technical-design/` (start at `README.md`). This file is kept only for history; do not implement from it.

# Envelope Finance App — Technical Design Document v1.0

**Purpose:** This document provides a complete technical blueprint for implementing the Envelope Finance App. Any AI or developer should be able to implement the entire system using this document without referring to the original URD.

**Product:** Mobile-first PWA for virtual-envelope money management over ONE real bank balance (PKR).

**Target Audience:** AI coding agents, developers implementing the system.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [Architecture](#3-architecture)
4. [Data Model](#4-data-model)
5. [Core Business Logic](#5-core-business-logic)
6. [API Design](#6-api-design)
7. [Security Model](#7-security-model)
8. [UI/UX Architecture](#8-uiux-architecture)
9. [Implementation Phases](#9-implementation-phases)
10. [Testing Strategy](#10-testing-strategy)
11. [Deployment Strategy](#11-deployment-strategy)
12. [Critical Implementation Notes](#12-critical-implementation-notes)

---

## 1. System Overview

### 1.1 Core Concept

The app manages a single real bank account by virtually dividing money into **envelopes** (purposes or people) plus an **Unallocated** pool. Key principles:

- **Expected Total Balance** = Sum of all envelope balances + Unallocated (derived from ledger)
- **Actual Bank Balance** = User manually enters from their bank statement
- **Reconciliation** = Manual comparison; app never auto-corrects
- **Money** = Integer paisa (1 PKR = 100 paisa), stored as BIGINT
- **Single currency** = PKR only
- **Single user** = No shared/family accounts in V1

### 1.2 Key Domain Concepts

| Concept | Technical Definition |
|---------|----------------------|
| **Total Balance** | Σ effect on Total of all non-deleted transactions |
| **Envelope** | Virtual pot with balance, owner_type ('mine'/'other'), kind ('standard'/'savings') |
| **Unallocated** | Total − Σ(all envelope balances) — derived, never stored |
| **Your Money** | Unallocated + Σ(envelopes where owner_type='mine') |
| **Held for Others** | Σ(envelopes where owner_type='other') |
| **Internal Loan** | Money moved between 'mine' envelopes, tracked until repaid |
| **Reconciliation** | Snapshot of Expected vs Actual bank balance |

### 1.3 Out of Scope for V1

- Bank APIs, auto-import
- Multiple currencies
- Investments/crypto/stocks
- Credit cards
- Tax, forecasting
- Shared/family accounts
- Collaborative envelopes
- Physical-cash account
- Budget-limit alerts
- Offline write queue

---

## 2. Technology Stack

### 2.1 Core Stack

| Layer | Technology | Version/Notes |
|-------|-----------|---------------|
| **Frontend Framework** | Next.js | App Router, latest stable |
| **Language** | TypeScript | Strict mode enabled |
| **Styling** | Tailwind CSS | With shadcn/ui components |
| **UI Components** | shadcn/ui | Radix UI primitives |
| **Animations** | Framer Motion | Respect prefers-reduced-motion |
| **Charts** | Recharts | Responsive, accessible |
| **Validation** | Zod | All server inputs |
| **ORM** | Drizzle ORM | Or Prisma (choose one) |
| **Database** | PostgreSQL | Neon or Supabase |
| **Authentication** | Auth.js | Credentials provider |
| **Session** | Auth.js | Database or JWT sessions |
| **PWA** | Serwist | Service worker integration |
| **Deployment** | Vercel | Recommended platform |

### 2.2 Development Tools

- **Package Manager:** pnpm or npm
- **Linting:** ESLint + TypeScript ESLint
- **Formatting:** Prettier
- **Testing:** Vitest (unit), Playwright (E2E), fast-check (property-based)
- **Git Hooks:** Husky (pre-commit, pre-push)

### 2.3 Environment Variables

```env
# Database
DATABASE_URL="postgresql://..."

# Auth
AUTH_SECRET="<random 32+ chars>"
AUTH_URL="http://localhost:3000"

# Registration Control
ALLOW_REGISTRATION="true"  # false in production for personal app

# Seed Admin (optional, dev only)
SEED_ADMIN_EMAIL="admin@example.com"
SEED_ADMIN_PASSWORD="..."
SEED_ADMIN_NAME="Admin"
ALLOW_SEED="false"  # true only in dev

# Cron Job
CRON_SECRET="<random string>"

# Email (optional, for password reset)
SMTP_HOST="..."
SMTP_PORT="587"
SMTP_USER="..."
SMTP_PASSWORD="..."
SMTP_FROM="..."

# Observability (optional)
SENTRY_DSN="..."
```

---

## 3. Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Client Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Next.js    │  │   React      │  │   PWA SW     │      │
│  │  App Router  │  │  Components  │  │  (Serwist)   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP/HTTPS
                              │
┌─────────────────────────────────────────────────────────────┐
│                      Server Layer (Next.js)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Server Actions│  │  API Routes │  │  Auth.js     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│                    Business Logic Layer                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Ledger Module│  │ Validation   │  │ Money Utils  │      │
│  │ (Pure TS)    │  │ Engine       │  │ (Pure TS)    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│                      Data Access Layer                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Drizzle ORM │  │  SQL Views   │  │  Queries     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│                      PostgreSQL Database                     │
│  Users, Envelopes, Transactions, Loans, Recurring, etc.     │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Layer Responsibilities

#### Client Layer
- Render UI components
- Handle user interactions
- Manage optimistic updates with rollback
- Cache read-only data for offline
- PWA installation and service worker

#### Server Layer
- Authenticate requests (Auth.js)
- Authorize user access (session.user.id)
- Orchestrate business logic
- Handle API responses
- Rate limiting and security headers

#### Business Logic Layer (CRITICAL: Framework-Free)
- **Ledger Module:** Core money calculations, balance derivation
- **Validation Engine:** Timeline validation, invariant checking
- **Money Utils:** Parse, format, add, subtract paisa values
- **Loan Math:** Calculate remaining amounts
- **Recurrence Engine:** Generate occurrence dates

**All domain logic MUST be in pure TypeScript with NO framework dependencies.** This enables:
- Exhaustive unit testing
- Property-based testing
- Reusability across contexts

#### Data Access Layer
- Drizzle ORM queries
- SQL views for ledger effects
- Transaction management
- Connection pooling

### 3.3 Key Architectural Patterns

#### 3.3.1 Single Source of Truth
- **Balances are NEVER stored as authoritative columns**
- All balances derived from transaction ledger via SQL aggregation
- Cached values allowed but must be rebuildable and verified

#### 3.3.2 Timeline Validation
- Every write (create/edit/delete/restore) validates the entire timeline
- Replay ledger in canonical order: `occurred_on, occurred_at, created_at, id`
- Reject if any envelope balance < 0 or Unallocated < 0 at ANY point

#### 3.3.3 User Scoping
- Every database query MUST filter by `user_id`
- Composite foreign keys prevent cross-user references
- Automated IDOR tests for every endpoint

#### 3.3.4 Soft Delete
- Transactions soft-deleted (`deleted_at`, `deleted_by`)
- Excluded from all calculations
- Restorable within 30 days
- Audit trail preserved

#### 3.3.5 Idempotency
- Every create endpoint accepts client-generated `idempotency_key` (UUID)
- Re-submitting same key returns original result
- Keys stored for 24h per user

#### 3.3.6 Optimistic Concurrency
- Edits use `version` field or `updated_at`
- Mismatch → 409 Conflict with reload message
- No silent overwrites

---

## 4. Data Model

### 4.1 Schema Conventions

- **ID:** UUID v7 or cuid for all tables
- **User scoping:** Every table has `user_id` FK with `ON DELETE CASCADE`
- **Timestamps:** `created_at`, `updated_at` on all tables
- **Composite uniqueness:** Prevent cross-user references (e.g., `(user_id, id)` unique on parents, composite FK on children)
- **Money:** `BIGINT` storing paisa (1 PKR = 100 paisa)
- **Dates:** `DATE` for `occurred_on`, `TIME` for `occurred_at`, `TIMESTAMPTZ` for server timestamps

### 4.2 Database Schema

#### `users`

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
  currency TEXT NOT NULL DEFAULT 'PKR',
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  onboarding_completed_at TIMESTAMPTZ,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
```

#### `envelopes`

```sql
CREATE TABLE envelopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT '💼',
  color TEXT,
  owner_type TEXT NOT NULL DEFAULT 'mine' CHECK (owner_type IN ('mine', 'other')),
  owner_name TEXT CHECK (owner_name IS NOT NULL WHEN owner_type = 'other'),
  kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'savings')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, LOWER(name)) WHERE status = 'active',
  CHECK (owner_type = 'other' → owner_name IS NOT NULL)
);

CREATE INDEX idx_envelopes_user_id ON envelopes(user_id);
CREATE INDEX idx_envelopes_status ON envelopes(user_id, status);
```

#### `categories`

```sql
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  group_name TEXT CHECK (group_name IN ('home', 'personal', 'other')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, kind, LOWER(name))
);

CREATE INDEX idx_categories_user_id ON categories(user_id);
CREATE INDEX idx_categories_kind ON categories(user_id, kind);
```

#### `transactions`

```sql
CREATE TYPE transaction_type AS ENUM (
  'opening_balance', 'income', 'external_deposit', 'expense',
  'external_withdrawal', 'allocation', 'deallocation', 'transfer',
  'loan', 'loan_repayment', 'adjustment'
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type transaction_type NOT NULL,
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa > 0 OR type = 'adjustment'),
  occurred_on DATE NOT NULL,
  occurred_at TIME DEFAULT '12:00:00',
  envelope_id UUID REFERENCES envelopes(id),
  counterpart_envelope_id UUID REFERENCES envelopes(id),
  category_id UUID REFERENCES categories(id),
  note TEXT CHECK (LENGTH(note) <= 500),
  loan_id UUID,
  recurring_id UUID,
  is_generated BOOLEAN NOT NULL DEFAULT FALSE,
  parent_transaction_id UUID,
  idempotency_key UUID,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- CHECK constraints per type (simplified here, implement in full)
  CHECK (
    (type = 'loan' → envelope_id IS NOT NULL AND counterpart_envelope_id IS NOT NULL AND loan_id IS NOT NULL AND envelope_id <> counterpart_envelope_id) AND
    (type = 'expense' → envelope_id IS NOT NULL AND category_id IS NOT NULL) AND
    (type = 'income' → envelope_id IS NULL) AND
    (type = 'allocation' → envelope_id IS NOT NULL) AND
    (type = 'transfer' → envelope_id IS NOT NULL AND counterpart_envelope_id IS NOT NULL AND envelope_id <> counterpart_envelope_id)
  )
);

CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_occurred ON transactions(user_id, occurred_on DESC, occurred_at DESC);
CREATE INDEX idx_transactions_envelope ON transactions(user_id, envelope_id);
CREATE INDEX idx_transactions_category ON transactions(user_id, category_id);
CREATE INDEX idx_transactions_type ON transactions(user_id, type);
CREATE INDEX idx_transactions_loan ON transactions(user_id, loan_id);
CREATE INDEX idx_transactions_recurring ON transactions(user_id, recurring_id);
CREATE INDEX idx_transactions_deleted ON transactions(user_id, deleted_at);
```

#### `transaction_splits` (income only)

```sql
CREATE TABLE transaction_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  envelope_id UUID NOT NULL REFERENCES envelopes(id),
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(transaction_id, envelope_id)
);

CREATE INDEX idx_splits_user ON transaction_splits(user_id);
CREATE INDEX idx_splits_transaction ON transaction_splits(transaction_id);
```

#### `loans`

```sql
CREATE TABLE loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lender_envelope_id UUID NOT NULL REFERENCES envelopes(id),
  borrower_envelope_id UUID NOT NULL REFERENCES envelopes(id),
  original_amount_paisa BIGINT NOT NULL CHECK (original_amount_paisa > 0),
  remaining_amount_paisa BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paid')),
  loan_date DATE NOT NULL,
  note TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (lender_envelope_id <> borrower_envelope_id)
);

CREATE INDEX idx_loans_user ON loans(user_id);
CREATE INDEX idx_loans_lender ON loans(user_id, lender_envelope_id);
CREATE INDEX idx_loans_borrower ON loans(user_id, borrower_envelope_id);
CREATE INDEX idx_loans_status ON loans(user_id, status);
```

#### `loan_repayments`

```sql
CREATE TABLE loan_repayments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loan_id UUID NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id),
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa > 0),
  repaid_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_repayments_user ON loan_repayments(user_id);
CREATE INDEX idx_repayments_loan ON loan_repayments(loan_id);
```

#### `recurring_rules`

```sql
CREATE TYPE frequency_type AS ENUM ('weekly', 'monthly', 'yearly', 'custom_days');

CREATE TABLE recurring_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa > 0),
  envelope_id UUID REFERENCES envelopes(id),
  category_id UUID REFERENCES categories(id),
  split_template_json JSONB,
  frequency frequency_type NOT NULL DEFAULT 'monthly',
  interval_n INTEGER NOT NULL DEFAULT 1 CHECK (interval_n > 0),
  anchor_day INTEGER CHECK (anchor_day BETWEEN 1 AND 31),
  start_date DATE NOT NULL,
  end_date DATE,
  max_occurrences INTEGER,
  occurrences_generated INTEGER NOT NULL DEFAULT 0,
  next_due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'ended')),
  is_committee BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recurring_user ON recurring_rules(user_id);
CREATE INDEX idx_recurring_status ON recurring_rules(user_id, status);
CREATE INDEX idx_recurring_next_due ON recurring_rules(next_due_date) WHERE status = 'active';
```

#### `recurring_occurrences`

```sql
CREATE TABLE recurring_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES recurring_rules(id) ON DELETE CASCADE,
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_attention' CHECK (status IN ('generated', 'skipped', 'needs_attention')),
  transaction_id UUID REFERENCES transactions(id),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(rule_id, due_date)
);

CREATE INDEX idx_occurrences_user ON recurring_occurrences(user_id);
CREATE INDEX idx_occurrences_rule ON recurring_occurrences(rule_id);
CREATE INDEX idx_occurrences_status ON recurring_occurrences(user_id, status);
CREATE INDEX idx_occurrences_due ON recurring_occurrences(due_date);
```

#### `reconciliations`

```sql
CREATE TABLE reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL,
  expected_paisa BIGINT NOT NULL,
  actual_paisa BIGINT NOT NULL CHECK (actual_paisa >= 0),
  difference_paisa BIGINT NOT NULL,
  note TEXT,
  adjustment_transaction_id UUID REFERENCES transactions(id),
  tx_count_at_check INTEGER NOT NULL,
  last_tx_version_hash TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reconciliations_user ON reconciliations(user_id);
CREATE INDEX idx_reconciliations_checked ON reconciliations(user_id, checked_at DESC);
```

#### `idempotency_keys`

```sql
CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  UNIQUE(user_id, key)
);

CREATE INDEX idx_idempotency_user ON idempotency_keys(user_id);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);
```

#### `audit_log`

```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
  before_json JSONB,
  after_json JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_entity ON audit_log(user_id, entity, entity_id);
CREATE INDEX idx_audit_at ON audit_log(at DESC);
```

### 4.3 SQL Views

#### `ledger_effects` (CRITICAL VIEW)

This view expands each transaction into signed postings. All balances come from aggregating this view.

```sql
CREATE OR REPLACE VIEW ledger_effects AS
SELECT
  t.user_id,
  t.id AS transaction_id,
  t.type,
  t.occurred_on,
  t.occurred_at,
  t.created_at,
  'TOTAL' AS account,
  CASE
    WHEN t.type IN ('opening_balance', 'income', 'external_deposit') THEN t.amount_paisa
    WHEN t.type IN ('expense', 'external_withdrawal') THEN -t.amount_paisa
    ELSE 0
  END AS delta
FROM transactions t
WHERE t.deleted_at IS NULL

UNION ALL

SELECT
  t.user_id,
  t.id AS transaction_id,
  t.type,
  t.occurred_on,
  t.occurred_at,
  t.created_at,
  'UNALLOCATED' AS account,
  CASE
    WHEN t.type = 'opening_balance' THEN t.amount_paisa
    WHEN t.type = 'income' THEN t.amount_paisa - COALESCE(s.total_split, 0)
    WHEN t.type = 'deallocation' THEN t.amount_paisa
    WHEN t.type = 'allocation' THEN -t.amount_paisa
    WHEN t.type = 'adjustment' AND t.envelope_id IS NULL THEN t.amount_paisa
    ELSE 0
  END AS delta
FROM transactions t
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(amount_paisa), 0) AS total_split
  FROM transaction_splits
  WHERE transaction_id = t.id
) s ON true
WHERE t.deleted_at IS NULL

UNION ALL

SELECT
  t.user_id,
  t.id AS transaction_id,
  t.type,
  t.occurred_on,
  t.occurred_at,
  t.created_at,
  t.envelope_id::TEXT AS account,
  CASE
    WHEN t.type IN ('expense', 'external_withdrawal', 'deallocation', 'loan') THEN -t.amount_paisa
    WHEN t.type IN ('external_deposit', 'allocation', 'loan_repayment') THEN t.amount_paisa
    WHEN t.type = 'transfer' AND t.envelope_id IS NOT NULL THEN -t.amount_paisa
    WHEN t.type = 'transfer' AND t.counterpart_envelope_id IS NOT NULL THEN t.amount_paisa
    WHEN t.type = 'adjustment' AND t.envelope_id IS NOT NULL THEN t.amount_paisa
    ELSE 0
  END AS delta
FROM transactions t
WHERE t.deleted_at IS NULL AND t.envelope_id IS NOT NULL

UNION ALL

SELECT
  t.user_id,
  t.id AS transaction_id,
  t.type,
  t.occurred_on,
  t.occurred_at,
  t.created_at,
  t.counterpart_envelope_id::TEXT AS account,
  CASE
    WHEN t.type = 'transfer' THEN t.amount_paisa
    WHEN t.type = 'loan' THEN t.amount_paisa
    WHEN t.type = 'loan_repayment' THEN -t.amount_paisa
    ELSE 0
  END AS delta
FROM transactions t
WHERE t.deleted_at IS NULL AND t.counterpart_envelope_id IS NOT NULL

UNION ALL

SELECT
  s.user_id,
  s.transaction_id,
  t.type,
  t.occurred_on,
  t.occurred_at,
  t.created_at,
  s.envelope_id::TEXT AS account,
  s.amount_paisa AS delta
FROM transaction_splits s
JOIN transactions t ON t.id = s.transaction_id
WHERE t.deleted_at IS NULL;
```

### 4.4 Derived Balance Queries

```sql
-- Total Balance
SELECT COALESCE(SUM(delta), 0) AS total_paisa
FROM ledger_effects
WHERE user_id = $1 AND account = 'TOTAL';

-- Envelope Balance
SELECT COALESCE(SUM(delta), 0) AS balance_paisa
FROM ledger_effects
WHERE user_id = $1 AND account = $2::TEXT;

-- Unallocated (derived)
SELECT
  (SELECT COALESCE(SUM(delta), 0) FROM ledger_effects WHERE user_id = $1 AND account = 'TOTAL')
  -
  (SELECT COALESCE(SUM(delta), 0) FROM ledger_effects 
   WHERE user_id = $1 AND account IN (SELECT id::TEXT FROM envelopes WHERE user_id = $1))
  AS unallocated_paisa;

-- Your Money
SELECT
  (SELECT COALESCE(SUM(delta), 0) FROM ledger_effects WHERE user_id = $1 AND account = 'UNALLOCATED')
  +
  (SELECT COALESCE(SUM(delta), 0) FROM ledger_effects le
   JOIN envelopes e ON e.id = le.account::UUID
   WHERE le.user_id = $1 AND e.owner_type = 'mine')
  AS your_money_paisa;

-- Held for Others
SELECT COALESCE(SUM(delta), 0) AS held_paisa
FROM ledger_effects le
JOIN envelopes e ON e.id = le.account::UUID
WHERE le.user_id = $1 AND e.owner_type = 'other';
```

---

## 5. Core Business Logic

### 5.1 Money Representation

**CRITICAL RULE:** Never use floating point for money. All amounts are integer paisa.

```typescript
// lib/money.ts (PURE TYPESCRIPT - NO FRAMEWORK DEPENDENCIES)

export type Paisa = bigint;

const PAISA_PER_RUPEE = 100n;
const MAX_AMOUNT = 99999999999n; // 999,999,999.99 PKR

export function parseMoney(input: string): Paisa {
  // Remove thousands separators
  const cleaned = input.replace(/,/g, '').trim();
  
  // Handle calculator-style expressions (e.g., "1200+350")
  if (cleaned.includes('+')) {
    const parts = cleaned.split('+');
    const sum = parts.reduce((acc, part) => {
      const parsed = parseMoney(part);
      if (parsed === null) throw new Error('Invalid amount');
      return acc + parsed;
    }, 0n);
    return sum;
  }
  
  // Parse decimal
  const match = cleaned.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('Invalid amount format');
  
  const rupees = BigInt(match[1]);
  const paisa = match[2] ? BigInt(match[2].padEnd(2, '0')) : 0n;
  
  const total = rupees * PAISA_PER_RUPEE + paisa;
  
  if (total <= 0n) throw new Error('Amount must be positive');
  if (total > MAX_AMOUNT) throw new Error('Amount exceeds maximum');
  
  return total;
}

export function formatMoney(paisa: Paisa, showDecimals: boolean = false): string {
  const rupees = paisa / PAISA_PER_RUPEE;
  const paisaRemainder = paisa % PAISA_PER_RUPEE;
  
  const rupeesStr = new Intl.NumberFormat('en-PK').format(Number(rupees));
  
  if (paisaRemainder === 0n && !showDecimals) {
    return `${rupeesStr} PKR`;
  }
  
  const paisaStr = paisaRemainder.toString().padStart(2, '0');
  return `${rupeesStr}.${paisaStr} PKR`;
}

export function addMoney(a: Paisa, b: Paisa): Paisa {
  return a + b;
}

export function subMoney(a: Paisa, b: Paisa): Paisa {
  if (b > a) throw new Error('Subtraction would result in negative');
  return a - b;
}

export function compareMoney(a: Paisa, b: Paisa): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
```

### 5.2 Core Invariants

These invariants MUST hold at all times, enforced in code AND database where possible.

| Invariant | Description | Enforcement |
|-----------|-------------|-------------|
| **INV-1** | Expected Total = Σ(all envelope balances) + Unallocated | By construction (Unallocated derived) |
| **INV-2** | No active envelope balance < 0 | Timeline validation on every write |
| **INV-3** | Unallocated never < 0 | Timeline validation on every write |
| **INV-4** | Balances derived from ledger, not stored | SQL aggregation over ledger_effects view |
| **INV-5** | Loans, allocations, transfers never change Total | Transaction type logic |
| **INV-6** | Only income/expense in analytics | Analytics query filters |
| **INV-7** | Reconciliation never changes balances | Separate adjustment transaction |
| **INV-8** | Every record belongs to exactly one user | Composite FKs + user_id filtering |
| **INV-9** | Money stored as paisa (BIGINT) | Schema + money utils |
| **INV-10** | Invariants hold at every point in timeline | Timeline validation |

### 5.3 Transaction Type Effects

| Type | Total | Unallocated | Envelope(s) | Counts As |
|------|-------|-------------|-------------|------------|
| `opening_balance` | +A | +A | – | none |
| `income` | +X | +(X − Σsplits) | each split +split | **Income** |
| `external_deposit` | +X | – | their envelope +X | none |
| `expense` | −X | – | envelope −X | **Spending** |
| `external_withdrawal` | −X | – | their envelope −X | none |
| `allocation` | 0 | −X | envelope +X | none |
| `deallocation` | 0 | +X | envelope −X | none |
| `transfer` | 0 | – | from −X, to +X | none |
| `loan` | 0 | – | lender −X, borrower +X | none |
| `loan_repayment` | 0 | – | borrower −X, lender +X | none |
| `adjustment` | ±X | depends | target envelope or U | **Adjustment** |

### 5.4 Timeline Validation Algorithm

**CRITICAL:** This is the hardest and most important part of the system.

```typescript
// lib/validation/timeline.ts (PURE TYPESCRIPT)

interface TimelinePoint {
  occurred_on: Date;
  occurred_at: string;
  created_at: Date;
  id: string;
}

interface EnvelopeBalance {
  envelopeId: string;
  balance: bigint;
}

interface ValidationResult {
  valid: boolean;
  error?: {
    message: string;
    date: Date;
    envelopeId?: string;
    shortfall: bigint;
  };
}

export async function validateTimeline(
  userId: string,
  affectedEnvelopeIds: string[],
  db: Database
): Promise<ValidationResult> {
  // Get all transactions for affected envelopes, ordered canonically
  const transactions = await db.query(`
    SELECT id, occurred_on, occurred at, created_at, type, amount_paisa,
           envelope_id, counterpart_envelope_id
    FROM ledger_effects
    WHERE user_id = $1 AND account IN ($2)
    ORDER BY occurred_on ASC, occurred_at ASC, created_at ASC, id ASC
  `, [userId, affectedEnvelopeIds]);
  
  // Track running balances
  const balances = new Map<string, bigint>();
  for (const envId of affectedEnvelopeIds) {
    balances.set(envId, 0n);
  }
  
  // Replay timeline
  for (const tx of transactions) {
    const envelopeId = tx.account;
    const delta = tx.delta;
    const current = balances.get(envelopeId) || 0n;
    const newBalance = current + delta;
    
    if (newBalance < 0n) {
      return {
        valid: false,
        error: {
          message: `Balance would go negative at this point`,
          date: tx.occurred_on,
          envelopeId,
          shortfall: -newBalance
        }
      };
    }
    
    balances.set(envelopeId, newBalance);
  }
  
  // Also validate Unallocated
  const unallocatedResult = await validateUnallocated(userId, db);
  if (!unallocatedResult.valid) {
    return unallocatedResult;
  }
  
  return { valid: true };
}

export async function validateUnallocated(
  userId: string,
  db: Database
): Promise<ValidationResult> {
  const result = await db.query(`
    SELECT 
      occurred_on, occurred_at, created_at, id,
      SUM(delta) OVER (
        ORDER BY occurred_on, occurred_at, created_at, id
      ) AS running_unallocated
    FROM ledger_effects
    WHERE user_id = $1 AND account = 'UNALLOCATED'
    ORDER BY occurred_on, occurred_at, created_at, id
  `, [userId]);
  
  for (const row of result) {
    if (row.running_unallocated < 0n) {
      return {
        valid: false,
        error: {
          message: 'Unallocated would go negative',
          date: row.occurred_on,
          shortfall: -row.running_unallocated
        }
      };
    }
  }
  
  return { valid: true };
}
```

### 5.5 Concurrency Control

```typescript
// lib/db/transaction.ts

export async function withUserLock<T>(
  userId: string,
  fn: () => Promise<T>
): Promise<T> {
  // Use PostgreSQL advisory lock for per-user serialization
  const lockHash = hashUserId(userId);
  
  return await db.transaction(async (tx) => {
    await tx.execute(`SELECT pg_advisory_xact_lock($1)`, [lockHash]);
    return await fn();
  });
}

// Alternative: SERIALIZABLE isolation with retry
export async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await db.transaction(async (tx) => {
        tx.setIsolationLevel('SERIALIZABLE');
        return await fn();
      });
    } catch (error) {
      if (error.code === '40001' && i < maxRetries - 1) {
        // Serialization failure, retry
        await sleep(50 * (i + 1));
        continue;
      }
      throw error;
    }
  }
}
```

### 5.6 Idempotency

```typescript
// lib/idempotency.ts

export async function withIdempotency<T>(
  userId: string,
  key: string,
  endpoint: string,
  fn: () => Promise<T>,
  db: Database
): Promise<T> {
  // Check if key exists
  const existing = await db.query(`
    SELECT response_json
    FROM idempotency_keys
    WHERE user_id = $1 AND key = $2 AND expires_at > NOW()
  `, [userId, key]);
  
  if (existing.length > 0) {
    return JSON.parse(existing[0].response_json);
  }
  
  // Execute the function
  const result = await fn();
  
  // Store the result
  await db.query(`
    INSERT INTO idempotency_keys (user_id, key, endpoint, response_json)
    VALUES ($1, $2, $3, $4)
  `, [userId, key, endpoint, JSON.stringify(result)]);
  
  return result;
}
```

### 5.7 Loan Math

```typescript
// lib/loans/math.ts (PURE TYPESCRIPT)

export function calculateRemaining(
  originalAmount: bigint,
  repayments: bigint[]
): bigint {
  const totalRepaid = repayments.reduce((sum, r) => sum + r, 0n);
  return originalAmount - totalRepaid;
}

export function validateRepayment(
  remaining: bigint,
  repaymentAmount: bigint,
  borrowerBalance: bigint
): { valid: boolean; error?: string } {
  if (repaymentAmount <= 0n) {
    return { valid: false, error: 'Repayment must be positive' };
  }
  
  if (repaymentAmount > remaining) {
    return { valid: false, error: 'Reayment exceeds remaining loan amount' };
  }
  
  if (repaymentAmount > borrowerBalance) {
    return { valid: false, error: 'Insufficient funds in borrower envelope' };
  }
  
  return { valid: true };
}

export function calculateOwnFunds(
  balance: bigint,
  borrowed: bigint
): bigint {
  return balance - borrowed;
}
```

### 5.8 Recurrence Engine

```typescript
// lib/recurrence/engine.ts (PURE TYPESCRIPT)

export interface RecurringRule {
  frequency: 'weekly' | 'monthly' | 'yearly' | 'custom_days';
  intervalN: number;
  anchorDay?: number;
  startDate: Date;
  endDate?: Date;
  maxOccurrences?: number;
}

export interface Occurrence {
  dueDate: Date;
  status: 'generated' | 'skipped' | 'needs_attention';
}

export function generateOccurrences(
  rule: RecurringRule,
  fromDate: Date,
  toDate: Date,
  existingDates: Date[]
): Occurrence[] {
  const occurrences: Occurrence[] = [];
  const existingSet = new Set(existingDates.map(d => d.toISOString().split('T')[0]));
  
  let currentDate = new Date(rule.startDate);
  let count = 0;
  
  while (currentDate <= toDate && shouldContinue(rule, count)) {
    const dateKey = currentDate.toISOString().split('T')[0];
    
    if (!existingSet.has(dateKey)) {
      occurrences.push({
        dueDate: new Date(currentDate),
        status: 'needs_attention'
      });
    }
    
    currentDate = nextOccurrence(currentDate, rule);
    count++;
  }
  
  return occurrences;
}

function nextOccurrence(current: Date, rule: RecurringRule): Date {
  const next = new Date(current);
  
  switch (rule.frequency) {
    case 'weekly':
      next.setDate(next.getDate() + (7 * rule.intervalN));
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + rule.intervalN);
      // Clamp to last day of month
      const targetDay = rule.anchorDay || current.getDate();
      const lastDayOfMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(targetDay, lastDayOfMonth));
      break;
    case 'yearly':
      next.setFullYear(next.getFullYear() + rule.intervalN);
      // Handle Feb 29
      if (next.getMonth() === 1 && next.getDate() === 29) {
        const lastDayOfFeb = new Date(next.getFullYear(), 2, 0).getDate();
        if (lastDayOfFeb < 29) {
          next.setDate(28);
        }
      }
      break;
    case 'custom_days':
      next.setDate(next.getDate() + rule.intervalN);
      break;
  }
  
  return next;
}

function shouldContinue(rule: RecurringRule, count: number): boolean {
  if (rule.maxOccurrences && count >= rule.maxOccurrences) {
    return false;
  }
  if (rule.endDate && new Date() > rule.endDate) {
    return false;
  }
  return true;
}
```

---

## 6. API Design

### 6.1 API Conventions

- **Authentication:** All endpoints require authenticated session via Auth.js
- **User Scoping:** All queries automatically filter by `session.user.id`
- **Response Format:** JSON with `{ data, error }` or direct return for server actions
- **Error Handling:** Typed domain errors mapped to user-friendly messages
- **Validation:** Zod schemas on all inputs
- **Idempotency:** All create endpoints accept optional `idempotency_key`

### 6.2 Server Actions (Mutations)

#### Authentication

```typescript
// app/actions/auth.ts

export async function register(input: RegisterInput) {
  // Validate with Zod
  // Check ALLOW_REGISTRATION env var
  // Hash password with argon2id
  // Create user
  // Return session
}

export async function login(input: LoginInput) {
  // Rate limiting (5 per 15min per email+IP)
  // Verify password
  // Check account lock
  // Create session
  // Generic error on failure
}

export async function logout() {
  // Invalidate current session
}

export async function logoutAllDevices() {
  // Invalidate all sessions for user
}
```

#### Envelopes

```typescript
// app/actions/envelopes.ts

export async function createEnvelope(input: {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  ownerType: 'mine' | 'other';
  ownerName?: string;
  kind: 'standard' | 'savings';
  initialFunding?: {
    amount: bigint;
    source: 'unallocated' | 'external';
  };
}) {
  // Validate name uniqueness
  // Create envelope
  // If initialFunding: create allocation or external_deposit
  // Validate timeline
  // Return envelope
}

export async function updateEnvelope(id: string, input: Partial<UpdateInput>) {
  // Check owner_type immutability if transactions exist
  // Validate name uniqueness
  // Update envelope
  // Return updated
}

export async function archiveEnvelope(id: string, options: {
  action: 'deallocate' | 'withdraw' | 'move_to_unallocated';
}) {
  // Check balance = 0 or handle per action
  // Check no active loans
  // Create deallocation or external_withdrawal if needed
  // Set status = archived
  // Validate timeline
  // Return envelope
}

export async function unarchiveEnvelope(id: string) {
  // Check name conflict with active envelopes
  // Set status = active
  // Return envelope
}

export async function deleteEnvelope(id: string) {
  // Only if zero transactions, loans, recurring references
  // Hard delete
  // Return success
}

export async function reorderEnvelopes(envelopeIds: string[]) {
  // Update sort_order for all
  // Return success
}
```

#### Transactions

```typescript
// app/actions/transactions.ts

export async function createTransaction(input: TransactionInput, idempotencyKey?: string) {
  return withUserLock(session.user.id, async () => {
    return withIdempotency(session.user.id, idempotencyKey, 'createTransaction', async () => {
      // Validate input per type
      // Check insufficient funds for expense/allocation
      // Create transaction in DB
      // Create splits if income
      // Validate timeline
      // Create audit log
      // Return transaction
    });
  });
}

export async function updateTransaction(id: string, input: Partial<TransactionInput>, version: number) {
  return withUserLock(session.user.id, async () => {
    // Check version for optimistic concurrency
    // Load current transaction
    // Validate changes per type (type cannot change)
    // Update in DB (delete old + insert new for validation)
    // Validate timeline
    // Create audit log
    // Return updated
  });
}

export async function deleteTransaction(id: string) {
  return withUserLock(session.user.id, async () => {
    // Soft delete (set deleted_at, deleted_by)
    // Validate timeline
    // Create audit log
    // Return success
  });
}

export async function restoreTransaction(id: string) {
  return withUserLock(session.user.id, async () => {
    // Clear deleted_at, deleted_by
    // Validate timeline
    // Create audit log
    // Return transaction
  });
}
```

#### Loans

```typescript
// app/actions/loans.ts

export async function createLoan(input: {
  lenderEnvelopeId: string;
  borrowerEnvelopeId: string;
  amount: bigint;
  date: Date;
  note?: string;
}) {
  return withUserLock(session.user.id, async () => {
    // Validate both envelopes are 'mine' and active
    // Validate lender ≠ borrower
    // Validate amount ≤ lender balance at that timeline point
    // Create loan record
    // Create loan transaction
    // Validate timeline
    // Return loan
  });
}

export async function repayLoan(input: {
  loanId: string;
  amount: bigint;
  date: Date;
}) {
  return withUserLock(session.user.id, async () => {
    // Validate amount ≤ remaining
    // Validate amount ≤ borrower balance
    // Create loan_repayment record
    // Create loan_repayment transaction
    // Update loan remaining
    // If remaining = 0, set status = paid, paid_at
    // Validate timeline
    // Return loan
  });
}

export async function repayAllFromEnvelope(input: {
  fromEnvelopeId: string;
  toEnvelopeId: string;
}) {
  // Find all active loans where fromEnvelopeId is borrower
  // Allocate repayments oldest first
  // Create one repayment per loan
  // Validate timeline
  // Return results
}
```

#### Recurring

```typescript
// app/actions/recurring.ts

export async function createRecurringRule(input: RecurringRuleInput) {
  // Validate input
  // Calculate next_due_date
  // Preview first 3 occurrences
  // Create rule
  // Return rule with preview
}

export async function generateOccurrences(ruleId: string) {
  // Get rule
  // Calculate next occurrences
  // For each: check if already exists
  // If not: check sufficient funds
  // If sufficient: create transaction, mark generated
  // If insufficient: create occurrence with needs_attention
  // Update rule next_due_date
  // Return results
}

export async function skipOccurrence(occurrenceId: string) {
  // Set status = skipped
  // Does not count toward max_occurrences
  // Return occurrence
}

export async function pauseRule(ruleId: string) {
  // Set status = paused
  // Return rule
}

export async function resumeRule(ruleId: string, options: { backfill: boolean }) {
  // Set status = active
  // If backfill: generate missed occurrences
  // Return rule
}
```

#### Reconciliation

```typescript
// app/actions/reconciliation.ts

export async function createReconciliation(input: {
  actualBalance: bigint;
  note?: string;
  createAdjustment?: {
    target: 'unallocated' | string; // envelope_id
    note: string;
  };
}) {
  // Calculate expected from ledger
  // Calculate difference = actual - expected
  // Validate actual >= 0
  // Large mismatch warning if |diff| > 10% or > 50,000
  // Create reconciliation record
  // If createAdjustment:
  //   Validate target can absorb adjustment
  //   Create adjustment transaction
  //   Link to reconciliation
  // Return reconciliation
}

export async function getReconciliationHistory() {
  // Get all reconciliations for user
  // Check if ledger changed since each (compare hash)
  // Return with status badges
}
```

### 6.3 Data Fetching (Server Components)

```typescript
// app/dashboard/page.tsx (Server Component)

async function DashboardPage() {
  const session = await auth();
  const data = await getDashboardData(session.user.id);
  
  return <DashboardView data={data} />;
}

async function getDashboardData(userId: string) {
  const [
    totalBalance,
    yourMoney,
    heldForOthers,
    unallocated,
    envelopes,
    upcoming,
    recentActivity,
    lastReconciliation
  ] = await Promise.all([
    getTotalBalance(userId),
    getYourMoney(userId),
    getHeldForOthers(userId),
    getUnallocated(userId),
    getEnvelopes(userId),
    getUpcomingRecurring(userId),
    getRecentTransactions(userId, 5),
    getLastReconciliation(userId)
  ]);
  
  return {
    totalBalance,
    yourMoney,
    heldForOthers,
    unallocated,
    envelopes,
    upcoming,
    recentActivity,
    lastReconciliation
  };
}
```

### 6.4 API Routes (for non-React contexts)

```typescript
// app/api/health/route.ts

export async function GET() {
  return Response.json({ status: 'ok', timestamp: new Date() });
}

// app/api/cron/generate-recurring/route.ts

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  // Get all active rules with next_due_date <= today
  // Generate occurrences for each
  // Return results
  
  return Response.json({ processed: count });
}
```

---

## 7. Security Model

### 7.1 Authentication

- **Provider:** Auth.js credentials provider
- **Password Hashing:** argon2id (or bcrypt cost ≥ 12)
- **Session:** Database or JWT sessions with httpOnly, Secure, SameSite=Lax cookies
- **Session Lifetime:** 30 days rolling
- **Rate Limiting:** 5 failed logins per email+IP per 15 min, then progressive delay

### 7.2 Authorization

- **User Scoping:** Every query filtered by `session.user.id`
- **IDOR Prevention:** Automated tests for cross-user access on every endpoint
- **Row-Level Security:** Enable Postgres RLS as defence in depth

### 7.3 Input Validation

- **Zod Schemas:** All server inputs validated
- **String Trimming:** All text inputs trimmed
- **Length Caps:** Names ≤ 60, notes ≤ 500, descriptions ≤ 300
- **Type Safety:** TypeScript strict mode

### 7.4 Output Security

- **XSS Prevention:** All user text rendered as text, never HTML
- **CSV Safety:** Neutralise formula injection (prefix `= + - @` with `'`)
- **No Sensitive Data in Logs:** Amounts and notes redacted from error logs

### 7.5 CSRF Protection

- **Server Actions:** Next.js provides origin checks
- **API Routes:** Require same-origin + token

### 7.6 Security Headers

```typescript
// next.config.js
const securityHeaders = [
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'on'
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload'
  },
  {
    key: 'X-Frame-Options',
    value: 'SAMEORIGIN'
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff'
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin'
  },
  {
    key: 'Content-Security-Policy',
    value: CSP directives
  }
];
```

### 7.7 Secrets Management

- All secrets via environment variables
- `.env.example` provided
- `.env` git-ignored
- No credentials in source code

---

## 8. UI/UX Architecture

### 8.1 Design System

#### Typography
- **Font:** Inter or system-ui
- **Size:** Large numerals for money, tabular figures
- **Hierarchy:** Strong type hierarchy

#### Colors
- **Light Mode:** White backgrounds, subtle shadows
- **Dark Mode:** Dark gray backgrounds, high contrast
- **Accent:** Blue/indigo for primary actions
- **Status:** Green (success), Amber (warning), Red (error)

#### Components
- **Cards:** Rounded 16-24px, subtle shadows
- **Buttons:** Touch targets ≥ 44×44px
- **Inputs:** `inputmode="decimal"` for money, font-size ≥ 16px (prevent iOS zoom)

#### Spacing
- **Generous:** 8px base unit, 16px, 24px, 32px, 48px

### 8.2 Responsive Breakpoints

```css
/* Mobile-first */
/* Default: 320-767px (mobile) */
/* md: 768-1023px (tablet) */
/* lg: 1024px+ (desktop) */
```

### 8.3 Navigation

#### Mobile (< 1024px)
- Bottom navigation: **Home · Envelopes · ＋ · Activity · More**
- "More" contains: Analytics, Recurring, Reconciliation, Loans, Settings

#### Desktop (≥ 1024px)
- Sidebar navigation: Dashboard, Envelopes, Transactions, Analytics, Recurring, Reconciliation, Loans, Settings

### 8.4 Screen Structure

#### Dashboard
```
┌─────────────────────────────────────┐
│  Total Balance (large)              │
│  [Reconciliation status chip]       │
├─────────────────────────────────────┤
│  [Your Money] [Held] [Unallocated]  │
├─────────────────────────────────────┤
│  Attention strip (if needed)       │
├─────────────────────────────────────┤
│  Envelope cards (Mine, then Others) │
├─────────────────────────────────────┤
│  Upcoming recurring                 │
├─────────────────────────────────────┤
│  Recent activity                    │
└─────────────────────────────────────┘
```

#### Quick Add Flow (≤ 4 taps)
1. Amount (numeric keypad focused)
2. Envelope (last-used default, show balances)
3. Category (last-used default, recent first)
4. Note + Date (optional)
5. Save → confirmation + Undo toast

#### Envelope Detail
```
┌─────────────────────────────────────┐
│  [Icon] Name [Owner badge]          │
│  Current Balance                    │
│  Own funds / Borrowed / Loaned-out  │
│  This Month: spent X, added Y       │
├─────────────────────────────────────┤
│  Actions: Add expense, Add money,   │
│  Move, Edit, Archive                │
├─────────────────────────────────────┤
│  Filters + grouped transaction list │
└─────────────────────────────────────┘
```

### 8.5 State Management

- **Server State:** React Query / SWR for API data
- **Client State:** React Context for theme, hide-balances
- **Optimistic Updates:** Update UI immediately, rollback on error
- **Form State:** React Hook Form + Zod validation

### 8.6 Animations

- **Number transitions:** ~400ms count animation
- **Card updates:** Pulse effect
- **Success:** Check mark animation on save
- **Bottom sheets:** Slide animation
- **Respect:** `prefers-reduced-motion` (disable non-essential)

### 8.7 Accessibility

- **WCAG 2.1 AA** contrast ratios
- **Semantic HTML**
- **Labels** for all inputs
- **Screen reader announcements** for balance changes
- **Focus management** in sheets/modals
- **Never rely on colour alone** (use icons/text)
- **Logical properties** (`ms-`, `me-`) for i18n readiness

### 8.8 PWA Features

- **Manifest:** name, icons (192/512 + maskable), standalone display
- **Service Worker:** Cache app shell, last-fetched read-only data
- **Offline:** Show banner, disable writes
- **Install Prompt:** Android (beforeinstallprompt), iOS (help card)
- **Updates:** Prompt "New version available — Reload"

---

## 9. Implementation Phases

### Phase 1 — Foundation (Weeks 1-2)

**Goals:** Project setup, core infrastructure, basic auth, onboarding

**Tasks:**
1. Initialize Next.js project with TypeScript, Tailwind, shadcn/ui
2. Set up PostgreSQL database (Neon/Supabase)
3. Configure Drizzle ORM with schema (users, envelopes, categories, transactions)
4. Create migrations
5. Implement money utilities (parse, format, add, sub)
6. Implement ledger_effects SQL view
7. Implement Auth.js (register, login, logout)
8. Implement seed admin script
9. Add user scoping to all queries
10. Write IDOR tests for auth endpoints
11. Implement onboarding flow
12. Write unit tests for money utils and ledger calculations
13. Write property-based tests for invariants

**Acceptance Criteria:**
- Seeded user can log in
- User can complete onboarding
- Dashboard shows correct Total/Unallocated
- All invariant tests pass
- IDOR tests pass

### Phase 2 — Core Money Flows (Weeks 3-5)

**Goals:** Envelopes, transactions, categories, reconciliation, dashboard

**Tasks:**
1. Implement envelope CRUD + archive
2. Implement category CRUD + seed defaults
3. Implement transaction types: expense, income, allocation, deallocation, transfer
4. Implement timeline validation
5. Implement concurrency control (advisory locks)
6. Implement idempotency
7. Implement transaction list/detail/edit/delete
8. Implement quick-add flow
9. Implement reconciliation page + history
10. Implement adjustment transaction
11. Implement dashboard with envelope cards
12. Implement global search
13. Write comprehensive tests for all flows
14. Implement optimistic updates with rollback

**Acceptance Criteria:**
- Section 22 reference scenario passes end-to-end
- All Tier-1 tests from Section 21 pass
- Timeline validation prevents all negative balances
- Reconciliation works correctly
- Quick-add completes in ≤ 4 taps

### Phase 3 — Differentiators (Weeks 6-8)

**Goals:** External envelopes, loans, recurring, analytics

**Tasks:**
1. Implement external-owner envelopes (external_deposit, external_withdrawal)
2. Implement loans + repayments
3. Implement loan display logic (Borrowed, Own funds)
4. Implement recurring rules
5. Implement recurrence engine
6. Implement recurring generation (cron + lazy)
7. Implement committee (kameti) logic
8. Implement analytics (spending, income, charts)
9. Implement savings envelopes with goals
10. Write tests for all features

**Acceptance Criteria:**
- All Tier-2 requirements implemented
- Loans work correctly with timeline validation
- Recurring generates correctly with insufficient funds handling
- Analytics show correct data (only income/expense)
- Committee completes after N payments

### Phase 4 — Quality (Weeks 9-10)

**Goals:** Import/export, PWA, polish, performance, accessibility

**Tasks:**
1. Implement JSON export/import with validation
2. Implement CSV export with formula-injection protection
3. Implement PWA manifest + service worker
4. Implement offline read-only mode
5. Implement integrity check job
6. Add advanced filters to transactions
7. Polish animations and transitions
8. Accessibility audit (screen reader, keyboard, contrast)
9. Performance optimization (LCP < 2.5s, INP < 200ms)
10. Lighthouse audit (PWA/Performance/Accessibility ≥ 90)
11. Write E2E tests with Playwright
12. Deploy to Vercel with environment variables

**Acceptance Criteria:**
- All Tier-3 requirements implemented or explicitly deferred
- Lighthouse scores ≥ 90 on mobile
- E2E tests pass
- Deployed to production
- Backup/restore works end-to-end

---

## 10. Testing Strategy

### 10.1 Unit Tests

**Tools:** Vitest

**Coverage:**
- Money utilities (parse, format, add, sub)
- Ledger calculations
- Timeline validation
- Loan math
- Recurrence engine
- All business logic functions

**Example:**
```typescript
describe('parseMoney', () => {
  it('parses whole rupees', () => {
    expect(parseMoney('2500')).toBe(250000n);
  });
  
  it('parses decimals', () => {
    expect(parseMoney('2500.50')).toBe(250050n);
  });
  
  it('rejects invalid input', () => {
    expect(() => parseMoney('abc')).toThrow();
  });
  
  it('handles calculator expressions', () => {
    expect(parseMoney('1200+350')).toBe(155000n);
  });
});
```

### 10.2 Integration Tests

**Tools:** Vitest + Test Database

**Coverage:**
- Database queries
- Server actions
- API routes
- Auth flows
- Transaction creation with validation

### 10.3 Property-Based Tests

**Tools:** fast-check

**Coverage:**
- Invariants INV-1 through INV-6
- Random sequences of operations
- Timeline validation edge cases

**Example:**
```typescript
test('invariants maintain after random operations', () => {
  fc.assert(fc.property(
    fc.array(fc.oneof(
      fc.record({ type: 'income', amount: fc.bigInt(1n, 1000000n) }),
      fc.record({ type: 'expense', amount: fc.bigInt(1n, 1000000n) }),
      fc.record({ type: 'allocation', amount: fc.bigInt(1n, 1000000n) })
    )),
    (operations) => {
      const result = simulateOperations(operations);
      assertInvariants(result);
      return true;
    }
  ), { numRuns: 1000 });
});
```

### 10.4 E2E Tests

**Tools:** Playwright

**Coverage:**
- Reference scenario (Section 22)
- Critical user flows:
  - Onboarding
  - Quick-add expense
  - Create loan
  - Reconcile
  - Analytics

**Example:**
```typescript
test('reference scenario', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await completeOnboarding(page, { openingBalance: 200000 });
  await createEnvelope(page, { name: 'Home', amount: 50000 });
  await createEnvelope(page, { name: 'Personal', amount: 80000 });
  // ... continue with full scenario
  await expect(page.getByText('Total: 200,000 PKR')).toBeVisible();
});
```

### 10.5 IDOR Tests

**Coverage:**
- Every endpoint tested for cross-user access

**Example:**
```typescript
test('user cannot access another user envelopes', async () => {
  const user1 = await createUser();
  const user2 = await createUser();
  const envelope = await createEnvelope(user1.id);
  
  const response = await fetch(`/api/envelopes/${envelope.id}`, {
    headers: { session: user2.session }
  });
  
  expect(response.status).toBe(404);
});
```

### 10.6 Test Requirements from Section 21

All 51 test cases from the URD Section 21 must be implemented:

1-3: Money and parsing
4-14: Balances and invariants
15-20: Envelopes and ownership
21-28: Loans
29-35: Recurring
36-40: Reconciliation
41-43: Analytics
44-47: Auth/security
48: Import/export
49-51: UX/PWA/Time

---

## 11. Deployment Strategy

### 11.1 Environment Setup

**Development:**
```bash
cp .env.example .env
# Fill in DATABASE_URL, AUTH_SECRET, etc.
pnpm install
pnpm db:push  # Apply schema
pnpm db:seed  # Create admin user
pnpm dev
```

**Production (Vercel):**
1. Create project on Vercel
2. Connect GitHub repository
3. Add environment variables in Vercel dashboard
4. Set `ALLOW_REGISTRATION=false`
5. Deploy
6. Run seed script via Vercel CLI or add to post-deploy hook

### 11.2 Database

**Provider:** Neon or Supabase (PostgreSQL)

**Migrations:**
- Versioned SQL migrations
- Run in CI
- Never edit applied migrations

**Backups:**
- Enable provider point-in-time recovery
- Document restore procedure

### 11.3 Cron Jobs

**Provider:** Vercel Cron

**Endpoint:** `/api/cron/generate-recurring`

**Schedule:** Daily at 00:05 Asia/Karachi

**Security:** Bearer token with `CRON_SECRET`

### 11.4 Monitoring

**Health Check:** `/api/health`

**Error Tracking:** Sentry (optional)

**Logging:** Structured logs (no financial data)

### 11.5 PWA Deployment

- Upload app icons (192, 512, maskable)
- Configure manifest
- Test on iOS Safari and Android Chrome
- Verify service worker registration

---

## 12. Critical Implementation Notes

### 12.1 MUST Follow Rules

1. **NEVER use floating point for money** — Always use paisa (BIGINT)
2. **NEVER store balances as authoritative columns** — Always derive from ledger
3. **NEVER silently adjust numbers to make reconciliation match**
4. **EVERY database read/write MUST be scoped by user_id**
5. **Timeline validation MUST run on every write** (create/edit/delete/restore)
6. **All writes MUST be in a DB transaction**
7. **Use advisory locks or SERIALIZABLE for concurrency**
8. **All user text rendered as text, never HTML** (XSS prevention)
9. **CSV export MUST neutralise formula injection**
10. **Domain logic MUST be in pure TypeScript** (no framework dependencies)

### 12.2 Common Pitfalls

**Pitfall 1:** Using `parseFloat` for money
- **Solution:** Use the `parseMoney` utility function

**Pitfall 2:** Storing envelope balance in a column
- **Solution:** Always calculate from ledger_effects view

**Pitfall 3:** Forgetting to validate timeline on edit
- **Solution:** Treat edit as "delete old + insert new" for validation

**Pitfall 4:** Allowing future-dated transactions
- **Solution:** Reject dates > today in user's timezone

**Pitfall 5:** Missing user_id in queries
- **Solution:** Add automated tests for IDOR

**Pitfall 6:** Hard-coding strings in components
- **Solution:** Use a messages file for i18n readiness

**Pitfall 7:** Using physical left/right CSS
- **Solution:** Use logical properties (`ms-`, `me-`)

### 12.3 Performance Considerations

- **Index all foreign keys and common query patterns**
- **Use cursor-based pagination for large lists**
- **Aggregate analytics in SQL, not in application code**
- **Cache per (user, range) for analytics with invalidation**
- **Target < 300ms for dashboard API p95**

### 12.4 Error Handling

**Typed Domain Errors:**
```typescript
class InsufficientFunds extends Error {
  constructor(public envelopeId: string, public balance: bigint, public required: bigint) {
    super(`Insufficient funds`);
  }
}

class InvariantViolation extends Error {
  constructor(public message: string, public details: any) {
    super(message);
  }
}

class NotFound extends Error {
  constructor(public resource: string, public id: string) {
    super(`${resource} not found`);
  }
}

class Conflict extends Error {
  constructor(public message: string) {
    super(message);
  }
}

class ValidationError extends Error {
  constructor(public fieldErrors: Record<string, string>) {
    super('Validation failed');
  }
}
```

**Map to user-friendly messages:**
- Server: Log full error with reference ID
- Client: Show plain-language message with what to do next

### 12.5 Decisions Document

Create `DECISIONS.md` in the repo to document:
- Choices made when requirements were ambiguous
- Reasons for the choice
- Alternative considered
- Date of decision

This helps future maintainers understand the rationale.

---

## Appendix A: Reference Scenario (Section 22)

This scenario MUST pass as an E2E test (numbers in PKR):

1. Opening balance 200,000. Create Home 50,000, Personal 80,000, Savings 30,000, Ahmed (Others') 20,000 (allocated from existing).
   - Result: Unallocated 20,000; Total 200,000; Your Money 180,000; Held for Others 20,000

2. Expense Home 2,500 Groceries
   - Result: Home 47,500; Total 197,500

3. Income Salary 150,000 split 50,000 Savings, 50,000 Home, 50,000 Personal
   - Result: Total 347,500; Unallocated 20,000 (unchanged)

4. Home spends down to 0 (after step 3 Home would be 97,500, so spend 97,500 across several expenses); electricity 5,000 attempted
   - Result: Rejected "Home has only 0 PKR available"

5. Loan Personal → Home 5,000
   - Result: Personal −5,000, Home 5,000, Total unchanged
   - Electricity 5,000 expense then succeeds → Home 0, Borrowed 5,000, Own funds −5,000 note shown

6. Add 20,000 to Home (allocation from Unallocated)
   - Result: Home 20,000
   - Repay 5,000 Home → Personal → loan Paid; Personal restored

7. Reconcile: expected X, enter actual = X
   - Result: ✓ Reconciled
   - Enter X − 1,000 → Mismatch −1,000 with causes shown; no balances change

8. Ahmed takes money back: `external_withdrawal` 20,000
   - Result: Ahmed 0, Total −20,000, not in spending analytics
   - Archive Ahmed → disappears from dashboard, appears in Archived and history

9. Analytics for the month:
   - Result: spending = only the expenses (not loan/repayment/withdrawal); income = 150,000 only

10. Export JSON → import into a clean DB
    - Result: all balances, loans, history identical

---

## Appendix B: Open Decisions

These decisions were made in the URD and can be changed by the owner:

| # | Decision | Alternative |
|---|----------|-------------|
| D1 | Money stored in paisa, shown mostly as whole rupees | Whole rupees only |
| D2 | Added `deallocation` and `transfer` types | Allow only via fake expense/loan |
| D3 | Loans only between "Mine" envelopes; no netting | Allow lending others' money |
| D4 | No future-dated manual transactions | Allow scheduled one-offs |
| D5 | Insufficient-funds recurring → "needs attention" | Allow temporary negative |
| D6 | Soft delete with 30-day restore | Hard delete |
| D7 | Registration off in production | Open sign-up |
| D8 | Committee payout recorded manually as income | Automatic payout modelling |
| D9 | Western digit grouping (200,000) | Lakh/crore grouping |
| D10 | Transaction type not changeable on edit | Allow type conversion |
| D11 | Offline = read-only | Offline write queue + sync |
| D12 | Own funds shown as Balance − Borrowed (can be negative) | Hide negative / cap at 0 |

---

## Appendix C: Definition of Done (V1)

- All Tier 1 and Tier 2 requirements implemented
- Tier 3 items implemented or explicitly deferred in `DECISIONS.md`
- All tests in Section 21 pass in CI
- Property tests hold INV-1…INV-6 over ≥ 1,000 random operation sequences
- Reference scenario (Section 22) passes end-to-end
- Lighthouse PWA/Performance/Accessibility ≥ 90 on mobile for dashboard
- The app lets the user answer the ten V1 success questions from the dashboard
- Deployed on Vercel with managed PostgreSQL
- Environment variables configured
- Seeded account created via env vars
- Backups enabled

---

**Document Version:** 1.0
**Last Updated:** 2026-10-06
**Based on:** envelope-finance-urd.md v1.0
