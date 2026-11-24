# @trot/api

The Trot backend, built with NestJS and PostgreSQL. It runs TypeScript directly with `tsx`, so there is no build step.

To set up and run it for the first time, follow [`docs/first-run.md`](../../docs/first-run.md).

## Commands

Run these from `apps/api`.

| Command | What it does |
|---|---|
| `npm start` | Starts the API on the port from `.env` (3000 by default). |
| `npm run dev` | The same, restarting when a file changes. |
| `npm test` | Rebuilds the separate `trot_test` database from scratch, then runs all the tests on it. |
| `npm run typecheck` | Checks the types without running anything. |
| `npm run db:migrate` | Applies new migrations from `db/migrations`. |
| `npm run db:seed` | Loads the demo data and gives the demo accounts their password. Development only. |
| `npm run db:test-setup` | Drops and rebuilds the test database, then migrates and seeds it. `npm test` does this for you. |

## Endpoints

| Route | Who can use it | What it does |
|---|---|---|
| `GET /health` | Anyone | Whether the API and the database are up, and the latest migration. |
| `POST /auth/login` | Anyone (rate limited) | Email or phone plus password. Returns an access token and a refresh token. The website (header `X-Trot-Client: web`) gets the refresh token only as an HttpOnly, SameSite=Strict cookie on path `/auth`, never in the body. |
| `POST /auth/refresh` | Anyone (rate limited) | Swaps a refresh token for a new pair. Each refresh token works once. The website sends no body: the cookie is used, and a token in the body is ignored. |
| `POST /auth/logout` | Anyone (rate limited) | Ends that sign-in. The website sends no body (the cookie is used and cleared). |
| `GET /auth/me` | Signed in | Who you are and which branches you work in. |
| `POST /auth/change-password` | Signed in | Changes your password and signs out your other devices. |
| `GET /schedule` | Signed in | Classes in a branch and date range. Customers see published classes only. |
| `POST /schedule` | Reception, manager, owner | Creates a class. A manager or owner can override a clash with a written reason. |
| `POST /bookings` | Customer (own riders and wards), reception, manager, owner | Books a rider into a class, paying with a package or at the office. Returns every reason at once if the rider is not eligible. A full class puts the rider on the waitlist. |
| `POST /bookings/:id/cancel` | Customer (own riders and wards), reception, manager, owner | Cancels a booking. The rules decide whether the class goes back to the package. Only staff can say the club or the weather caused it. |
| `GET /bookings/mine` | Customer | Bookings and waitlist entries for the customer's riders and wards. |
| `GET /bookings?occurrenceId=` | Reception, manager, owner, and the class's own coach | The roster of a class. |
| `POST /bookings/:id/check-in` | Coach (own class), reception, manager, owner | Checks a rider in from 60 minutes before the class until it ends. Not for unpaid office bookings. |
| `POST /bookings/:id/no-show` | Coach (own class), reception, manager, owner | Marks a rider who did not come, once the class has started. |
| `POST /schedule/:id/complete` | Coach (own class), reception, manager, owner | Closes a class. Riders not checked in must be marked as no-shows first, or all at once with `markRemainingNoShow`. |
| `POST /schedule/:id/cancel` | Manager, owner | Cancels a whole class with a written reason. Everyone is cancelled without charge and package classes come back. |
| `POST /schedule/:id/waitlist/refresh` | Reception, manager, owner | Offers any free places to the people waiting. |
| `POST /waitlist/:id/accept` | Customer (own), reception, manager, owner | Takes up a waitlist offer, paying with a package or at the office. |
| `POST /waitlist/:id/leave` | Customer (own), reception, manager, owner | Leaves the waitlist or turns down an offer. The next person is offered the place. |
| `GET /package-types` | Signed in | The price list. Customers see what is on sale; staff can include retired types. |
| `POST /package-types`, `PATCH /package-types/:id` | Manager, owner | Creates or changes a package type. Changes affect future sales only. |
| `GET /riders/:id/packages`, `GET /packages/:id/ledger` | The rider's customer or guardian, staff | What a rider has left, and the history of every class added or used. |
| `POST /riders/:id/packages` | Reception, manager, owner | Sells a package at the desk. Creates the package, its classes and the receipt together. |
| `POST /packages/:id/adjust` | Manager, owner | Adds or removes classes with a written reason. The balance never goes below zero. |
| `POST /packages/:id/status` | Manager, owner | Freezes, unfreezes or cancels a package, with a reason. |
| `POST /bookings/:id/payment` | Reception, manager, owner | Records payment at the desk for a pay-at-office booking: issues the receipt and confirms the booking. |
| `POST /bookings/:id/confirm-unpaid` | Manager, owner | Confirms a booking before payment, with a reason that is kept on record. |
| `GET /receipts`, `GET /receipts/mine`, `GET /receipts/:id` | Staff, or the customer for their own | Receipts with VAT. Receipts are never edited or deleted. |
| `POST /receipts/:id/adjustments` | Reception (up to SAR 500), manager, owner | Refund, credit, write-off or correction, with a reason. Refunds can never total more than was paid. |
| `POST /riders` | Customer, reception, manager, owner | Adds a rider. A customer adds themselves or a child they guard and it waits for approval. Staff-created riders are approved straight away. |
| `GET /riders/mine` | Customer | The customer's own profile and their children. |
| `GET /riders` | Reception, manager, owner | Search riders by name or status. No medical details in the list. |
| `GET /riders/:id` | The rider's customer or guardian, reception, manager, owner | One rider, with medical notes and emergency contact. |
| `PATCH /riders/:id` | Same as above | Edits details. Only staff can change the date of birth. |
| `POST /riders/:id/level` | Coach, manager, owner | Sets the riding level. |
| `POST /riders/:id/status` | Reception (approve or reject), manager, owner | Approves, restricts, suspends or deactivates, with a written reason. |
| `GET/POST /riders/:id/guardians`, `DELETE /riders/:id/guardians/:accountId` | Reception, manager, owner | Who may book for a child. The last guardian of a child cannot be removed. |
| `POST /riders/:id/documents`, `GET /riders/:id/documents` | The rider's customer or guardian, staff | Sends in a medical form, waiver or other document, and lists them. |
| `POST /documents/:id/verify`, `POST /documents/:id/reject` | Reception, manager, owner | Staff check a submitted document. Only verified documents let a rider book. |
| `GET /ride-types`, `GET /ride-types/:id` | Everyone signed in (customers see only types that are on sale) | The ride catalogue: name, price, length, capacity, minimum level and age, and the dates it is offered. |
| `POST /ride-types`, `PATCH /ride-types/:id` | Manager, owner | Adds or changes a ride type, or switches it off. Changing a price or length never changes a ride already scheduled. |
| `POST /rides` | Reception, manager, owner | Schedules one ride from a ride type: the type sets the price, length, level and minimum age. Location and guide go through the same clash, closure, leave and override checks as a class. |
| `GET /schedule?kind=ride` or `kind=class` | Everyone signed in | Shows only rides or only classes. Leave `kind` out to see both. |
| `GET /horses`, `GET /horses/:id`, `GET /horses/:id/workload` | Coach, stable hand, reception, manager, owner | The stable, and how many sessions a horse has worked each day. |
| `POST /horses`, `PATCH /horses/:id` | Manager, owner | Adds a horse or changes its levels, arenas and notes. A retired horse cannot be edited. |
| `POST /horses/:id/status` | Stable hand, manager, owner (retiring: manager, owner) | Rest, training, medical hold, injury or retirement, with a reason. Lists the classes ahead the horse was planned for. |
| `GET/POST /schedule/:id/horses`, `DELETE /schedule/:id/horses/:assignmentId` | Coach (own class), reception, manager, owner | Gives a horse to a rider or class. Checks status, arena, level, rest gap and daily and weekly limits. |
| `GET /schedule/:id/horses/suggestions` | Coach (own class), reception, manager, owner | Which horses could take this class, and why the others cannot. |
| `GET/POST /accounts`, `GET/PATCH /accounts/:id` | Manager, owner | People in your branches. You can only manage people ranked below you. |
| `POST /accounts/:id/role`, `/status`, `/unlock`, `/reset-password`, `PUT /accounts/:id/branches` | Manager, owner | Changes role, locks or unlocks, resets a staff password, sets branch membership. Locking ends every sign-in at once. |
| `GET /branches`, `GET /branches/:id`, `PATCH /branches/:id` | Signed in (change: manager, owner) | Your branches, name and time zone. |
| `GET/PATCH /branches/:id/policy` | Staff read; manager, owner change | The club rules for this branch (cancellation window, hold time, horse limits ...). Null puts a rule back to the default. |
| `GET/POST /arenas`, `PATCH /arenas/:id` | Staff read; manager, owner change | Arenas of a branch. |
| `GET/POST /arenas/:id/closures`, `DELETE /arenas/:id/closures/:closureId` | Staff read; manager, owner change | Times an arena is closed. Refused while classes are planned in that time. |
| `GET/POST /staff-leave`, `POST /staff-leave/:id/decision`, `DELETE /staff-leave/:id` | Staff (own leave); manager, owner decide | Time off. Refused while the coach still has classes in that time. |
| `POST /jobs/expiry` | Manager, owner | Runs the clean-up now: releases unpaid holds, passes on unanswered waitlist offers, expires packages past their date. Also runs on a timer (`JOBS_INTERVAL_SECONDS`). |
| `GET /reports/revenue`, `/reports/attendance`, `/reports/utilisation` | Manager, owner | Money by method and day (less refunds), who came and who did not, and how full classes were. Needs `from` and `to`, at most 366 days. |
| `GET /reports/rides` | Manager, owner | Rides by type: places, bookings, no-shows, cancelled rides and ride money. Places are counted by the day the ride runs, money by the day the receipt was issued. |
| `GET /reports/unpaid` | Manager, owner | Riders let in without paying and still owing, with the manager's reason. |
| `GET /audit-log` | Manager, owner | Who did what, newest first, filtered by action, entity or person. Page with `before`. |
| `POST /incidents`, `GET /incidents`, `GET /incidents/:id`, `GET /incidents/:id/history` | Staff (own reports); manager, owner (all) | Reports what happened. The story is kept out of the audit trail. |
| `POST /incidents/:id/status` | Manager, owner | Moves an incident along its steps. Closing needs a note; only an owner closes a critical one. |

