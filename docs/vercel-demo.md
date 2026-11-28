# A demo on Vercel

For showing the app with **made-up data only**. It is not a production setup: no real riders, no real medical information.
Vercel's free Hobby plan is for personal or non-commercial use; check their terms before using it for a paying client.

The website and the API are one Vercel project on one address (the API is under `/api`). The database is hosted separately,
for example on Neon.

## 1. Database

Create a PostgreSQL 16 database in a region near the Vercel region in `vercel.json` (`sin1`, Singapore). Copy its **direct**
(not pooled) connection address. From your computer, in the `trot` folder, set these for this terminal only (do not put them
in a committed file), then create the tables and the demo accounts:

```bash
export ADMIN_DATABASE_URL='<the owner connection address>?sslmode=require'
export APP_DB_PASSWORD='<a new long password>'
export SEED_PASSWORD='<a new password for the demo accounts>'
npm --workspace @trot/api run db:migrate
npm --workspace @trot/api run db:seed
```

The API must connect as the limited `trot_app` role that the migration creates, **not** as the owner, or the branch
separation does not apply. Its address is the same one with the user `trot_app` and the `APP_DB_PASSWORD` password.

## 2. Settings in the Vercel project

| Setting | Value |
|---|---|
| `DATABASE_URL` | the `trot_app` address |
| `DB_SSL` | `true` |
| `DB_POOL_MAX` | `3` |
| `JWT_SECRET` | a new random string of at least 32 characters |
| `CRON_SECRET` | another random string of at least 16 characters |
| `PUBLIC_API_PATH` | `/api` |
| `JOBS_INTERVAL_SECONDS` | `0` |
| `COOKIE_SECURE` | `true` |
| `TRUST_PROXY` | `1` |
| `UPLOAD_MAX_BYTES` | `4400000` |
| `NOTIFY_EMAIL` | `log` |
| `NODEJS_HELPERS` | `0` (the API reads request bodies itself) |

**Documents.** The function's disk is read-only apart from a temporary folder. Use an S3-compatible service
(`STORAGE_DRIVER=s3` and the S3 settings, see `deployment.md`). Without one, set `UPLOAD_DIR=/tmp/uploads`: uploading works,
but the files disappear at any time.

Use Node 22 or newer for the project. Do not add `NODE_ENV`: Vercel sets it when the function runs, and setting it yourself
makes the build skip the tools it needs.

## 3. Deploy

From the `trot` folder: `npx vercel` for a preview, `npx vercel --prod` for the demo address. Then open
`https://<address>/api/health` (it should say `ok`) and sign in at `https://<address>/` as `maha@example.test`.

## What differs from a real server

- The scheduled job (releasing unpaid holds, sending queued messages, reminders) runs **once a day** on the free plan
  (06:00 in Karachi). Managers can still send messages from the **Messages** screen. A place whose hold has run out is also
  released when someone else books that class.
- With email set to `log`, nothing is delivered, so password reset codes reach nobody.
- Files larger than 4.4 MB are refused.
- The first request after a quiet period is slower while the function starts.
