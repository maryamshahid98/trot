-- 0003: sign-in support. Refresh tokens (stored only as hashes), and temporary lockout after repeated wrong passwords.

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  family_id uuid NOT NULL,                 -- all tokens from one sign-in share a family
  token_hash text NOT NULL UNIQUE,         -- sha256 of the token. The token itself is never stored.
  expires_at timestamptz NOT NULL,
  used_at timestamptz,                     -- set when swapped for a new one. Seeing it again means it was copied.
  revoked_at timestamptz,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_account ON refresh_tokens (account_id);
CREATE INDEX refresh_tokens_family  ON refresh_tokens (family_id);

ALTER TABLE accounts
  ADD COLUMN failed_logins int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;     -- temporary lockout; accounts.status = 'locked' is the permanent kind

GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO trot_app;
