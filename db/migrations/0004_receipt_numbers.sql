-- 0004: receipt numbers. A database sequence hands out each number exactly once, even when two desks issue receipts at the same moment.
-- Numbers can have gaps (a rolled-back sale uses one); that is normal and does not matter, since receipts are never edited or deleted.
CREATE SEQUENCE IF NOT EXISTS receipt_number_seq START 20001;
GRANT USAGE, SELECT ON SEQUENCE receipt_number_seq TO trot_app;
