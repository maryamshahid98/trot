// Sign-in and session security, against the real API and database.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import type { Json } from './helpers.ts';
import { api, appConfig, ctx, login, resetRateLimits, makeAccount, PASSWORD, startApp, stopApp, tokenFor } from './helpers.ts';

before(startApp);
after(stopApp);

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET!);
const nowS = () => Math.floor(Date.now() / 1000);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

// ---------- sign in ----------
test('login works with email and returns tokens and the user, never a password hash', async () => {
  const a = await makeAccount({ role: 'manager' });
  const r = await login(a.email);
  assert.equal(r.status, 200);
  assert.ok(r.body.accessToken && r.body.refreshToken);
  assert.equal(r.body.user.role, 'manager');
  assert.equal(r.body.user.branchIds.length, 1);
  assert.ok(!r.text.includes('scrypt$'), 'the password hash must never be returned');
});

test('login works with a phone number, and email is not case sensitive', async () => {
  const phone = `+9665${Math.floor(10000000 + Math.random() * 89999999)}`;
  const a = await makeAccount({ role: 'customer', phone });
  assert.equal((await login(phone)).status, 200);
  assert.equal((await login(a.email.toUpperCase())).status, 200);
});

test('wrong password, unknown account and a locked account all get the same answer', async () => {
  const a = await makeAccount({ role: 'coach' });
  const locked = await makeAccount({ role: 'coach', status: 'locked' });
  const wrong = await login(a.email, 'Wrong-password-1');
  const unknown = await login('nobody-here@trot-test.invalid');
  const lockedLogin = await login(locked.email);
  for (const r of [wrong, unknown, lockedLogin]) {
    assert.equal(r.status, 401);
    assert.equal(r.body.message, 'Invalid credentials.');
  }
});

test('an account with no password set cannot sign in', async () => {
  const a = await makeAccount({ role: 'customer', password: null });
  assert.equal((await login(a.email, '')).status, 400);
  assert.equal((await login(a.email, 'anything-at-all-1')).status, 401);
});

test('bad input is a 400, not a crash: missing fields, huge password, wrong types', async () => {
  assert.equal((await api('POST', '/auth/login', { body: {} })).status, 400);
  assert.equal((await api('POST', '/auth/login', { body: { identifier: 'a@b.invalid', password: 'x'.repeat(5000) } })).status, 400);
  assert.equal((await api('POST', '/auth/login', { body: { identifier: 123, password: ['a'] } })).status, 400);
  assert.equal((await api('POST', '/auth/login', { body: null as Json })).status, 400);
});

test('SQL-injection style input is just a failed login', async () => {
  const r = await login(`' OR 1=1 --`, `' OR '1'='1`);
  assert.equal(r.status, 401);
});

test('five wrong passwords lock the account; the right password is refused while locked; it works again after the lock ends', async () => {
  const a = await makeAccount({ role: 'reception' });
  for (let i = 0; i < 5; i++) assert.equal((await login(a.email, 'Wrong-password-1')).status, 401);
  assert.equal((await login(a.email)).status, 401, 'correct password must be refused while locked');
  await ctx.admin.query(`UPDATE accounts SET locked_until = now() - interval '1 minute' WHERE id = $1`, [a.id]);
  assert.equal((await login(a.email)).status, 200);
  const row = (await ctx.admin.query(`SELECT failed_logins, locked_until FROM accounts WHERE id = $1`, [a.id])).rows[0];
  assert.equal(row.failed_logins, 0);
  assert.equal(row.locked_until, null);
});

test('four wrong passwords then the right one does not lock, and the count resets', async () => {
  const a = await makeAccount({ role: 'reception' });
  for (let i = 0; i < 4; i++) await login(a.email, 'Wrong-password-1');
  assert.equal((await login(a.email)).status, 200);
  assert.equal((await ctx.admin.query(`SELECT failed_logins FROM accounts WHERE id = $1`, [a.id])).rows[0].failed_logins, 0);
});

test('failures and sign-ins are written to the audit log', async () => {
  const a = await makeAccount({ role: 'owner' });
  await login(a.email, 'Wrong-password-1');
  await login(a.email);
  const r = await ctx.admin.query(`SELECT action FROM audit_log WHERE actor_account_id = $1 ORDER BY id`, [a.id]);
  assert.deepEqual(r.rows.map((x) => x.action), ['auth.login_failed', 'auth.login']);
});

