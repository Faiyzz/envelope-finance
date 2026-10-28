# Envelope Finance

A mobile-first PWA for virtual-envelope money management over ONE real bank balance (PKR).

## Tech Stack

- **Framework:** Next.js 15 (App Router) + TypeScript (strict mode)
- **Database:** PostgreSQL 15+ (Neon or Supabase)
- **ORM:** Drizzle ORM
- **Auth:** Auth.js v5 (Credentials + JWT sessions)
- **UI:** Tailwind CSS + shadcn/ui + Framer Motion
- **Charts:** Recharts
- **PWA:** Serwist
- **Testing:** Vitest, Playwright, fast-check (property-based)

## Project Structure

```
src/
  domain/                 # PURE TypeScript - no framework dependencies
    money/                # Money utilities (paisa, formatting)
    dates/                # LocalDate/LocalTime utilities
    ledger/               # Ledger effects, snapshot validator
    validation/           # Timeline validation
    loans/                # Loan math
    recurrence/           # Recurrence engine
    reconciliation/       # Reconciliation logic
    analytics/            # Analytics calculations
    backup/               # Import/export validation
    errors.ts             # Domain error classes
  server/
    db/                   # Database client, schema, migrations, repos
    actions/              # Server Actions (thin orchestration)
    jobs/                 # Cron tasks
    auth/                 # Auth.js config, session helpers
    http/                 # Route handler helpers
  app/                    # Next.js App Router
  components/             # UI components
  lib/                    # Client-only helpers
  messages/en.ts          # User-visible strings (i18n-ready)
tests/
  unit/                   # Unit tests
  integration/            # Integration tests
  property/               # Property-based tests (fast-check)
  e2e/                    # End-to-end tests (Playwright)
  idor/                   # IDOR security tests
```

## Setup

### Prerequisites

- Node.js >= 20.0.0
- PostgreSQL 15+ (Neon or Supabase recommended)

### Installation

1. Clone the repository
2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```
3. Fill in `.env` with your values (see `.env.example` for required variables)
4. Install dependencies:
   ```bash
   pnpm install
   ```
5. Generate and run migrations:
   ```bash
   pnpm db:generate
   pnpm db:migrate
   ```

### Development

```bash
pnpm dev          # Start development server
pnpm lint         # Run ESLint
pnpm lint:fix     # Fix ESLint issues
pnpm test         # Run unit tests
pnpm test:e2e     # Run E2E tests
pnpm test:property # Run property-based tests
```

### Database Commands

```bash
pnpm db:generate  # Generate migrations from schema
pnpm db:migrate   # Apply migrations
pnpm db:push      # Push schema changes (dev only)
pnpm db:studio    # Open Drizzle Studio
```

### Job Commands

```bash
pnpm job:run <task>  # Run a specific job manually
# Available tasks: recurring.generate, deleted.purge, idempotency.cleanup, auth.cleanup, integrity.check
```

## Architecture

This project follows the technical design in `docs/technical-design/`. Start with:

1. `GAP_ANALYSIS.md` - What was wrong/missing in v1.0
2. `00-foundation-architecture.md` - Stack, layering, conventions
3. `01-ledger-core.md` - Core schema and ledger model

### Key Principles

- **Pure domain layer:** All business logic in `src/domain/` has no framework dependencies
- **Money as paisa:** Never use floating point for money. All amounts are integer paisa (bigint)
- **Timeline validation:** Every write validates the entire ledger timeline
- **User scoping:** Every database query is scoped by `user_id`
- **Single write pipeline:** All mutations use `defineAction` wrapper for locking, idempotency, audit

## Testing

### Unit Tests

```bash
pnpm test
```

### Property-Based Tests

```bash
pnpm test:property
```

### E2E Tests

```bash
pnpm test:e2e
```

## Deployment

Deployed on Vercel with PostgreSQL (Neon or Supabase).

Environment variables must be configured in Vercel dashboard.

## License

Private project.
