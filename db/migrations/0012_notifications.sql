-- Messages to riders, guardians and staff (email now; SMS and push can be added behind the same table).
--
-- notification_outbox is a "transactional outbox": a message is queued in the SAME database transaction as the change that
-- caused it (a booking, a payment, a cancellation), so there is never a message for something that did not happen, and never a
-- change whose message was lost. A separate sender picks queued messages up, retries failures with a growing delay, and records
-- the outcome. dedupe_key makes queuing safe to repeat: the same reminder cannot be queued twice for the same person and channel.

CREATE TABLE notification_preferences (
  account_id    uuid PRIMARY KEY REFERENCES accounts(id),
  email_enabled boolean NOT NULL DEFAULT true,
  sms_enabled   boolean NOT NULL DEFAULT true,
  push_enabled  boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id       uuid NOT NULL REFERENCES branches(id),
  account_id      uuid NOT NULL REFERENCES accounts(id),
  event           text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  to_address      text NOT NULL,
  locale          text NOT NULL CHECK (locale IN ('en', 'ar')),
  subject         text NOT NULL,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  last_error      text,
  provider_ref    text,
  dedupe_key      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (dedupe_key, account_id, channel)
);
CREATE INDEX notification_outbox_due ON notification_outbox (branch_id, next_attempt_at) WHERE status IN ('queued', 'sending');
CREATE INDEX notification_outbox_recent ON notification_outbox (branch_id, id DESC);

ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON notification_outbox USING (branch_id = ANY (app_branch_ids()));
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences, notification_outbox TO trot_app;
