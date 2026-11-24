-- 0002: a limited role for the API, and branch isolation on every branch-owned table.
-- Why: the Docker "trot" user is a superuser, and row-level security does not apply to superusers.
-- The API must connect as trot_app so the branch rules are actually enforced.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'trot_app') THEN
    -- No password on purpose: a migration that also runs in production must never create a login with a known password.
    -- Until a password is set this role cannot sign in. Development: `npm run db:migrate` sets it from APP_DB_PASSWORD (.env).
    -- Production: set it yourself, from your secret store:  ALTER ROLE trot_app PASSWORD '...';
    CREATE ROLE trot_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO trot_app', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO trot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trot_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO trot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO trot_app;

-- Tables that have no branch_id of their own are scoped through their parent row.
-- The parent's own policy applies inside the sub-query, so scope flows down the chain.
DO $$
DECLARE spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ARRAY['rider_packages',       'rider_id',         'riders'],
    ARRAY['rider_documents',      'rider_id',         'riders'],
    ARRAY['rider_skills',         'rider_id',         'riders'],
    ARRAY['package_ledger',       'rider_package_id', 'rider_packages'],
    ARRAY['waitlist_entries',     'occurrence_id',    'occurrences'],
    ARRAY['occurrence_overrides', 'occurrence_id',    'occurrences'],
    ARRAY['horse_assignments',    'occurrence_id',    'occurrences'],
    ARRAY['arena_closures',       'arena_id',         'arenas'],
    ARRAY['horse_arenas',         'horse_id',         'horses']
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', spec[1]);
    EXECUTE format(
      'CREATE POLICY branch_scope ON %I USING (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I))',
      spec[1], spec[3], spec[1], spec[2]);
  END LOOP;
END $$;
-- Not scoped by branch on purpose: accounts, account_branches, guardian_riders, staff_unavailability,
-- deletion_requests, skills, audit_log. They belong to a person, not a branch, and are guarded by the API.