test('sign-in routes are rate limited per address', async () => {
  const original = appConfig().rateLimit.authMax;
  appConfig().rateLimit.authMax = 3;
  await resetRateLimits();
  try {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await login('nobody@trot-test.invalid')).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  } finally {
    appConfig().rateLimit.authMax = original;
    await resetRateLimits();
  }
});

test('every route has a general per-address limit, and the health check is exempt', async () => {
  const original = appConfig().rateLimit.generalMax;
  appConfig().rateLimit.generalMax = 3;
  await resetRateLimits();
  try {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await api('GET', '/auth/me')).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    assert.equal((await api('GET', '/health')).status, 200, 'the load balancer must never be rate limited');
  } finally {
    appConfig().rateLimit.generalMax = original;
    await resetRateLimits();
  }
});

test('the limit is kept in the database, so a second server sees the same count', async () => {
  const original = appConfig().rateLimit.authMax;
  appConfig().rateLimit.authMax = 2;
  await resetRateLimits();
  try {
    await login('nobody@trot-test.invalid');
    await login('nobody@trot-test.invalid');
    // Another API server would add to the same row. Simulate it by adding the third hit straight in the table.
    await ctx.admin.query(`UPDATE rate_limits SET hits = hits + 1 WHERE key LIKE '%auth|%'`);
    assert.equal((await login('nobody@trot-test.invalid')).status, 429);
  } finally {
    appConfig().rateLimit.authMax = original;
    await resetRateLimits();
  }
});

// ---------- tokens ----------
test('routes that need sign-in refuse missing, malformed and garbage tokens', async () => {
  assert.equal((await api('GET', '/auth/me')).status, 401);
  assert.equal((await api('GET', '/auth/me', { headers: { authorization: 'Token abc' } })).status, 401);
  assert.equal((await api('GET', '/auth/me', { headers: { authorization: 'Bearer ' } })).status, 401);
  assert.equal((await api('GET', '/auth/me', { token: 'not.a.jwt' })).status, 401);
  assert.equal((await api('GET', '/auth/me', { token: 'x'.repeat(5000) })).status, 401);
});

test('a valid token shows who I am and my branches', async () => {
  const a = await makeAccount({ role: 'manager' });
  const r = await api('GET', '/auth/me', { token: await tokenFor(a) });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, a.id);
  assert.equal(r.body.role, 'manager');
  assert.equal(r.body.branchIds.length, 1);
});

