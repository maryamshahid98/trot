// The one place that reads process.env. Everything else gets a typed, validated AppConfig.
//
// Rules:
//  - Secrets and connection URLs have NO default. If they are missing the API refuses to start, and says which ones.
//  - Tunable values (ports, lifetimes, limits) have a documented default, so only changes need to be written down.
//  - A blank line in .env counts as "not set", so it uses the default instead of silently becoming 0 or NaN.
//  - A value that is not a number, or is out of range, stops the start. It never quietly turns a protection off.
import { z } from 'zod';
import { TEST_DATABASE_SUFFIX } from './constants.ts';

export const APP_CONFIG = 'APP_CONFIG';

export class ConfigError extends Error {}

const blankIsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const int = (min: number, max: number, fallback: number) =>
  z.preprocess(blankIsUnset, z.coerce.number().int().min(min).max(max).default(fallback));
const flag = (fallback: boolean) =>
  z.preprocess(blankIsUnset, z.enum(['true', 'false']).default(fallback ? 'true' : 'false').transform((v) => v === 'true'));
const text = (fallback: string) => z.preprocess(blankIsUnset, z.string().min(1).default(fallback));
const optionalText = (min: number) => z.preprocess(blankIsUnset, z.string().min(min, `must be at least ${min} characters`).optional());
const postgresUrl = z
  .string({ error: (i) => (i.input === undefined ? 'is required' : undefined) })
  .refine((s) => /^postgres(ql)?:\/\/.+/.test(s), 'must be a postgres:// connection URL');

const RuntimeEnv = z.object({
  PORT: int(1, 65535, 3000),

  DATABASE_URL: postgresUrl,
  DB_POOL_MAX: int(1, 200, 10),
  DB_IDLE_TIMEOUT_MS: int(1_000, 3_600_000, 30_000),
  DB_STATEMENT_TIMEOUT_MS: int(100, 600_000, 15_000), // a query that runs longer than this is cancelled
  DB_SSL: flag(false),
  COOKIE_SECURE: flag(false), // set to true wherever the site runs on https (always in production): the cookie then never travels over plain http

  JWT_SECRET: z
    .string({ error: (i) => (i.input === undefined ? 'is required' : undefined) })
    .min(32, 'must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'),
  JWT_ISSUER: text('trot'),
  JWT_AUDIENCE: text('trot-api'),
  ACCESS_TOKEN_TTL_SECONDS: int(60, 86_400, 15 * 60),
  REFRESH_TOKEN_TTL_DAYS: int(1, 365, 14),

  MAX_FAILED_LOGINS: int(1, 100, 5),
  LOCKOUT_MINUTES: int(1, 1_440, 15),
  AUTH_RATE_LIMIT: int(1, 100_000, 20), // sign-in requests allowed per address per window
  RATE_LIMIT_WINDOW_SECONDS: int(1, 3_600, 60),

  // Websites allowed to call the API from a browser, comma separated. Empty = no browser site is allowed.
  CORS_ORIGINS: z.preprocess(blankIsUnset, z.string().default('')),
  TRUST_PROXY: int(0, 10, 0), // number of reverse proxies in front of the API; 0 = none
  HSTS_MAX_AGE_SECONDS: int(0, 63_072_000, 15_552_000),

  // How often the background job runs: it releases unpaid holds, passes on unanswered waitlist offers and expires old packages. 0 = off.
  JOBS_INTERVAL_SECONDS: int(0, 86_400, 60),
});

export interface AppConfig {
  port: number;
  db: { url: string; poolMax: number; idleTimeoutMs: number; statementTimeoutMs: number; ssl: boolean };
  auth: {
    jwtSecret: string;
    issuer: string;
    audience: string;
    accessTtlSeconds: number;
    refreshTtlDays: number;
    cookieSecure: boolean;
    maxFailedLogins: number;
    lockoutMinutes: number;
  };
  rateLimit: { authMax: number; windowMs: number };
  http: { corsOrigins: string[]; trustProxy: number; hstsMaxAgeSeconds: number };
  jobs: { intervalSeconds: number };
}