## Configuration

All settings live in the `.env` file at the project root and are read in one place, `src/config/env.ts`. The API checks
them when it starts, and refuses to start, naming each problem, if one is missing or invalid. `.env.example` lists every
setting and its default.

- Secrets and database URLs have no default. A missing one stops the start.
- Everything else has a documented default, so `.env` only needs the values you change.
- A blank value means "use the default". A value that isn't a valid number is an error. It never quietly switches something off.
- `src/config/constants.ts` holds the product's fixed rules: roles, statuses, input limits and error codes. A test checks
  its lists against the database enums so they can't drift apart.
- The migration creates the `trot_app` database role without a password. In development `db:migrate` sets it from
  `APP_DB_PASSWORD`. In production, set it yourself and leave `APP_DB_PASSWORD` blank.
- `db:seed` refuses to run when `NODE_ENV=production`.
- The tests use their own database (`TEST_DATABASE_URL`) and refuse to run if it is the same as `DATABASE_URL`.

## How the code is organised

- Every route needs a signed-in user unless it is marked `@Public()`. Limit a route to certain roles with `@Roles(...)`.
- The branch a request acts on comes from the signed-in account, never from what the caller claims.
- Branch data is only read or written through `db.scoped({ branchIds, role }, fn)`. A plain `db.query` sees no branch data, on purpose.
- Every request body and query is checked with zod (`parse(schema, input)`) before anything else happens.
- Decisions come from `@trot/domain`. The database only guards against races and bugs.
- Settings and fixed rules never appear as literals in the code. A setting goes in `config/env.ts`, a fixed rule or limit in
  `config/constants.ts`. Only `config/env.ts` reads `process.env`, and everything else injects `APP_CONFIG`.
