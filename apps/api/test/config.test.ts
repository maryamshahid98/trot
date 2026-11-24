// Configuration rules. No database needed: every test passes its own environment to the loader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadAdminConfig, loadConfig } from '../src/config/env.ts';

const good = {
  DATABASE_URL: 'postgres://app:pw@db.example.invalid:5432/trot',
  JWT_SECRET: 'x'.repeat(40),
};
const withEnv = (extra: Record<string, string | undefined> = {}) => ({ ...good, ...extra }) as NodeJS.ProcessEnv;
const messageOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConfigError, 'a bad setting must raise a ConfigError, not a crash');
    return e.message;
  }
  assert.fail('expected the configuration to be refused');
};

test('a minimal environment works and every tunable gets its documented default', () => {
  const c = loadConfig(withEnv());
  assert.equal(c.port, 3000);
  assert.equal(c.rateLimit.authMax, 20);
  assert.equal(c.rateLimit.windowMs, 60_000);
  assert.equal(c.auth.accessTtlSeconds, 900);
  assert.equal(c.auth.refreshTtlDays, 14);
  assert.equal(c.auth.cookieSecure, false, 'plain http works in development');
  assert.equal(c.auth.maxFailedLogins, 5);
  assert.equal(c.auth.lockoutMinutes, 15);
  assert.deepEqual(c.http.corsOrigins, [], 'no browser site is allowed unless it is listed');
});

test('secrets and connection URLs have no default: missing ones are all named in one message', () => {
  const m = messageOf(() => loadConfig({} as NodeJS.ProcessEnv));
  assert.match(m, /DATABASE_URL/);
  assert.match(m, /JWT_SECRET/);
  assert.match(m, /\.env/);
});

test('a short or blank JWT secret is refused, so a forgotten secret can never fall back to a known one', () => {
  assert.match(messageOf(() => loadConfig(withEnv({ JWT_SECRET: 'short' }))), /JWT_SECRET.*32/);
  assert.match(messageOf(() => loadConfig(withEnv({ JWT_SECRET: '' }))), /JWT_SECRET/);
  assert.match(messageOf(() => loadConfig(withEnv({ JWT_SECRET: undefined }))), /JWT_SECRET/);
});

test('the database URL must be a postgres URL', () => {
  assert.match(messageOf(() => loadConfig(withEnv({ DATABASE_URL: 'http://example.invalid' }))), /DATABASE_URL/);
});

test('a number that is not a number stops the start, instead of switching a protection off', () => {
  // Before: AUTH_RATE_LIMIT=abc became NaN, and "count > NaN" is never true, so the rate limit silently disappeared.
  assert.match(messageOf(() => loadConfig(withEnv({ AUTH_RATE_LIMIT: 'abc' }))), /AUTH_RATE_LIMIT/);
  assert.match(messageOf(() => loadConfig(withEnv({ PORT: 'abc' }))), /PORT/);
  assert.match(messageOf(() => loadConfig(withEnv({ TRUST_PROXY: 'true' }))), /TRUST_PROXY/);
});

test('numbers out of range are refused', () => {
  assert.match(messageOf(() => loadConfig(withEnv({ AUTH_RATE_LIMIT: '0' }))), /AUTH_RATE_LIMIT/);
  assert.match(messageOf(() => loadConfig(withEnv({ PORT: '70000' }))), /PORT/);
  assert.match(messageOf(() => loadConfig(withEnv({ MAX_FAILED_LOGINS: '-1' }))), /MAX_FAILED_LOGINS/);
  assert.match(messageOf(() => loadConfig(withEnv({ ACCESS_TOKEN_TTL_SECONDS: '1.5' }))), /ACCESS_TOKEN_TTL_SECONDS/);
});

test('a blank line in .env means "use the default", not 0 or NaN', () => {
  // Before: AUTH_RATE_LIMIT= became 0, which blocked every sign-in; PORT= became 0, a random port.
  const c = loadConfig(withEnv({ AUTH_RATE_LIMIT: '', PORT: '  ', DB_POOL_MAX: '' }));
  assert.equal(c.rateLimit.authMax, 20);
  assert.equal(c.port, 3000);
  assert.equal(c.db.poolMax, 10);
});