function fail(what: string, error: z.ZodError): never {
  const lines = error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new ConfigError(`Invalid ${what}:\n${lines.join('\n')}\nSet these in the .env file at the project root (see .env.example).`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const r = RuntimeEnv.safeParse(env);
  if (!r.success) fail('configuration', r.error);
  const e = r.data;
  return {
    port: e.PORT,
    db: { url: e.DATABASE_URL, poolMax: e.DB_POOL_MAX, idleTimeoutMs: e.DB_IDLE_TIMEOUT_MS, statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS, ssl: e.DB_SSL },
    auth: {
      jwtSecret: e.JWT_SECRET,
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
      accessTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
      cookieSecure: e.COOKIE_SECURE,
      maxFailedLogins: e.MAX_FAILED_LOGINS,
      lockoutMinutes: e.LOCKOUT_MINUTES,
    },
    rateLimit: { authMax: e.AUTH_RATE_LIMIT, windowMs: e.RATE_LIMIT_WINDOW_SECONDS * 1_000 },
    http: {
      corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
      trustProxy: e.TRUST_PROXY,
      hstsMaxAgeSeconds: e.HSTS_MAX_AGE_SECONDS,
    },
    jobs: { intervalSeconds: e.JOBS_INTERVAL_SECONDS },
  };
}

// ---------- settings for the migration and seed scripts (they connect as the superuser) ----------

const AdminEnv = z.object({
  NODE_ENV: z.preprocess(blankIsUnset, z.enum(['development', 'test', 'production']).default('development')),
  ADMIN_DATABASE_URL: postgresUrl,
  TEST_ADMIN_DATABASE_URL: z.preprocess(blankIsUnset, postgresUrl.optional()),
  APP_DB_PASSWORD: optionalText(8), // password for the limited trot_app role. Set it in development; in production set it by hand.
  SEED_PASSWORD: optionalText(10), // password given to the demo accounts by db:seed
});

export interface AdminConfig {
  /** True when NODE_ENV=production. The seed refuses to run then. */
  isProduction: boolean;
  /** The database the script works on. */
  databaseUrl: string;
  /** A connection to the server's main database, used to drop and create the test database. */
  serverUrl: string;
  appDbPassword?: string;
  seedPassword?: string;
}

export const databaseName = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));

export function loadAdminConfig(target: 'dev' | 'test', env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const r = AdminEnv.safeParse(env);
  if (!r.success) fail('script configuration', r.error);
  const e = r.data;
  let databaseUrl = e.ADMIN_DATABASE_URL;
  if (target === 'test') {
    if (!e.TEST_ADMIN_DATABASE_URL) throw new ConfigError('Invalid script configuration:\n  - TEST_ADMIN_DATABASE_URL: is required to set up the test database\nSet it in the .env file at the project root (see .env.example).');
    const testName = databaseName(e.TEST_ADMIN_DATABASE_URL);
    if (testName === databaseName(e.ADMIN_DATABASE_URL)) {
      throw new ConfigError('TEST_ADMIN_DATABASE_URL must point at a different database than ADMIN_DATABASE_URL. The tests must never run on your development data.');
    }
    if (!testName.endsWith(TEST_DATABASE_SUFFIX)) {
      throw new ConfigError(`TEST_ADMIN_DATABASE_URL must name a database that ends in "${TEST_DATABASE_SUFFIX}", because it is dropped and rebuilt on every test run. Got "${testName}".`);
    }
    databaseUrl = e.TEST_ADMIN_DATABASE_URL;
  }
  return {
    isProduction: e.NODE_ENV === 'production',
    databaseUrl,
    serverUrl: e.ADMIN_DATABASE_URL,
    appDbPassword: e.APP_DB_PASSWORD,
    seedPassword: e.SEED_PASSWORD,
  };
}
