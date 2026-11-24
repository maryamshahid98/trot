# First run

This gets the database, the API and the tests running on your machine. You need Node 22.9 or newer and Docker Desktop
(running). Every command below is run from the `trot` folder unless it says otherwise.

## 1. Create your settings file

```
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env`.

Open `.env` and fill in the blanks. The API refuses to start, and tells you what is missing, until you do:

- `JWT_SECRET`: a long random string. Make one with
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
- `APP_DB_PASSWORD`: pick a password for the API's database login. Put the same one in `DATABASE_URL` and
  `TEST_DATABASE_URL`, where it says `CHANGE_ME`.
- `SEED_PASSWORD`: the password the demo accounts will have, at least 10 characters.

`.env` stays on your machine and is never committed.

## 2. Start the database and install

```
docker compose up -d
npm install
```

The database starts empty. Next you create the tables.

## 3. Create the tables and the demo data

```
cd apps/api
npm run db:migrate
npm run db:seed
```

If something is wrong in a migration, the output shows the file and the error.

## 4. Start the API

```
npm start
```

Open <http://localhost:3000/health>. You should see `"status":"ok"` and the latest migration name.

To sign in as the demo manager (use the `SEED_PASSWORD` you chose):

```
curl -X POST http://localhost:3000/auth/login -H "content-type: application/json" \
     -d '{"identifier":"maha@example.test","password":"<your SEED_PASSWORD>"}'
```

The other demo accounts are `owner@`, `sara@` (reception), `faisal@` (coach) and `reem@` (customer), all at
`example.test`.

## 5. Run the tests

```
npm test
```

This rebuilds a separate database called `trot_test` from scratch each time and runs everything there, so your development
data is never touched and every run starts from the same clean state. The booking rules have their own tests: run `npm test` from the `trot` folder, or `npm run typecheck` inside
`packages/domain`.

## Stopping and starting over

- Stop the database but keep its data: `docker compose stop`. Bring it back with `docker compose start`.
- Start completely fresh: `docker compose down -v` deletes the database. Then run `docker compose up -d` and repeat steps 3 and 4.

## Checking the safety rules by hand

These checks prove the database refuses the things it should, even if the API had a bug. Open a SQL console as the
superuser:

```
docker exec -it trot-db psql -U trot -d trot
```

Add a test rider with a 20-class package:

```sql
INSERT INTO riders (id, branch_id, full_name, date_of_birth, status)
VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', 'Test Rider', '2016-03-14', 'active');

INSERT INTO rider_packages (id, rider_id, package_type_id, status, valid_until)
VALUES ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f2', 'active', now() + interval '180 days');

INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key)
VALUES ('00000000-0000-0000-0000-0000000000f9', 20, 'purchase', 'purchase:1');
```

Each of these must fail:

```sql
-- The ledger can't be edited
UPDATE package_ledger SET delta = 99;

-- The balance can't go below zero
INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key)
VALUES ('00000000-0000-0000-0000-0000000000f9', -21, 'use', 'use:too-many');

-- The same event can't be written twice
INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key)
VALUES ('00000000-0000-0000-0000-0000000000f9', 20, 'purchase', 'purchase:1');
```

Double-booking is covered by `npm test`, in the arena and coach overlap tests.

The test rider and the ledger entry can't be deleted, because the ledger is append-only. To clear them, start fresh as
described above.
