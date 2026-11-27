-- Fuller incident records, corrective actions and evidence (SAF-003, SAF-004), where an audited change came from (AUD-001),
-- club settings (ORG-001) and the club's own message wording (COM-001).

CREATE SEQUENCE incident_number_seq START 1001;
GRANT USAGE, SELECT ON SEQUENCE incident_number_seq TO trot_app;
ALTER TABLE incidents
  ADD COLUMN number text NOT NULL DEFAULT ('INC-' || nextval('incident_number_seq')::text),
  ADD COLUMN arena_id uuid REFERENCES arenas(id),
  ADD COLUMN occurrence_id uuid REFERENCES occurrences(id),
  ADD COLUMN people text,
  ADD COLUMN witnesses text,
  ADD COLUMN immediate_action text;
CREATE UNIQUE INDEX incidents_number ON incidents (number);

CREATE TABLE incident_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id),
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  owner_id uuid REFERENCES accounts(id),
  due_on date,
  done_at timestamptz,
  done_note text,
  created_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE incident_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id),
  file_key text NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_size int NOT NULL,
  file_sha256 text NOT NULL,
  uploaded_by uuid REFERENCES accounts(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER incident_files_append_only BEFORE UPDATE OR DELETE ON incident_files FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE incident_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON incident_actions USING (EXISTS (SELECT 1 FROM incidents i WHERE i.id = incident_actions.incident_id));
ALTER TABLE incident_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON incident_files USING (EXISTS (SELECT 1 FROM incidents i WHERE i.id = incident_files.incident_id));
GRANT SELECT, INSERT, UPDATE ON incident_actions TO trot_app;
GRANT SELECT, INSERT ON incident_files TO trot_app;

-- Where a change was made from. Rows written before this say "api".
ALTER TABLE audit_log ADD COLUMN source text NOT NULL DEFAULT 'api';

ALTER TABLE organisations
  ADD COLUMN default_currency char(3) NOT NULL DEFAULT 'SAR',
  ADD COLUMN default_time_zone text NOT NULL DEFAULT 'Asia/Riyadh',
  ADD COLUMN languages text[] NOT NULL DEFAULT '{en}';

-- A branch's own wording for a message. Without a row the built-in wording is used.
CREATE TABLE notification_templates (
  branch_id uuid NOT NULL REFERENCES branches(id),
  event text NOT NULL,
  subject text NOT NULL CHECK (length(btrim(subject)) > 0),
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  updated_by uuid REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, event)
);
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON notification_templates USING (branch_id = ANY (app_branch_ids()));
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_templates TO trot_app;
