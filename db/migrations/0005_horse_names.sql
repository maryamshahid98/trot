-- 0005: two horses in one branch cannot share a name (ignoring capital letters), so a roster or a drop-down is never ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS horses_branch_name_unique ON horses (branch_id, lower(name));

-- A rider rides one horse per class. The service checks this first; this index decides a race between two people assigning at once.
CREATE UNIQUE INDEX IF NOT EXISTS horse_assignments_one_per_rider ON horse_assignments (occurrence_id, rider_id) WHERE rider_id IS NOT NULL;
