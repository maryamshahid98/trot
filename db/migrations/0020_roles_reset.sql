-- The BRD's remaining staff roles (section 4) and password reset by one-time code (IAM-001).

ALTER TYPE account_role ADD VALUE IF NOT EXISTS 'director';
ALTER TYPE account_role ADD VALUE IF NOT EXISTS 'finance';
ALTER TYPE account_role ADD VALUE IF NOT EXISTS 'scheduler';
ALTER TYPE account_role ADD VALUE IF NOT EXISTS 'auditor';

-- One live code per account. Only its fingerprint is kept; it expires, and a few wrong guesses end it.
CREATE TABLE password_resets (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets TO trot_app;
