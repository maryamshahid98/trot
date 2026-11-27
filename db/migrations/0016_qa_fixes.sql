-- Fixes from QA against BRD v1.2.

-- Which riding levels an arena can host (ARE-002, BR-008). Existing arenas keep accepting every level until the club narrows them.
ALTER TABLE arenas ADD COLUMN supported_levels level[] NOT NULL DEFAULT '{beginner,intermediate,advanced}'
  CHECK (cardinality(supported_levels) > 0);

-- Opening hours and holidays, on the branch's own clock (ORG-002, SCH-002). No hours set means no restriction.
ALTER TABLE branches
  ADD COLUMN opens_at time,
  ADD COLUMN closes_at time,
  ADD COLUMN holidays date[] NOT NULL DEFAULT '{}',
  ADD COLUMN address text,
  ADD CONSTRAINT opening_hours_pair CHECK ((opens_at IS NULL) = (closes_at IS NULL) AND (opens_at IS NULL OR opens_at < closes_at));

-- Who the seller is on an invoice or receipt (ORG-001, PAY-002).
ALTER TABLE organisations
  ADD COLUMN legal_name text,
  ADD COLUMN tax_number text,
  ADD COLUMN address text,
  ADD COLUMN phone text,
  ADD COLUMN email text;

-- The reference printed by a physical card terminal (PAY-004).
ALTER TABLE receipts ADD COLUMN terminal_ref text;

-- A refund or correction recorded at the desk is approved later by a manager (PAY-005). The adjustment itself is never edited.
CREATE TABLE adjustment_approvals (
  adjustment_id uuid PRIMARY KEY REFERENCES financial_adjustments(id),
  approved_by   uuid NOT NULL REFERENCES accounts(id),
  approved_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER adjustment_approvals_append_only BEFORE UPDATE OR DELETE ON adjustment_approvals FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE adjustment_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON adjustment_approvals USING (EXISTS (SELECT 1 FROM financial_adjustments f WHERE f.id = adjustment_approvals.adjustment_id));
GRANT SELECT, INSERT ON adjustment_approvals TO trot_app;
