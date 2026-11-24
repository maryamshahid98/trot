-- 0006: rides are a new kind of scheduled session. The value is added here, on its own, because Postgres will not
-- let a value be used in the same transaction that adds it. 0007 uses it.
ALTER TYPE class_format ADD VALUE IF NOT EXISTS 'ride';
