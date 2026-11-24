-- 0007: ride types and rides (BRD v1.2, section 6.15).
-- A ride is an ordinary scheduled session (a row in occurrences) with format 'ride', so bookings, the waitlist,
-- check-in, payments, horse assignment, incidents and cancellation all work for rides without a second copy.
-- The ride type is the catalogue entry: name, price, duration, capacity and who may ride.
-- When a ride is scheduled, the type's price, name, level and minimum age are COPIED onto the occurrence, so changing
-- the catalogue later never changes a ride that is already scheduled or booked (BR-033, AC-032).

CREATE TABLE ride_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  price_minor int NOT NULL CHECK (price_minor >= 0),
  duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 5 AND 600),
  capacity int NOT NULL CHECK (capacity >= 1),
  min_level level NOT NULL DEFAULT 'beginner',
  min_age_years int CHECK (min_age_years IS NULL OR min_age_years BETWEEN 0 AND 99),
  active boolean NOT NULL DEFAULT true,
  active_from date,
  active_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ride_type_dates CHECK (active_from IS NULL OR active_to IS NULL OR active_to >= active_from)
);
CREATE UNIQUE INDEX ride_types_branch_name ON ride_types (branch_id, lower(name));

ALTER TABLE ride_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON ride_types USING (branch_id = ANY (app_branch_ids()));
GRANT SELECT, INSERT, UPDATE, DELETE ON ride_types TO trot_app;

ALTER TABLE occurrences
  ADD COLUMN ride_type_id uuid REFERENCES ride_types(id),
  ADD COLUMN min_age_years int CHECK (min_age_years IS NULL OR min_age_years BETWEEN 0 AND 99);

-- A ride always has a type, and only a ride has one.
ALTER TABLE occurrences ADD CONSTRAINT ride_has_type CHECK ((format = 'ride') = (ride_type_id IS NOT NULL));

-- A class package can never be set up to cover rides (BR-034). A ride entitlement would be a separate, later feature.
ALTER TABLE package_types ADD CONSTRAINT packages_never_cover_rides CHECK (NOT (class_formats @> ARRAY['ride']::class_format[]));

CREATE INDEX occurrences_ride_type ON occurrences (ride_type_id) WHERE ride_type_id IS NOT NULL;
