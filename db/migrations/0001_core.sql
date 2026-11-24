-- Trot / Equestrian Club Management System: core schema, PostgreSQL 16+
-- NOT YET RUN: this workspace has no database server. Apply to an empty database and fix any syntax slips first.
-- Conventions: ids are uuid; instants are timestamptz (UTC); money is integer minor units (halalas); no hard deletes of money or audit data.

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- lets exclusion constraints mix = and && (overlap)
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()

-- ---------- Organisation and branches (ORG-001..) ----------
CREATE TABLE organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  logo_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  name text NOT NULL,
  time_zone text NOT NULL DEFAULT 'Asia/Riyadh',
  currency char(3) NOT NULL DEFAULT 'SAR',
  -- Club-changeable rules (cancellation windows, horse limits, ...). Mirrors packages/domain/src/policy.ts
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true
);

-- ---------- People ----------
CREATE TYPE account_role AS ENUM ('customer','coach','stable_hand','reception','manager','owner');

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role account_role NOT NULL,
  full_name text,
  phone text UNIQUE,
  email text UNIQUE,
  password_hash text,
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ar')),
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleted')),
  anonymised_at timestamptz,            -- set by the erase job after account deletion
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Which branches a staff account may work in (used for row-level security below).
CREATE TABLE account_branches (
  account_id uuid NOT NULL REFERENCES accounts(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  PRIMARY KEY (account_id, branch_id)
);

CREATE TYPE rider_status AS ENUM ('draft','pending_review','active','restricted','suspended','inactive','archived');
CREATE TYPE level AS ENUM ('beginner','intermediate','advanced');

CREATE TABLE riders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  account_id uuid REFERENCES accounts(id),       -- null for a child who has no login of their own
  full_name text NOT NULL,
  date_of_birth date NOT NULL,
  level level NOT NULL DEFAULT 'beginner',
  status rider_status NOT NULL DEFAULT 'pending_review',
  is_walk_in boolean NOT NULL DEFAULT false,     -- single-visit riders need no account
  medical_notes text,
  allergies text,
  emergency_contact jsonb,
  anonymised_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A guardian can manage many riders; a rider can have several guardians.
CREATE TABLE guardian_riders (
  guardian_account_id uuid NOT NULL REFERENCES accounts(id),
  rider_id uuid NOT NULL REFERENCES riders(id),
  PRIMARY KEY (guardian_account_id, rider_id)
);

CREATE TYPE document_kind AS ENUM ('medical_form','waiver','photo_permission','id_document');
CREATE TABLE rider_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id uuid NOT NULL REFERENCES riders(id),
  kind document_kind NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','verified','rejected','expired','superseded')),
  file_ref text,
  signed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Arenas, horses, coaches ----------
CREATE TABLE arenas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL,
  max_capacity int NOT NULL CHECK (max_capacity >= 1)
);

CREATE TABLE arena_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  arena_id uuid NOT NULL REFERENCES arenas(id),
  during tstzrange NOT NULL,
  reason text NOT NULL
);

CREATE TYPE horse_status AS ENUM ('available','resting','reserved','under_training','medical_hold','injured','retired');
CREATE TABLE horses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL,
  status horse_status NOT NULL DEFAULT 'available',
  suitable_levels level[] NOT NULL DEFAULT '{}',
  notes text
);
CREATE TABLE horse_arenas (   -- many-to-many suitability
  horse_id uuid NOT NULL REFERENCES horses(id),
  arena_id uuid NOT NULL REFERENCES arenas(id),
  PRIMARY KEY (horse_id, arena_id)
);

CREATE TABLE staff_unavailability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_account_id uuid NOT NULL REFERENCES accounts(id),
  during tstzrange NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('requested','approved','rejected'))
);

-- ---------- Classes (called occurrences) ----------
CREATE TYPE occurrence_status AS ENUM ('draft','published','in_progress','completed','cancelled');
CREATE TYPE class_format AS ENUM ('private','semi_private','group','trial','camp','assessment','open_riding');

