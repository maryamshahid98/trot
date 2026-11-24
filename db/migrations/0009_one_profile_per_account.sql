-- A customer may have only one rider profile of their own (a child's profile has no account of its own, so it is not covered).
-- The API already checks this before inserting, but two requests at the same moment could both pass that check.
-- This index makes the database the final judge; the API turns the resulting error into "you already have a profile".
CREATE UNIQUE INDEX riders_one_profile_per_account ON riders (account_id) WHERE account_id IS NOT NULL;
