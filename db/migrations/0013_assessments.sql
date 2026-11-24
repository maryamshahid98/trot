-- Skills, assessments and the history of a rider's level (BRD 5.10, ATT-004, BR-022).
--
-- A rider's level changes only by an approved assessment (or a manager's written correction), and every change is kept forever in
-- rider_level_history, which cannot be edited or deleted.

-- The first migration created two placeholder tables for this, skills (one list for the whole organisation) and rider_skills, which no
-- code ever used. Clubs may differ from branch to branch, so skills now belong to a branch. Any organisation-wide skills that
-- someone did enter are copied into every branch below. rider_skills is replaced by assessments; it is dropped only if it is empty.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM rider_skills) THEN
    RAISE EXCEPTION 'rider_skills has rows. Move them by hand before running this migration: it replaces that table with assessments.';
  END IF;
END $$;
DROP TABLE rider_skills;
ALTER TABLE skills RENAME TO skills_org_wide;

-- The skills a club wants to see before moving a rider up. Each belongs to the level a rider must show it to be promoted INTO.
CREATE TABLE skills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES branches(id),
  name        text NOT NULL,
  description text,
  for_level   level NOT NULL,
  sort_order  int  NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, for_level, name)
);

INSERT INTO skills (branch_id, name, for_level, sort_order)
  SELECT b.id, o.name, o.level, o.sort FROM skills_org_wide o CROSS JOIN branches b ON CONFLICT DO NOTHING;
DROP TABLE skills_org_wide;

CREATE TABLE assessments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  rider_id       uuid NOT NULL REFERENCES riders(id),
  assessor_id    uuid NOT NULL REFERENCES accounts(id),
  from_level     level NOT NULL,
  target_level   level NOT NULL,
  recommendation text NOT NULL DEFAULT 'promote' CHECK (recommendation IN ('promote', 'stay', 'further_assessment')),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'needs_more', 'approved', 'rejected')),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  submitted_at   timestamptz,
  decided_by     uuid REFERENCES accounts(id),
  decided_at     timestamptz,
  decision_note  text,
  -- A second person decides: nobody approves, rejects or sends back their own assessment.
  CONSTRAINT assessor_does_not_decide CHECK (decided_by IS NULL OR decided_by <> assessor_id),
  CONSTRAINT decided_means_decided CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL))
);
-- One assessment at a time is open for a rider.
CREATE UNIQUE INDEX one_open_assessment_per_rider ON assessments (rider_id) WHERE status IN ('draft', 'submitted', 'needs_more');
CREATE INDEX assessments_by_status ON assessments (branch_id, status, created_at DESC);

CREATE TABLE assessment_ratings (
  assessment_id uuid NOT NULL REFERENCES assessments(id),
  skill_id      uuid NOT NULL REFERENCES skills(id),
  rating        smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  evidence      text,
  PRIMARY KEY (assessment_id, skill_id)
);

CREATE TABLE rider_level_history (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id     uuid NOT NULL REFERENCES branches(id),
  rider_id      uuid NOT NULL REFERENCES riders(id),
  from_level    level,
  to_level      level NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('initial', 'assessment', 'correction')),
  assessment_id uuid REFERENCES assessments(id),
  changed_by    uuid REFERENCES accounts(id),
  note          text,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessment_reason_has_assessment CHECK ((reason = 'assessment') = (assessment_id IS NOT NULL))
);
CREATE INDEX rider_level_history_rider ON rider_level_history (rider_id, id DESC);
CREATE TRIGGER level_history_append_only BEFORE UPDATE OR DELETE ON rider_level_history FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The history starts with where every rider is today.
INSERT INTO rider_level_history (branch_id, rider_id, from_level, to_level, reason, note)
SELECT branch_id, id, NULL, level, 'initial', 'Level when the history began' FROM riders;

-- Branch isolation, like every other branch-owned table.
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON skills USING (branch_id = ANY (app_branch_ids()));
ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON assessments USING (branch_id = ANY (app_branch_ids()));
ALTER TABLE rider_level_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON rider_level_history USING (branch_id = ANY (app_branch_ids()));
ALTER TABLE assessment_ratings ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON assessment_ratings USING (EXISTS (SELECT 1 FROM assessments a WHERE a.id = assessment_ratings.assessment_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON skills, assessments, assessment_ratings TO trot_app;
GRANT SELECT, INSERT ON rider_level_history TO trot_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trot_app;
