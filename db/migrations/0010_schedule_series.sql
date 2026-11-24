-- A repeating class (every week, or every 2 to 4 weeks) is saved once as a series; each date in it is an ordinary occurrence
-- that points back at the series. That way the whole series can be shown, and cancelled, together.
CREATE TABLE schedule_series (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  title            text NOT NULL,
  every_weeks      int  NOT NULL CHECK (every_weeks BETWEEN 1 AND 4),
  first_starts_at  timestamptz NOT NULL,
  session_count    int  NOT NULL CHECK (session_count BETWEEN 2 AND 52),
  created_by       uuid NOT NULL REFERENCES accounts(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE schedule_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON schedule_series USING (branch_id = ANY (app_branch_ids()));
GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_series TO trot_app;

-- occurrences.series_id has existed since the first migration as a plain placeholder; nothing has filled it in, so it can now point at a real series.
ALTER TABLE occurrences ADD CONSTRAINT occurrences_series_fk FOREIGN KEY (series_id) REFERENCES schedule_series(id);
CREATE INDEX occurrences_series ON occurrences (series_id) WHERE series_id IS NOT NULL;
