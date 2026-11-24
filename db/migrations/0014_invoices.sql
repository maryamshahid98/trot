-- Invoices and credit notes (BRD PAY-002, PAY-009, BR-013).
--
-- An invoice is the charge; a receipt (already in the system) is the payment that settles it; a credit note reduces a charge after
-- the fact (a refund or a credit). Money is never edited: what an invoice says is fixed when it is issued, and only its STATUS moves,
-- and only forward (issued -> paid | voided, paid -> credited). Prices, VAT and the VAT rate are kept as they were on the day (BR-013).

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 30001;
CREATE SEQUENCE IF NOT EXISTS credit_note_number_seq START 40001;
GRANT USAGE, SELECT ON SEQUENCE invoice_number_seq, credit_note_number_seq TO trot_app;
-- Numbers can have gaps (a rolled-back sale uses one), exactly like receipt numbers; nothing is ever edited or deleted.

CREATE TABLE invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid NOT NULL REFERENCES branches(id),
  number             text NOT NULL UNIQUE,                       -- I-30001
  rider_id           uuid NOT NULL REFERENCES riders(id),
  payer_account_id   uuid REFERENCES accounts(id),               -- the guardian or the rider's own account, when there is one
  booking_id         uuid UNIQUE REFERENCES bookings(id),
  rider_package_id   uuid UNIQUE REFERENCES rider_packages(id),
  status             text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'voided', 'credited')),
  currency           text NOT NULL,
  gross_minor        int  NOT NULL CHECK (gross_minor > 0),      -- the price, VAT included
  vat_minor          int  NOT NULL CHECK (vat_minor >= 0),
  vat_percent        numeric(5, 2) NOT NULL,                     -- the rate that applied on the day
  receipt_id         uuid REFERENCES receipts(id),               -- the payment that settled it
  issued_by          uuid REFERENCES accounts(id),
  issued_at          timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz,
  voided_at          timestamptz,
  CONSTRAINT one_thing_is_charged CHECK ((booking_id IS NOT NULL) <> (rider_package_id IS NOT NULL)),
  CONSTRAINT status_matches_dates CHECK (
    (status = 'issued' AND paid_at IS NULL AND voided_at IS NULL) OR
    (status IN ('paid', 'credited') AND paid_at IS NOT NULL AND voided_at IS NULL) OR
    (status = 'voided' AND voided_at IS NOT NULL AND paid_at IS NULL))
);
CREATE INDEX invoices_by_branch ON invoices (branch_id, issued_at DESC);
CREATE INDEX invoices_by_rider ON invoices (rider_id, issued_at DESC);

CREATE TABLE invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id),
  description text NOT NULL,
  quantity    int  NOT NULL DEFAULT 1 CHECK (quantity > 0),
  total_minor int  NOT NULL CHECK (total_minor > 0),             -- VAT included
  vat_minor   int  NOT NULL CHECK (vat_minor >= 0)
);

CREATE TABLE credit_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  number        text NOT NULL UNIQUE,                            -- CN-40001
  invoice_id    uuid NOT NULL REFERENCES invoices(id),
  adjustment_id uuid NOT NULL UNIQUE REFERENCES financial_adjustments(id),
  amount_minor  int  NOT NULL CHECK (amount_minor > 0),
  vat_minor     int  NOT NULL CHECK (vat_minor >= 0),
  reason        text NOT NULL CHECK (length(btrim(reason)) > 0),
  issued_by     uuid REFERENCES accounts(id),
  issued_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_notes_by_invoice ON credit_notes (invoice_id);

-- ---------- rules the database keeps, whatever the code does ----------

-- An invoice's money, number and what it is for never change. Its status only moves forward. It is never deleted.
CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on invoices is not allowed: an invoice is voided or credited, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.rider_id IS DISTINCT FROM OLD.rider_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id OR NEW.rider_package_id IS DISTINCT FROM OLD.rider_package_id
     OR NEW.gross_minor <> OLD.gross_minor OR NEW.vat_minor <> OLD.vat_minor OR NEW.vat_percent <> OLD.vat_percent OR NEW.currency <> OLD.currency
     OR NEW.issued_at <> OLD.issued_at THEN
    RAISE EXCEPTION 'An issued invoice cannot be changed, only its status moves' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'issued' AND NEW.status IN ('paid', 'voided')) OR (OLD.status = 'paid' AND NEW.status = 'credited')) THEN
    RAISE EXCEPTION 'An invoice cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard();
CREATE TRIGGER invoice_lines_append_only BEFORE UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER credit_notes_append_only BEFORE UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Credit notes can never add up to more than the invoice, and only a paid invoice can be credited.
CREATE FUNCTION credit_notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv invoices%ROWTYPE; already int;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF inv.status NOT IN ('paid', 'credited') THEN
    RAISE EXCEPTION 'Only a paid invoice can be credited (this one is %)', inv.status USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount_minor), 0) INTO already FROM credit_notes WHERE invoice_id = NEW.invoice_id;
  IF already + NEW.amount_minor > inv.gross_minor THEN
    RAISE EXCEPTION 'Credit notes would add up to more than the invoice' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_notes_guard BEFORE INSERT ON credit_notes FOR EACH ROW EXECUTE FUNCTION credit_notes_guard();

-- When a booking is cancelled (by the rider, the desk, a cancelled class, or an unpaid hold running out) its unpaid invoice is voided.
-- Done here so no code path can forget it. A PAID invoice stays as it is: money went in, and any refund is a credit note.
CREATE FUNCTION void_unpaid_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE invoices SET status = 'voided', voided_at = now() WHERE booking_id = NEW.id AND status = 'issued';
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_void_invoice AFTER UPDATE OF status ON bookings
  FOR EACH ROW WHEN (NEW.status = 'cancelled' AND OLD.status <> 'cancelled') EXECUTE FUNCTION void_unpaid_invoice();

-- Branch isolation.
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON invoices USING (branch_id = ANY (app_branch_ids()));
ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON credit_notes USING (branch_id = ANY (app_branch_ids()));
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_scope ON invoice_lines USING (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_lines.invoice_id));

GRANT SELECT, INSERT, UPDATE ON invoices TO trot_app;
GRANT SELECT, INSERT ON invoice_lines, credit_notes TO trot_app;
