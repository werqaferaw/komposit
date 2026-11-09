-- Accounts for the optional "Sign in with Google" (see README.md, Sign-in).
-- Stores only what sign-in needs: no Google access tokens, no profile photo.
-- Apply with: npx wrangler d1 migrations apply DB --remote   (or --local)

-- One row per person. The owner can grant an allowance by email before the
-- person has signed in; that placeholder row has no google_sub until a sign-in
-- with the same, Google-verified email claims it.
CREATE TABLE users (
  -- AUTOINCREMENT: an id is never reused, so the usage counters of a deleted
  -- account (USAGE keys "req:user:<id>:..." and "tok:user:<id>:...") can never
  -- be inherited by a later account.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT UNIQUE,              -- Google's stable subject id; NULL until claimed
  email TEXT,                          -- lowercased; only ever an email Google marked verified
  name TEXT,                           -- display name from Google
  created_at TEXT NOT NULL,            -- ISO 8601, UTC
  allowance INTEGER NOT NULL DEFAULT 0 -- output tokens per UTC month; 0 = no access
);
CREATE INDEX users_email ON users (email);
-- At most one unclaimed (pre-granted) row per email.
CREATE UNIQUE INDEX users_pending_email ON users (email) WHERE google_sub IS NULL;

-- Sign-in sessions. Only the SHA-256 of a session token is stored; the token
-- itself exists only in the person's browser.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL             -- 30 days after created_at
);
CREATE INDEX sessions_user ON sessions (user_id);

-- One-time OAuth state for a sign-in in progress (10 minutes). Keyed by the
-- SHA-256 of the state value; a row is deleted the moment its callback arrives,
-- so a state works once.
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,         -- PKCE verifier, sent only to Google's token endpoint
  nonce TEXT NOT NULL,                 -- must come back inside the id_token
  return_origin TEXT NOT NULL,         -- where the session (or the error) is sent
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
