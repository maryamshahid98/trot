-- Two-step sign-in with an authenticator app (BRD IAM-001, IAM-006, NFR-006).
--
-- The secret is stored ENCRYPTED (see apps/api/src/auth/totp.ts); this table never holds one in plain text.
-- A row with confirmed_at NULL is a set-up that was started but not finished: it does not protect the account yet.

CREATE TABLE account_mfa (
  account_id   uuid PRIMARY KEY REFERENCES accounts(id),
  secret_enc   text NOT NULL,
  confirmed_at timestamptz,
  last_step    bigint NOT NULL DEFAULT 0,   -- the newest 30-second step already used, so a code cannot be used twice
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One-use codes for a lost phone. Only a hash is kept.
CREATE TABLE mfa_recovery_codes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, code_hash)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON account_mfa, mfa_recovery_codes TO trot_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trot_app;
