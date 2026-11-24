# Security: what is in place, and what is not yet

## In place (and covered by tests in apps/api/test)

| Area | Control |
|---|---|
| Sign-in | Passwords hashed with scrypt, never stored or logged. Same error and similar timing for unknown account, wrong password, locked account. |
| Brute force | 5 wrong passwords lock the account for 15 minutes. Open sign-in routes are limited to 20 requests a minute per address. |
| Sessions | Access token lasts 15 minutes. Refresh token lasts 14 days, is random, stored only as a hash, works once, and reuse cancels the whole sign-in. On the website the refresh token is an HttpOnly, SameSite=Strict cookie limited to `/auth` (Secure when `COOKIE_SECURE=true`), so page scripts can never read it, and the access token is kept in memory only. The website marks its calls with `X-Trot-Client: web`; a cookie without that header is ignored, and CORS only lets listed sites send it. The mobile apps keep using the body. |
| Token checks | Algorithm pinned to HS256, issuer and audience checked. Tokens signed with another key, with "alg: none", expired, or for another audience are refused. |
| Live account check | Every request re-reads the account. A locked or removed account stops working at once; role and branch changes apply on the next request. |
| Roles | Every route needs sign-in unless marked public. Routes list the roles allowed. |
| Branches | The branch comes from the account, not the caller. A request for another branch is refused. The database enforces the same rule (row-level security as a non-superuser role). |
| Input | Every body and query is checked with zod. Unknown fields are dropped (no mass assignment). Sizes, ranges and formats are limited. |
| Injection | Every query is parameterised. |
| Errors | One filter shapes all errors. Unexpected errors return a plain message and a request id; the detail is only in the server log. |
| Headers | nosniff, no framing, no referrer, no caching, HSTS, locked-down CSP, no X-Powered-By. CORS only for listed sites. |
| History | Ledger, receipts, adjustments and the audit log cannot be edited or deleted. Sign-ins, failures, overrides and password changes are audited. |

## Not yet done (decide before launch)

- **HTTPS** is handled by the host in front of the API (load balancer or reverse proxy). Do not expose port 3000 directly.
- **Secrets**: JWT_SECRET and the database passwords must come from a secrets store in production. The dev passwords in this repo are for local use only.
- **Rate limiting is per server process.** With more than one server, move it to Redis.
- **Access tokens cannot be revoked before they expire** (15 minutes). The live account check covers locked and removed accounts; a stolen token for an active account works until it expires.
- **No one-time-code (OTP) sign-in for customers yet.** Needs an SMS or WhatsApp provider; this is a club decision.
- **No email or phone verification, no password reset flow.**
- **Database backups and point-in-time recovery**, and a restore drill.
- **Dependency scanning** (npm audit in CI) and an independent penetration test before the public launch.
- **Personal data**: the erase job for deleted accounts (30-day grace) is not built yet.
