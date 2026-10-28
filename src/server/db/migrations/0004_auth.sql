-- TD-02 §2: Auth schema
-- Migration 0004_auth.sql

CREATE TABLE sessions (
  id UUID PRIMARY KEY,                                  -- the JWT 'sid'
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,                                      -- ≤ 300 chars, parsed for display ("Chrome on Android")
  ip_hash TEXT                                          -- sha256(ip + AUTH_SECRET); never raw IP
);
CREATE INDEX ix_sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_attempts (                           -- rate limiting that works on serverless (no in-memory state)
  id BIGSERIAL PRIMARY KEY,
  email CITEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  succeeded BOOLEAN NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_login_attempts_email ON login_attempts (email, at DESC);
CREATE INDEX ix_login_attempts_ip ON login_attempts (ip_hash, at DESC);

CREATE TABLE password_reset_tokens (                    -- only used when SMTP is configured
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,                      -- sha256 of the emailed token
  expires_at TIMESTAMPTZ NOT NULL,                      -- 30 min
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
