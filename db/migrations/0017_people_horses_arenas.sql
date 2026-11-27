-- Rider, guardian, waiver, instructor, horse and arena records (BRD CUS, SAF-001, INS, HOR, ARE).

ALTER TABLE riders
  ADD COLUMN height_cm int CHECK (height_cm BETWEEN 50 AND 250),
  ADD COLUMN weight_kg int CHECK (weight_kg BETWEEN 10 AND 250),
  ADD COLUMN riding_experience text,
  ADD COLUMN preferences text,
  ADD COLUMN restrictions text,
  ADD COLUMN phone text,
  ADD COLUMN email text,
  -- A restriction or suspension applies between these days; empty means from now, with no end (CUS-006).
  ADD COLUMN restricted_from date,
  ADD COLUMN restricted_until date,
  ADD CONSTRAINT restriction_order CHECK (restricted_until IS NULL OR restricted_from IS NULL OR restricted_until >= restricted_from);

ALTER TABLE guardian_riders
  ADD COLUMN relationship text,
  ADD COLUMN has_authority boolean NOT NULL DEFAULT true,
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false,
  ADD COLUMN is_billing boolean NOT NULL DEFAULT false,
  ADD COLUMN is_emergency boolean NOT NULL DEFAULT false;
GRANT UPDATE ON guardian_riders TO trot_app;

-- The words a rider accepted. A new version is added, never edited.
CREATE TABLE waiver_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  version text NOT NULL,
  body text NOT NULL,
  -- True when riders who signed an earlier version must sign this one before riding again.
  requires_resign boolean NOT NULL DEFAULT true,
  published_by uuid REFERENCES accounts(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, version)
);
CREATE TRIGGER waiver_versions_append_only BEFORE UPDATE OR DELETE ON waiver_versions FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE waiver_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON waiver_versions USING (branch_id = ANY (app_branch_ids()));
GRANT SELECT, INSERT ON waiver_versions TO trot_app;
ALTER TABLE rider_documents ADD COLUMN waiver_version_id uuid REFERENCES waiver_versions(id);

-- What an instructor is qualified and available to do (INS-001, INS-002). No profile means no restriction is recorded yet.
CREATE TABLE staff_profiles (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  qualifications text,
  levels level[] NOT NULL DEFAULT '{beginner,intermediate,advanced}',
  formats class_format[] NOT NULL DEFAULT '{}',          -- empty: any kind of class or ride
  certification_expires date,
  work_days int[] NOT NULL DEFAULT '{}',                 -- 0 Sunday .. 6 Saturday; empty: any day
  work_from time,
  work_to time,
  max_sessions_per_day int CHECK (max_sessions_per_day BETWEEN 1 AND 20),
  CHECK ((work_from IS NULL) = (work_to IS NULL) AND (work_from IS NULL OR work_from < work_to))
);

ALTER TABLE horses
  ADD COLUMN owner text,
  ADD COLUMN stable text,
  ADD COLUMN stall text,
  ADD COLUMN max_rider_weight_kg int CHECK (max_rider_weight_kg BETWEEN 10 AND 250),
  ADD COLUMN min_rider_age int CHECK (min_rider_age BETWEEN 0 AND 99),
  ADD COLUMN formats class_format[] NOT NULL DEFAULT '{}',  -- empty: any kind of work
  ADD COLUMN max_sessions_per_day int CHECK (max_sessions_per_day BETWEEN 1 AND 20),
  ADD COLUMN max_sessions_per_week int CHECK (max_sessions_per_week BETWEEN 1 AND 100);

CREATE TABLE horse_care_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  horse_id uuid NOT NULL REFERENCES horses(id),
  kind text NOT NULL CHECK (kind IN ('health', 'vaccination', 'farrier', 'medication', 'care')),
  happened_on date NOT NULL,
  due_on date,                       -- when it is next due: the reminder
  notes text,
  recorded_by uuid REFERENCES accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX horse_care_by_horse ON horse_care_events (horse_id, happened_on DESC);
CREATE TRIGGER horse_care_append_only BEFORE UPDATE OR DELETE ON horse_care_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE horse_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  horse_id uuid NOT NULL REFERENCES horses(id),
  stable text,
  stall text,
  moved_by uuid REFERENCES accounts(id),
  moved_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER horse_moves_append_only BEFORE UPDATE OR DELETE ON horse_moves FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE horse_care_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON horse_care_events USING (EXISTS (SELECT 1 FROM horses h WHERE h.id = horse_care_events.horse_id));
ALTER TABLE horse_moves ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON horse_moves USING (EXISTS (SELECT 1 FROM horses h WHERE h.id = horse_moves.horse_id));
GRANT SELECT, INSERT ON horse_care_events, horse_moves TO trot_app;

ALTER TABLE arenas
  ADD COLUMN kind text,
  ADD COLUMN surface text,
  ADD COLUMN length_m numeric(6, 1) CHECK (length_m > 0),
  ADD COLUMN width_m numeric(6, 1) CHECK (width_m > 0),
  ADD COLUMN activities text,
  ADD COLUMN shared_use boolean NOT NULL DEFAULT false,
  ADD COLUMN opens_at time,
  ADD COLUMN closes_at time,
  ADD CONSTRAINT arena_hours_pair CHECK ((opens_at IS NULL) = (closes_at IS NULL) AND (opens_at IS NULL OR opens_at < closes_at));

-- A shared arena may hold several sessions at once, up to its capacity. Exclusive arenas keep the database guarantee.
ALTER TABLE occurrences ADD COLUMN shared_arena boolean NOT NULL DEFAULT false;
ALTER TABLE occurrences DROP CONSTRAINT no_arena_double_booking;
ALTER TABLE occurrences ADD CONSTRAINT no_arena_double_booking
  EXCLUDE USING gist (arena_id WITH =, during WITH &&) WHERE (status <> 'cancelled' AND NOT allow_overlap AND NOT shared_arena);
