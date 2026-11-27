-- Class catalogue, ride rules and rates, package restrictions, booking numbers and lesson records
-- (BRD CLS, RIDE-001..007, PKG-002, PKG-006, BKG-007, BKG-010, ATT-002, ATT-006).

CREATE TABLE class_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  format class_format NOT NULL CHECK (format <> 'ride'),
  discipline text,
  duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 5 AND 600),
  capacity int NOT NULL CHECK (capacity >= 1),
  min_level level NOT NULL DEFAULT 'beginner',
  min_age_years int CHECK (min_age_years BETWEEN 0 AND 99),
  max_age_years int CHECK (max_age_years BETWEEN 0 AND 120),
  price_minor int NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  prerequisites text,
  cancel_hours int CHECK (cancel_hours BETWEEN 0 AND 720),       -- empty: the club rule
  single_visit boolean NOT NULL DEFAULT false,                   -- a one-off Trial or Single Class, never paid from a package
  active boolean NOT NULL DEFAULT true,
  CHECK (max_age_years IS NULL OR min_age_years IS NULL OR max_age_years >= min_age_years)
);
CREATE UNIQUE INDEX class_types_branch_name ON class_types (branch_id, lower(name));
ALTER TABLE class_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON class_types USING (branch_id = ANY (app_branch_ids()));
GRANT SELECT, INSERT, UPDATE ON class_types TO trot_app;

ALTER TABLE ride_types
  ADD COLUMN arena_id uuid REFERENCES arenas(id),                -- the usual route or location
  ADD COLUMN max_rider_weight_kg int CHECK (max_rider_weight_kg BETWEEN 10 AND 250),
  ADD COLUMN book_until_hours int CHECK (book_until_hours BETWEEN 0 AND 720),
  ADD COLUMN cancel_hours int CHECK (cancel_hours BETWEEN 0 AND 720),
  ADD COLUMN horse_required boolean NOT NULL DEFAULT false;
-- Ride types that exist already get the BRD's rule: a horse is assigned before riders are booked (RIDE-006).
UPDATE ride_types SET horse_required = true;

-- A different price or length from a given day (RIDE-002). Scheduling uses the latest one that has started.
CREATE TABLE ride_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_type_id uuid NOT NULL REFERENCES ride_types(id),
  from_date date NOT NULL,
  price_minor int NOT NULL CHECK (price_minor >= 0),
  duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 5 AND 600),
  UNIQUE (ride_type_id, from_date)
);
ALTER TABLE ride_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON ride_rates USING (EXISTS (SELECT 1 FROM ride_types t WHERE t.id = ride_rates.ride_type_id));
GRANT SELECT, INSERT, DELETE ON ride_rates TO trot_app;

-- Copied onto the session when it is scheduled, so a later catalogue change never changes it (BR-013, BR-033).
ALTER TABLE occurrences
  ADD COLUMN class_type_id uuid REFERENCES class_types(id),
  ADD COLUMN max_age_years int,
  ADD COLUMN max_rider_weight_kg int,
  ADD COLUMN book_until_hours int,
  ADD COLUMN cancel_hours int,
  ADD COLUMN horse_required boolean NOT NULL DEFAULT false,
  ADD COLUMN single_visit boolean NOT NULL DEFAULT false;

-- Where a package may be used. Empty lists mean no restriction. Rides are covered only when named (BR-034).
ALTER TABLE package_types
  ADD COLUMN ride_type_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN arena_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN levels level[] NOT NULL DEFAULT '{}',
  ADD COLUMN from_time time,
  ADD COLUMN to_time time,
  ADD COLUMN family boolean NOT NULL DEFAULT false;              -- shared by riders with the same guardian (OD-05)

CREATE SEQUENCE booking_number_seq START 100001;
GRANT USAGE, SELECT ON SEQUENCE booking_number_seq TO trot_app;
ALTER TABLE bookings
  ADD COLUMN number text NOT NULL DEFAULT ('B-' || nextval('booking_number_seq')::text),
  ADD COLUMN attendance text CHECK (attendance IN ('present', 'late', 'absent', 'excused')),
  ADD COLUMN actual_horse_id uuid REFERENCES horses(id),
  ADD COLUMN lesson_outcome text,
  ADD COLUMN skills_practised uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN instructor_notes text;
CREATE UNIQUE INDEX bookings_number ON bookings (number);
