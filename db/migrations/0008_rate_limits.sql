-- Request counters for rate limiting, shared by every API server that uses this database.
-- UNLOGGED: much cheaper to write, and losing the counters in a crash only means everyone gets a fresh allowance.
CREATE UNLOGGED TABLE rate_limits (
  key      text        PRIMARY KEY,
  hits     int         NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_reset_at ON rate_limits (reset_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO trot_app;
