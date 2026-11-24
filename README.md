# Trot

Trot is a management system for an equestrian club: classes, riders, horses, packages and payments. It will have an admin
web portal, a customer mobile app and a staff mobile app, all sharing one backend. The requirements come from the club's
BRD (`Equestrian_Club_Management_System_BRD_v2.0`).

Right now the backend is built and tested. The portal and the mobile apps are the next step.

## What's in here

| Folder | What it is |
|---|---|
| `packages/domain` | The booking rules as plain TypeScript: who may book, who gets the last place, what a cancellation costs. No framework and no database, so the rules are easy to read and test. |
| `db` | The PostgreSQL schema (`migrations`) and demo data for development (`seed`). |
| `apps/api` | The NestJS API. It signs people in, and it calls the domain rules inside database transactions. |
| `docs` | Setup instructions and the acceptance scenarios the club can check. |
| `apps/web` | The admin web portal (React + Vite): sign-in, dashboard, calendar, bookings, people, horses, money, reports, staff. |
| `apps/mobile` | Not started yet. |

## Where things stand

| Part | State |
|---|---|
| Booking rules (`packages/domain`) | Written and tested. |
| Database | Core schema, a limited role for the API with branch isolation, and sign-in tables. |
| API: sign-in | Log in, refresh, log out, "who am I" and change password. Accounts lock after repeated wrong passwords. |
| API: schedule | List classes, and create a class with clash checks. A manager or owner can override a clash with a written reason. |
| API: bookings | Book a class (with a package or at the office), join the waitlist when a class is full, cancel, see a class roster and my bookings. Uses the rules in `packages/domain` inside a transaction that locks the class. |
| API: packages, office payments, receipts, adjustments | Price list, selling packages, class balance history, adjustments and freezes, paying at the desk, receipts with VAT, refunds with limits. Needs migration `0004_receipt_numbers.sql`. |
| API: attendance, class lifecycle, waitlist offers | Check-in, no-show, complete or cancel a class, waitlist offers with a 2-hour answer window, lapsed office holds. |
| API: riders, documents, guardians | Sign-up of riders and children, document submit and verify, approval, level, guardians. |
| API: horses, incidents, rides, reports, admin, background jobs | Horse assignment, incident log, ride types, reports, accounts/branches/arenas/leave admin, and a job that releases expired holds and offers. |
| Admin web portal (`apps/web`) | In progress. |
| Mobile apps | Not started. |

## Checks

CI (`.github/workflows/ci.yml`) runs on every pull request: dependency audit, lint, typecheck, domain tests, API integration tests against Postgres, the web build and the API Docker image. Locally: `npm run lint`, `npm run typecheck`, `npm test` (domain), `npm run test:api` (needs the database from `docker compose up -d`).

## Deploying

The API has a Dockerfile. See [`docs/deployment.md`](docs/deployment.md) for the settings, the first-deployment steps and what is not covered.

## Getting started

Follow [`docs/first-run.md`](docs/first-run.md). You need Node 22.9 or newer and Docker Desktop.

## How the rules and the database fit together

The domain package decides *what should happen*: is the rider eligible, is the booking confirmed or waitlisted, does a
cancellation use up a class. The database makes sure the answer *can't be broken*, even by a bug or by two people clicking
at the same moment:

- **The last place in a class.** The API locks the class row, counts, decides, then inserts, so two requests are handled one after the other.
- **The last class in a package.** A database trigger refuses a balance below zero. Every event carries a unique key, so a retry can't charge or refund twice.
- **Double-booking.** The database refuses two live classes in the same arena, or with the same coach or horse, at the same time. A manager can override with a written reason, and it is logged.
- **History.** The ledger, receipts, adjustments and audit log can't be edited or deleted. A correction is a new entry.
- **Branches.** Row-level security limits staff to the branches they work in.

## Club decisions

Anything the club may change, such as the free-cancellation window, how long a pay-at-office booking holds a place, or the
daily limits for horses, is a setting in `packages/domain/src/policy.ts` with a working default, not a number buried in
code. Storing these per branch is planned. The API doesn't read them yet. `docs/acceptance-scenarios.md` lists the
defaults and the open decision (OD-xx) each one answers.
