# Deploying Trot

Two images: the API (`apps/api/Dockerfile`) and the staff web portal (`apps/web/Dockerfile`). The API section comes first; the web portal is [further down](#deploying-the-web-portal).

The API ships as a Docker image (`apps/api/Dockerfile`). It needs a PostgreSQL 16 database and a handful of settings.
It keeps no state of its own, so you can run more than one copy behind a load balancer: sign-in rate limits are
counted in the database, and only one copy at a time runs the background clean-up job.

## Build

From the repository root:

```
docker build -f apps/api/Dockerfile -t trot-api .
```

## Settings (environment variables)

Never bake these into the image and never commit them. Give them to the container from your platform's secret store.

| Setting | Production value |
|---|---|
| `NODE_ENV` | `production` (the image sets it) |
| `DATABASE_URL` | Connects as the limited `trot_app` role, **never** as the superuser. Branch isolation depends on it. |
| `JWT_SECRET` | At least 32 random characters, unique to this environment. |
| `COOKIE_SECURE` | `true`. The website must be served over https. |
| `TRUST_PROXY` | The number of reverse proxies in front of the API (`1` behind one load balancer). Without it every request looks like it comes from the proxy, and all users share one rate limit. |
| `CORS_ORIGINS` | The exact website address(es), for example `https://portal.example.com`. |
| `DB_SSL` | `true` when the database requires TLS. |
| `GENERAL_RATE_LIMIT`, `AUTH_RATE_LIMIT`, `RATE_LIMIT_WINDOW_SECONDS` | Defaults are 600 requests and 20 sign-in attempts per address per 60 seconds. Raise them if many users share one address (an office network). |
| `RATE_LIMIT_KEY_PREFIX` | Only if two environments share one database. |
| `JOBS_INTERVAL_SECONDS` | Default 60. Safe on every copy: a database lock lets only one run at a time. |

All settings and their defaults are listed in `.env.example`. The API refuses to start, and names each problem, if a
required one is missing.

## First deployment: create the database tables

Run once, and again after every release that adds a file to `db/migrations`. It needs the **superuser** URL, so run it
as a one-off job, not inside the running API:

```
docker run --rm \
  -e ADMIN_DATABASE_URL=postgres://<superuser>:<password>@<host>:5432/<database> \
  trot-api npm --workspace @trot/api run db:migrate
```

- Create the `trot_app` role's password yourself (`ALTER ROLE trot_app PASSWORD '...';`) and leave `APP_DB_PASSWORD`
  unset in production, as `.env.example` explains.
- Do **not** run `db:seed`. It creates demo accounts and refuses to run when `NODE_ENV=production`.
- Take a database backup before every migration.
- Migration `0009` adds a unique index that fails if two customers already share a rider profile. If it fails, the
  error names the duplicates; fix them by hand and run it again.

## Rider documents (uploaded files)

Scans and photos of medical forms, waivers and IDs are kept as files in `UPLOAD_DIR` (`/data/uploads` in the image). The database
only keeps where each one is and a fingerprint of its contents.

- **Mount a persistent volume at `/data/uploads`.** Without it the files are lost when the container is replaced.
  `docker-compose.yml` already does this with the `trot-uploads` volume.
- **Back the folder up together with the database**, at the same time. A database restored without its files leaves documents
  that say "has a file" but cannot be opened (the API then answers 404 for those).
- **Several API servers must share the folder** (a shared network disk). If that is not possible, keep one server or add an
  object-storage implementation of `FileStorage` (`apps/api/src/riders/file-storage.ts`); nothing else has to change.
- Only PDF, JPEG and PNG are accepted, judged from the file's own bytes, up to `UPLOAD_MAX_BYTES` (5 MB by default). A reverse
  proxy in front must allow bodies at least that big (nginx's default of 1 MB would refuse them: set `client_max_body_size 6m;`).
- Reception, managers, owners and the rider's own family can open a file. Every opening is recorded in the audit log.
- **Files are not scanned for viruses.** If that matters to the club, scan on upload in front of the API.

## Messages (email)

Bookings, payments, cancellations, waitlist offers, class reminders, expiring packages and documents, and serious incidents each
queue a message. A message is saved **in the same transaction** as the change that caused it, then sent by the background job
(`JOBS_INTERVAL_SECONDS`, default 60) and retried after 2, 4, 8 and 16 minutes before it is marked failed. Managers see all of this
under **Messages** in the portal and can send now or try a failed message again.

- Set `NOTIFY_EMAIL=smtp` with `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` and `EMAIL_FROM` to send real email.
  The default `log` only writes the recipient (masked) and subject to the log, so nothing is sent from a development machine by accident.
  **In production, make sure it is `smtp`**, or customers receive nothing.
- Use a sender address the provider has verified (SPF and DKIM set up for the club's domain), or messages land in spam.
- Messages never contain medical details. An incident message carries only its severity and a reference.
- Essential messages (confirmations, receipts, cancellations, waitlist offers) are always sent. Reminders respect each person's
  choices (`PUT /notifications/preferences`, for the mobile apps).
- Arabic recipients currently receive the English text. Translations are added in `apps/api/src/notifications/templates.ts`
  once the club decides who approves them (BRD open decision OD-09).
- **SMS and push are not built in.** The message is recorded as `skipped`. Adding a provider means one class in
  `apps/api/src/notifications/providers.ts`; nothing else changes.

## Two-step sign-in

Staff (and customers, if they want) can protect their account with an authenticator app (Google Authenticator, Microsoft
Authenticator, Authy, 1Password and similar): **Security** in the portal, then scan the QR code and confirm with a code. Ten one-use
recovery codes are shown once, for a lost phone.

- **To require it for chosen roles**, set `MFA_REQUIRED_ROLES` (for example `owner,manager`). Those people can sign in but can do nothing
  except set it up until they have, and cannot turn it off. A change applies on their very next request.
- **Set `MFA_ENCRYPTION_KEY`** (at least 32 random characters) before anyone enrols, and keep it in the secret store like `JWT_SECRET`.
  It encrypts each authenticator secret in the database, so a stolen copy of the database alone cannot produce codes. If it is left blank
  the key is derived from `JWT_SECRET`, and changing `JWT_SECRET` later would force everybody to set up again.
- A code can be used once. A wrong code counts toward the same account lock-out as a wrong password.
- **A colleague who lost their phone and their recovery codes:** a manager or owner uses **Reset two-step sign-in** on the Staff screen
  (or `POST /accounts/:id/mfa/reset`). Their sign-ins end and, if their role requires it, they set it up again at the next sign-in.
- The phone's clock must be right (automatic time). Codes are accepted for the current 30 seconds and one step either side.
- There is no SMS code: it is weaker, and no SMS provider is built in.

## Health check

`GET /health` answers `200` when the database is reachable and `503` when it is not. The image already has a Docker
health check on it. Point your load balancer at the same address. It is exempt from rate limiting.

## Trying the whole stack on one machine

```
# .env needs JWT_SECRET and APP_DB_PASSWORD, and CORS_ORIGINS=http://localhost:8080
docker compose --profile app up --build -d
docker compose --profile app run --rm api npm --workspace @trot/api run db:migrate
curl http://localhost:3000/health     # the API
# the portal: http://localhost:8080
```

`docker-compose.yml` is for development: it publishes the database port and has a default superuser password of
`trot`. Do not use it as a production setup.

## Deploying the web portal

`apps/web/Dockerfile` builds the site and serves it with nginx (about 75 MB, runs as an unprivileged user, listens on port 8080).

```
docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://api.club.example -t trot-web .
docker run -p 8080:8080 trot-web
```

- **`VITE_API_URL` is required and is built into the site.** It must be the address people's browsers use to reach the
  API. The build stops with a message if you leave it out, because the site would otherwise quietly call `localhost`.
  Changing the API address means building the image again.
- **The portal and the API must be on the same site.** The sign-in cookie is `SameSite=strict`, so the browser only
  sends it when both addresses share the same registrable domain: `portal.club.example` and `api.club.example` work;
  `club-portal.com` and `club-api.net` do not. On different domains people are signed out every time they reload the
  page. This is a security setting, not a bug, so choose the addresses to suit it.
- **Tell the API about the portal.** Set the API's `CORS_ORIGINS` to the portal's exact address
  (`https://portal.club.example`) and `COOKIE_SECURE=true`. Both addresses must be https.
- The image already gives every page the right security headers (a Content-Security-Policy that allows calls only to the
  API address, no framing, no sniffing), caches the hashed files for a year, never caches the page itself, and sends
  addresses such as `/calendar` to the app so refreshing works. `GET /healthz` answers `ok` for a load balancer.
- The fonts are part of the site, so nothing is loaded from a third party.

You can also skip the image: `npm --workspace @trot/web run build`, then upload `apps/web/dist` to any static host. That host
must send unknown addresses to `index.html` and should set the same headers.

## What is not included

- **TLS** is terminated by your load balancer or reverse proxy, not by the API.
- **Backups, monitoring and log collection** belong to your platform. The API logs to standard output.