test('forged tokens are refused: wrong key, "alg none", expired, wrong audience, wrong issuer, not an id', async () => {
  const a = await makeAccount({ role: 'owner' });
  const good = () => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(a.id).setIssuer('trot').setAudience('trot-api').setIssuedAt().setExpirationTime('10m');

  assert.equal((await api('GET', '/auth/me', { token: await good().sign(secret()) })).status, 200, 'control: a correctly built token is accepted');
  assert.equal((await api('GET', '/auth/me', { token: await good().sign(new TextEncoder().encode('x'.repeat(40))) })).status, 401, 'wrong key');
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: a.id, iss: 'trot', aud: 'trot-api', exp: nowS() + 600 })}.`;
  assert.equal((await api('GET', '/auth/me', { token: none })).status, 401, 'alg none');
  const expired = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(a.id).setIssuer('trot').setAudience('trot-api').setIssuedAt(nowS() - 3600).setExpirationTime(nowS() - 60).sign(secret());
  assert.equal((await api('GET', '/auth/me', { token: expired })).status, 401, 'expired');
  const aud = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(a.id).setIssuer('trot').setAudience('someone-else').setExpirationTime('10m').sign(secret());
  assert.equal((await api('GET', '/auth/me', { token: aud })).status, 401, 'wrong audience');
  const iss = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(a.id).setIssuer('evil').setAudience('trot-api').setExpirationTime('10m').sign(secret());
  assert.equal((await api('GET', '/auth/me', { token: iss })).status, 401, 'wrong issuer');
  const notId = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(`1' OR '1'='1`).setIssuer('trot').setAudience('trot-api').setExpirationTime('10m').sign(secret());
  assert.equal((await api('GET', '/auth/me', { token: notId })).status, 401, 'subject is not an id');
  // Change a character in the middle of the signature. The last character of a base64 value carries unused bits, so changing
  // only that one can leave the decoded signature identical and the token still valid (a flaky test, 1 run in 16).
  const [head, payload, sig] = (await good().sign(secret())).split('.');
  const tampered = [head, payload, sig.slice(0, 10) + (sig[10] === 'A' ? 'B' : 'A') + sig.slice(11)].join('.');
  assert.equal((await api('GET', '/auth/me', { token: tampered })).status, 401, 'tampered signature');
});

test('a token for an account that is locked afterwards stops working at once', async () => {
  const a = await makeAccount({ role: 'coach' });
  const t = await tokenFor(a);
  assert.equal((await api('GET', '/auth/me', { token: t })).status, 200);
  await ctx.admin.query(`UPDATE accounts SET status = 'locked' WHERE id = $1`, [a.id]);
  assert.equal((await api('GET', '/auth/me', { token: t })).status, 401);
});

test('a role change applies on the next request, without signing in again', async () => {
  const a = await makeAccount({ role: 'customer' });
  const t = await tokenFor(a);
  assert.equal((await api('GET', '/auth/me', { token: t })).body.role, 'customer');
  await ctx.admin.query(`UPDATE accounts SET role = 'manager' WHERE id = $1`, [a.id]);
  assert.equal((await api('GET', '/auth/me', { token: t })).body.role, 'manager');
});

// ---------- refresh and logout ----------
test('refresh gives a new pair; the old refresh token then stops working and cancels the whole sign-in', async () => {
  const a = await makeAccount({ role: 'coach' });
  const r1 = (await login(a.email)).body.refreshToken;
  const rot = await api('POST', '/auth/refresh', { body: { refreshToken: r1 } });
  assert.equal(rot.status, 200);
  assert.ok(rot.body.accessToken && rot.body.refreshToken && rot.body.refreshToken !== r1);
  assert.equal((await api('GET', '/auth/me', { token: rot.body.accessToken })).status, 200);

  const reuse = await api('POST', '/auth/refresh', { body: { refreshToken: r1 } });
  assert.equal(reuse.status, 401, 'a used refresh token must not work again');
  const afterTheft = await api('POST', '/auth/refresh', { body: { refreshToken: rot.body.refreshToken } });
  assert.equal(afterTheft.status, 401, 'reuse must cancel the newer token of the same sign-in too');
  const log = await ctx.admin.query(`SELECT 1 FROM audit_log WHERE actor_account_id = $1 AND action = 'auth.refresh_reuse_detected'`, [a.id]);
  assert.equal(log.rowCount, 1);
});

test('refresh refuses garbage, unknown, expired and malformed tokens', async () => {
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: 'a'.repeat(43) } })).status, 401);
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: 'short' } })).status, 400);
  assert.equal((await api('POST', '/auth/refresh', { body: {} })).status, 400);
  const a = await makeAccount({ role: 'coach' });
  const r = (await login(a.email)).body.refreshToken;
  await ctx.admin.query(`UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE account_id = $1`, [a.id]);
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: r } })).status, 401);
});

test('refresh is refused once the account is locked', async () => {
  const a = await makeAccount({ role: 'coach' });
  const r = (await login(a.email)).body.refreshToken;
  await ctx.admin.query(`UPDATE accounts SET status = 'locked' WHERE id = $1`, [a.id]);
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: r } })).status, 401);
});

test('two refreshes at the same moment: exactly one wins', async () => {
  const a = await makeAccount({ role: 'coach' });
  const r = (await login(a.email)).body.refreshToken;
  const [x, y] = await Promise.all([
    api('POST', '/auth/refresh', { body: { refreshToken: r } }),
    api('POST', '/auth/refresh', { body: { refreshToken: r } }),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 401]);
});

test('logout ends the sign-in, and answers the same for an unknown token', async () => {
  const a = await makeAccount({ role: 'coach' });
  const r = (await login(a.email)).body.refreshToken;
  assert.equal((await api('POST', '/auth/logout', { body: { refreshToken: r } })).status, 200);
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: r } })).status, 401);
  assert.equal((await api('POST', '/auth/logout', { body: { refreshToken: 'z'.repeat(43) } })).status, 200);
});

test('refresh tokens are stored only as hashes', async () => {
  const a = await makeAccount({ role: 'coach' });
  const r = (await login(a.email)).body.refreshToken;
  const rows = await ctx.admin.query(`SELECT token_hash FROM refresh_tokens WHERE account_id = $1`, [a.id]);
  assert.equal(rows.rowCount, 1);
  assert.notEqual(rows.rows[0].token_hash, r);
  assert.match(rows.rows[0].token_hash, /^[0-9a-f]{64}$/);
});

// ---------- change password ----------
test('change password: wrong current, weak new, same as old, and then success signs out other devices', async () => {
  const a = await makeAccount({ role: 'manager' });
  const t = await tokenFor(a);
  const otherDevice = (await login(a.email)).body.refreshToken;
  const change = (body: object) => api('POST', '/auth/change-password', { token: t, body });

  assert.equal((await api('POST', '/auth/change-password', { body: { currentPassword: PASSWORD, newPassword: 'New-password-123' } })).status, 401, 'needs sign-in');
  assert.equal((await change({ currentPassword: 'Wrong-password-1', newPassword: 'New-password-123' })).status, 400);
  assert.equal((await change({ currentPassword: PASSWORD, newPassword: 'short' })).status, 400);
  assert.equal((await change({ currentPassword: PASSWORD, newPassword: 'x'.repeat(200) })).status, 400);
  assert.equal((await change({ currentPassword: PASSWORD, newPassword: PASSWORD })).status, 400);

  assert.equal((await change({ currentPassword: PASSWORD, newPassword: 'New-password-123' })).status, 200);
  assert.equal((await login(a.email, PASSWORD)).status, 401, 'old password no longer works');
  assert.equal((await login(a.email, 'New-password-123')).status, 200);
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: otherDevice } })).status, 401, 'other devices are signed out');
});

// ---------- general hardening ----------
test('malformed JSON is a 400 and an oversized body is a 413, with no stack trace or file path', async () => {
  const bad = await api('POST', '/auth/login', { rawBody: '{"identifier":' });
  assert.equal(bad.status, 400);
  const big = await api('POST', '/auth/login', { rawBody: JSON.stringify({ identifier: 'a@b.invalid', password: 'x'.repeat(200_000) }) });
  assert.equal(big.status, 413);
  for (const r of [bad, big]) {
    assert.ok(r.body.requestId, 'errors carry a request id');
    assert.doesNotMatch(r.text, /node_modules|\.ts:|at \w+ \(/, 'no stack or file path in an error response');
  }
});

test('responses carry security headers, hide the framework and echo a request id', async () => {
  const r = await api('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(r.headers.get('strict-transport-security'));
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.ok(r.headers.get('x-request-id'));
});

test('CORS: a listed site is allowed, an unlisted site is not', async () => {
  const ok = await api('GET', '/health', { headers: { origin: 'http://localhost:5173' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const evil = await api('GET', '/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('CORS preflight: every method and header the website really uses is allowed, for a listed site only', async () => {
  // A browser asks permission BEFORE sending a request that is not "simple". Tools like curl never ask, so this is only caught here.
  const ask = (origin: string, method: string, headers: string) =>
    api('OPTIONS', '/documents/x/file', { headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': headers } });
  for (const [method, headers] of [
    ['GET', 'authorization,x-trot-client'], ['POST', 'authorization,content-type,x-trot-client'], ['PATCH', 'authorization,content-type'], ['DELETE', 'authorization'],
    ['PUT', 'authorization,content-type,x-trot-client'], // assessments, notification preferences, account branches
    ['PUT', 'authorization,content-type,x-file-name,x-trot-client'], // a document file upload
  ] as const) {
    const r = await ask('http://localhost:5173', method, headers);
    assert.ok(r.status === 204 || r.status === 200, `${method} ${headers}: ${r.status}`);
    assert.ok((r.headers.get('access-control-allow-methods') ?? '').split(',').map((s) => s.trim()).includes(method), `${method} is allowed`);
    const allowed = (r.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',').map((s) => s.trim());
    for (const h of headers.split(',')) assert.ok(allowed.includes(h), `${h} is allowed`);
    assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
  }
  const evil = await ask('https://evil.example', 'PUT', 'authorization,x-file-name');
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'an unlisted site gets nothing');
  assert.equal(evil.headers.get('access-control-allow-credentials'), null);
});

test('unknown routes are a clean 404 and the health route is open', async () => {
  assert.equal((await api('GET', '/does-not-exist', { token: await tokenFor(await makeAccount({ role: 'owner' })) })).status, 404);
  assert.equal((await api('GET', '/health')).status, 200);
});

// ---------- the website's refresh token lives in a cookie scripts cannot read ----------
const WEB = { 'x-trot-client': 'web' };
const setCookie = (r: { headers: Headers }) => r.headers.get('set-cookie') ?? '';
const cookieToken = (r: { headers: Headers }) => /trot_refresh=([^;]*)/.exec(setCookie(r))?.[1];
const webLogin = (email: string) => api('POST', '/auth/login', { body: { identifier: email, password: PASSWORD }, headers: WEB });
const webRefresh = (token?: string, body?: unknown) =>
  api('POST', '/auth/refresh', { body: body ?? {}, headers: { ...WEB, ...(token ? { cookie: `trot_refresh=${token}` } : {}) } });

test('web login: the refresh token is a locked-down cookie and is not in the response body', async () => {
  const a = await makeAccount({ role: 'manager' });
  const r = await webLogin(a.email);
  assert.equal(r.status, 200);
  assert.ok(r.body.accessToken && r.body.user, 'the access token and user still come in the body');
  assert.equal(r.body.refreshToken, undefined, 'the refresh token must not be readable by page scripts');
  assert.ok(!r.text.includes(cookieToken(r)!), 'the token appears nowhere in the body');
  const c = setCookie(r);
  assert.match(c, /HttpOnly/i);
  assert.match(c, /SameSite=Strict/i);
  assert.match(c, /Path=\/auth(;|$)/i);
  assert.match(c, /Max-Age=\d+/i);
  assert.doesNotMatch(c, /;\s*Secure/i, 'plain http in development, so no Secure flag unless COOKIE_SECURE is on');
});

test('web login adds the Secure flag when COOKIE_SECURE is on', async () => {
  const a = await makeAccount({ role: 'manager' });
  const cfg = appConfig();
  const before = cfg.auth.cookieSecure;
  cfg.auth.cookieSecure = true;
  try {
    assert.match(setCookie(await webLogin(a.email)), /;\s*Secure/i);
  } finally {
    cfg.auth.cookieSecure = before;
  }
});

test('the apps that are not websites still get the refresh token in the body and no cookie', async () => {
  const a = await makeAccount({ role: 'coach' });
  const r = await login(a.email);
  assert.ok(r.body.refreshToken);
  assert.equal(setCookie(r), '');
});

test('web refresh uses the cookie, rotates it, and each cookie works once', async () => {
  const a = await makeAccount({ role: 'reception' });
  const first = cookieToken(await webLogin(a.email))!;
  const r = await webRefresh(first);
  assert.equal(r.status, 200);
  assert.ok(r.body.accessToken);
  assert.equal(r.body.refreshToken, undefined);
  const second = cookieToken(r);
  assert.ok(second && second !== first, 'a new cookie replaces the old one');
  const reuse = await webRefresh(first);
  assert.equal(reuse.status, 401, 'the old cookie is dead');
  assert.match(setCookie(reuse), /trot_refresh=;/, 'and the browser is told to drop it');
  assert.equal((await webRefresh(second)).status, 401, 'reuse cancelled the whole sign-in, like before');
});

test('web refresh ignores a token in the body, and fails cleanly with no cookie or a bad cookie', async () => {
  const a = await makeAccount({ role: 'reception' });
  const login1 = await login(a.email);
  assert.equal((await webRefresh(undefined, { refreshToken: login1.body.refreshToken })).status, 401, 'a body token is never used by the website route');
  assert.equal((await webRefresh()).status, 401);
  assert.equal((await webRefresh('short')).status, 401);
  assert.equal((await webRefresh('a'.repeat(43))).status, 401);
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: login1.body.refreshToken } })).status, 200, 'the app route is unchanged');
});

test('a cookie sent without the website header is not used (a page on another site cannot add that header)', async () => {
  const a = await makeAccount({ role: 'reception' });
  const token = cookieToken(await webLogin(a.email))!;
  const r = await api('POST', '/auth/refresh', { body: {}, headers: { cookie: `trot_refresh=${token}` } });
  assert.equal(r.status, 400, 'a non-website call must send the token in the body');
});

test('web logout clears the cookie, ends the sign-in, and always answers the same', async () => {
  const a = await makeAccount({ role: 'owner' });
  const token = cookieToken(await webLogin(a.email))!;
  const out = await api('POST', '/auth/logout', { body: {}, headers: { ...WEB, cookie: `trot_refresh=${token}` } });
  assert.equal(out.status, 200);
  assert.match(setCookie(out), /trot_refresh=;/);
  assert.equal((await webRefresh(token)).status, 401);
  const none = await api('POST', '/auth/logout', { body: {}, headers: WEB });
  assert.equal(none.status, 200, 'logging out with no cookie is fine');
});

test('CORS lets a listed site send cookies and the website header, and still refuses unlisted sites', async () => {
  const pre = await api('OPTIONS', '/auth/refresh', {
    headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-trot-client' },
  });
  assert.ok(pre.status < 300);
  assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /x-trot-client/i);
  const evil = await api('OPTIONS', '/auth/refresh', {
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-trot-client' },
  });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal(evil.headers.get('access-control-allow-credentials'), null);
});