test('values that are set are used', () => {
  const c = loadConfig(withEnv({
    PORT: '8080', AUTH_RATE_LIMIT: '5', RATE_LIMIT_WINDOW_SECONDS: '30', TRUST_PROXY: '2',
    CORS_ORIGINS: ' https://a.example.invalid , https://b.example.invalid ,', DB_SSL: 'true', COOKIE_SECURE: 'true', JWT_ISSUER: 'me', JWT_AUDIENCE: 'you',
  }));
  assert.equal(c.port, 8080);
  assert.equal(c.rateLimit.authMax, 5);
  assert.equal(c.rateLimit.windowMs, 30_000);
  assert.equal(c.http.trustProxy, 2);
  assert.deepEqual(c.http.corsOrigins, ['https://a.example.invalid', 'https://b.example.invalid']);
  assert.equal(c.db.ssl, true);
  assert.equal(c.auth.cookieSecure, true);
  assert.equal(c.auth.issuer, 'me');
  assert.equal(c.auth.audience, 'you');
});

test('script settings: the admin URL is required, and the test database may never be the development database', () => {
  const dev = 'postgres://trot:trot@localhost:5432/trot';
  assert.match(messageOf(() => loadAdminConfig('dev', {} as NodeJS.ProcessEnv)), /ADMIN_DATABASE_URL/);
  assert.match(messageOf(() => loadAdminConfig('test', { ADMIN_DATABASE_URL: dev } as NodeJS.ProcessEnv)), /TEST_ADMIN_DATABASE_URL/);
  assert.match(messageOf(() => loadAdminConfig('test', { ADMIN_DATABASE_URL: dev, TEST_ADMIN_DATABASE_URL: dev } as NodeJS.ProcessEnv)), /different database/);
  // The test database is dropped on every run, so only a name ending in _test is accepted.
  assert.match(messageOf(() => loadAdminConfig('test', { ADMIN_DATABASE_URL: dev, TEST_ADMIN_DATABASE_URL: 'postgres://trot:trot@localhost:5432/important' } as NodeJS.ProcessEnv)), /ends in "_test"/);
  const ok = loadAdminConfig('test', { ADMIN_DATABASE_URL: dev, TEST_ADMIN_DATABASE_URL: 'postgres://trot:trot@localhost:5432/trot_test' } as NodeJS.ProcessEnv);
  assert.equal(ok.databaseUrl.endsWith('/trot_test'), true);
  assert.equal(ok.serverUrl, dev);
});

test('script settings: NODE_ENV=production is what makes the seed refuse to run', () => {
  const base = { ADMIN_DATABASE_URL: 'postgres://trot:trot@localhost:5432/trot' };
  assert.equal(loadAdminConfig('dev', { ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv).isProduction, true);
  assert.equal(loadAdminConfig('dev', base as NodeJS.ProcessEnv).isProduction, false);
  assert.match(messageOf(() => loadAdminConfig('dev', { ...base, NODE_ENV: 'staging' } as NodeJS.ProcessEnv)), /NODE_ENV/);
});

test('script settings: short seed and role passwords are refused', () => {
  const base = { ADMIN_DATABASE_URL: 'postgres://trot:trot@localhost:5432/trot' };
  assert.match(messageOf(() => loadAdminConfig('dev', { ...base, SEED_PASSWORD: 'short' } as NodeJS.ProcessEnv)), /SEED_PASSWORD/);
  assert.match(messageOf(() => loadAdminConfig('dev', { ...base, APP_DB_PASSWORD: 'short' } as NodeJS.ProcessEnv)), /APP_DB_PASSWORD/);
  assert.equal(loadAdminConfig('dev', { ...base, SEED_PASSWORD: '' } as NodeJS.ProcessEnv).seedPassword, undefined);
});

test('uploaded documents go to ./data/uploads with a 5 MB limit unless told otherwise, and bad limits stop the start', () => {
  const c = loadConfig(withEnv());
  assert.equal(c.uploads.dir, './data/uploads');
  assert.equal(c.uploads.maxBytes, 5_242_880);
  const custom = loadConfig(withEnv({ UPLOAD_DIR: '/data/uploads', UPLOAD_MAX_BYTES: '1048576' }));
  assert.deepEqual(custom.uploads, { dir: '/data/uploads', maxBytes: 1_048_576 });
  assert.match(messageOf(() => loadConfig(withEnv({ UPLOAD_MAX_BYTES: 'big' }))), /UPLOAD_MAX_BYTES/);
  assert.match(messageOf(() => loadConfig(withEnv({ UPLOAD_MAX_BYTES: '0' }))), /UPLOAD_MAX_BYTES/);
  assert.match(messageOf(() => loadConfig(withEnv({ UPLOAD_MAX_BYTES: '99999999999' }))), /UPLOAD_MAX_BYTES/);
  assert.equal(loadConfig(withEnv({ UPLOAD_DIR: '', UPLOAD_MAX_BYTES: '' })).uploads.maxBytes, 5_242_880, 'blank means the default');
});