CREATE TABLE occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  series_id uuid,                                   -- recurring series, if any
  title text NOT NULL,
  format class_format NOT NULL,
  min_level level NOT NULL DEFAULT 'beginner',
  arena_id uuid NOT NULL REFERENCES arenas(id),
  coach_id uuid NOT NULL REFERENCES accounts(id),
  during tstzrange NOT NULL CHECK (NOT isempty(during) AND lower_inc(during) AND NOT upper_inc(during)),
  capacity int NOT NULL CHECK (capacity >= 1),
  price_minor int NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  status occurrence_status NOT NULL DEFAULT 'draft',
  -- A manager may knowingly double-book. That needs a reason and is logged; see occurrence_overrides.
  allow_overlap boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Hard guarantee behind the rules engine: no two live classes share an arena or a coach at the same time.
  CONSTRAINT no_arena_double_booking EXCLUDE USING gist (arena_id WITH =, during WITH &&) WHERE (status <> 'cancelled' AND NOT allow_overlap),
  CONSTRAINT no_coach_double_booking EXCLUDE USING gist (coach_id WITH =, during WITH &&) WHERE (status <> 'cancelled' AND NOT allow_overlap)
);
CREATE INDEX occurrences_branch_time ON occurrences USING gist (branch_id, during);

CREATE TABLE occurrence_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id uuid NOT NULL REFERENCES occurrences(id),
  codes text[] NOT NULL,                 -- which checks were overridden, e.g. {ARENA_OVERLAP}
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  approved_by uuid NOT NULL REFERENCES accounts(id),
  approved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE horse_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id uuid NOT NULL REFERENCES occurrences(id),
  horse_id uuid NOT NULL REFERENCES horses(id),
  rider_id uuid REFERENCES riders(id),
  during tstzrange NOT NULL,
  CONSTRAINT no_horse_double_booking EXCLUDE USING gist (horse_id WITH =, during WITH &&)
);

-- ---------- Bookings and waitlist ----------
CREATE TYPE booking_status AS ENUM ('pending_office_payment','confirmed','checked_in','completed','cancelled','no_show');
CREATE TYPE pay_with AS ENUM ('package','office');

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  occurrence_id uuid NOT NULL REFERENCES occurrences(id),
  rider_id uuid NOT NULL REFERENCES riders(id),
  status booking_status NOT NULL,
  pay_with pay_with NOT NULL,
  rider_package_id uuid,                              -- FK added after packages below
  source text NOT NULL DEFAULT 'customer_app' CHECK (source IN ('customer_app','staff_portal','walk_in','imported')),
  created_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  hold_expires_at timestamptz,                        -- for pending_office_payment
  cancelled_at timestamptz,
  cancel_cause text CHECK (cancel_cause IN ('customer','club','weather')),
  consumed_class boolean                              -- decided by the rules engine at cancellation
);
-- A rider can hold only one live booking per class.
CREATE UNIQUE INDEX one_live_booking_per_rider_class ON bookings (occurrence_id, rider_id)
  WHERE status IN ('pending_office_payment','confirmed','checked_in','completed');

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id uuid NOT NULL REFERENCES occurrences(id),
  rider_id uuid NOT NULL REFERENCES riders(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','offered','converted','expired','declined','removed')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  offered_at timestamptz,
  offer_expires_at timestamptz
);
CREATE UNIQUE INDEX one_open_waitlist_entry ON waitlist_entries (occurrence_id, rider_id) WHERE status IN ('active','offered');

-- ---------- Packages and the append-only ledger ----------
CREATE TABLE package_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL,
  classes int NOT NULL CHECK (classes >= 1),
  price_minor int NOT NULL CHECK (price_minor >= 0),
  valid_days int NOT NULL CHECK (valid_days >= 1),
  class_formats class_format[] NOT NULL DEFAULT '{group}',
  active boolean NOT NULL DEFAULT true
);

-- Packages belong to ONE rider. Siblings do not share (BRD default for OD-05).
CREATE TABLE rider_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id uuid NOT NULL REFERENCES riders(id),
  package_type_id uuid NOT NULL REFERENCES package_types(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','frozen','exhausted','expired','cancelled')),
  purchased_at timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NOT NULL
);
ALTER TABLE bookings ADD CONSTRAINT bookings_package_fk FOREIGN KEY (rider_package_id) REFERENCES rider_packages(id);

CREATE TABLE package_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_package_id uuid NOT NULL REFERENCES rider_packages(id),
  delta int NOT NULL CHECK (delta <> 0),
  reason text NOT NULL CHECK (reason IN ('purchase','use','return','adjustment','expiry')),
  ref_key text NOT NULL,                       -- idempotency: the same event can be written once
  booking_id uuid REFERENCES bookings(id),
  note text,
  by_account uuid REFERENCES accounts(id),     -- null = system
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rider_package_id, ref_key),
  CHECK (reason <> 'adjustment' OR length(btrim(coalesce(note,''))) > 0)
);