- Services list their dependencies with an explicit `@Inject(...)`, because `tsx` doesn't emit the type information Nest
  would otherwise use.
- A new endpoint comes with tests for: no token, wrong role, another branch, bad input, and the normal case.

## Places, holds and offers

- A pay-at-office booking holds its place for 10 minutes. After that the place is free again, and the booking is closed the next time anyone touches that class.
- When a place frees up (a cancellation, a declined or expired offer), the first eligible person waiting is offered it for 2 hours. Until they answer, the place is not free for anyone else.
- Offers and holds are checked whenever someone acts on the class. A timed job to run them on a clock is not built yet; staff can re-run the offers with `POST /schedule/:id/waitlist/refresh`.

## Money

- Prices are VAT-inclusive. The receipt shows the VAT part at 15% (`VAT_PERCENT` in `src/config/constants.ts`). Confirm the rate and the wording with the club's accountant.
- Receipt numbers (`R-20001` and up) come from a database sequence, so two desks never get the same one. A failed sale can leave a gap in the numbers; that is normal.
- The desk must type the amount it collected, and it must equal the price. A typo is refused instead of making a wrong receipt.
- Everything that moves money or classes is written once and never changed: the class ledger, receipts and adjustments are append-only in the database itself.

## Rides

A ride is an ordinary scheduled session (format `ride`) made from a ride type, so booking, the waitlist, check-in, payment, horse assignment, incidents and cancelling all use the same endpoints as classes.

- **Booking:** `POST /bookings` with `payWith: "office"`. A class package never pays for a ride (`RIDE_NOT_IN_PACKAGE`), and a database rule stops a package type from naming rides.
- **Price and length** are copied onto the ride when it is scheduled, and payments use that copy. Changing the ride type afterwards only affects rides scheduled after the change.
- **Rules:** minimum level and age (`RIDER_TOO_YOUNG`, judged on the day of the ride), documents, guardian, capacity, overlap and horse checks all apply.
- **Location and guide:** a ride uses an arena as its route or location, and a coach as its guide. Two rides cannot share one at the same time unless a manager overrides with a reason.
- **Weather or a closed route:** `POST /schedule/:id/cancel` with `cause: "weather"`. It cancels every booking, frees the horses, and returns nothing to a package because none was used.
- Not built yet: a package that covers a ride (it needs the club's answer to OD-17), weight limits, and customer messages (there is no notification service yet).