-- Balance is always computed from the ledger: no stored number can drift.
CREATE VIEW package_balances AS
  SELECT rider_package_id, sum(delta)::int AS balance FROM package_ledger GROUP BY rider_package_id;

-- Never below zero. Locks the package row so two requests for the last class are handled one at a time.
CREATE FUNCTION package_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_balance int;
BEGIN
  PERFORM 1 FROM rider_packages WHERE id = NEW.rider_package_id FOR UPDATE;
  SELECT coalesce(sum(delta),0) INTO current_balance FROM package_ledger WHERE rider_package_id = NEW.rider_package_id;
  IF current_balance + NEW.delta < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER package_ledger_guard BEFORE INSERT ON package_ledger FOR EACH ROW EXECUTE FUNCTION package_ledger_guard();

-- ---------- Money: payments and receipts (pay at the office only, no online payments) ----------
CREATE TABLE receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  number text NOT NULL UNIQUE,                 -- R-20418; allocated by the application inside the transaction
  rider_id uuid REFERENCES riders(id),
  guardian_account_id uuid REFERENCES accounts(id),
  amount_minor int NOT NULL CHECK (amount_minor > 0),
  vat_minor int NOT NULL DEFAULT 0 CHECK (vat_minor >= 0),
  method text NOT NULL CHECK (method IN ('cash','card_at_desk','bank_transfer')),
  for_booking_id uuid REFERENCES bookings(id),
  for_rider_package_id uuid REFERENCES rider_packages(id),
  issued_by uuid NOT NULL REFERENCES accounts(id),
  issued_at timestamptz NOT NULL DEFAULT now()
);

-- A mistake is fixed by a new adjustment, never by editing a receipt.
CREATE TABLE financial_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  receipt_id uuid REFERENCES receipts(id),
  rider_id uuid REFERENCES riders(id),
  kind text NOT NULL CHECK (kind IN ('refund','credit','write_off','correction')),
  amount_minor int NOT NULL CHECK (amount_minor <> 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by uuid NOT NULL REFERENCES accounts(id),
  approved_by uuid REFERENCES accounts(id),    -- required above the branch threshold; enforced by the application
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Progress ----------
CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level level NOT NULL,
  name text NOT NULL,
  sort int NOT NULL DEFAULT 0
);
CREATE TABLE rider_skills (
  rider_id uuid NOT NULL REFERENCES riders(id),
  skill_id uuid NOT NULL REFERENCES skills(id),
  signed_off_by uuid REFERENCES accounts(id),
  signed_off_at timestamptz,
  PRIMARY KEY (rider_id, skill_id)
);

-- ---------- Incidents and account deletion ----------
CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','action_in_progress','pending_closure','closed','reopened')),
  kind text NOT NULL,
  rider_id uuid REFERENCES riders(id),
  horse_id uuid REFERENCES horses(id),
  description text NOT NULL,
  reported_by uuid NOT NULL REFERENCES accounts(id),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  login_locked_at timestamptz,               -- login closes immediately on request
  erase_after timestamptz NOT NULL,           -- 30-day grace
  status text NOT NULL DEFAULT 'locked' CHECK (status IN ('locked','needs_review','erased','cancelled'))
);

-- ---------- Audit log (append-only) ----------
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_account_id uuid REFERENCES accounts(id),
  branch_id uuid REFERENCES branches(id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- Make financial and audit history permanent ----------
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END $$;

CREATE TRIGGER package_ledger_append_only BEFORE UPDATE OR DELETE ON package_ledger FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER receipts_append_only BEFORE UPDATE OR DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER adjustments_append_only BEFORE UPDATE OR DELETE ON financial_adjustments FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- Account erasure anonymises personal fields on accounts/riders; receipts keep amounts and numbers but hold no names (names are looked up via rider_id).

-- ---------- Branch isolation (row-level security) ----------
-- The API sets, per request:  SET LOCAL app.branch_ids = 'uuid1,uuid2';  and  SET LOCAL app.role = 'manager';
-- Staff then only ever see rows of their own branches, even if application code forgets a WHERE clause.
CREATE FUNCTION app_branch_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_to_array(nullif(current_setting('app.branch_ids', true), ''), ',')::uuid[], '{}')
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['riders','arenas','horses','occurrences','bookings','package_types','receipts','financial_adjustments','incidents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY branch_scope ON %I USING (branch_id = ANY (app_branch_ids()))', t);
  END LOOP;
END $$;
-- NOTE: the application connects as a non-owner role (e.g. trot_app) so these policies apply. Create that role in the deployment step.
