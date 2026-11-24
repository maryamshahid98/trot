// Two-step sign-in: set-up, the second step, codes that cannot be reused or guessed, recovery codes, the club's policy, and admin reset.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { api, appConfig, ctx, makeAccount, makeBranch, PASSWORD, startApp, stopApp, tokenFor } from './helpers.ts';
import { auditActions } from './flow-helpers.ts';
import { base32Decode, codeAt, stepAt } from '../src/auth/totp.ts';

before(startApp);
after(stopApp);

const key = () => new TextEncoder().encode(process.env.JWT_SECRET);
/** The code an authenticator app would show for this secret, `ahead` 30-second steps from now. */
const codeFor = (secret: string, ahead = 0) => codeAt(base32Decode(secret), stepAt(Date.now()) + ahead);
const wrongCode = (secret: string) => {
  const good = new Set([-2, -1, 0, 1, 2].map((d) => codeFor(secret, d)));
  for (let n = 0; n < 1_000_000; n++) { const c = String(n).padStart(6, '0'); if (!good.has(c)) return c; }
  throw new Error('unreachable');
};

async function person(role = 'coach', branchIds?: string[]) {
  const acct = await makeAccount({ role, ...(branchIds ? { branchIds } : {}) });
  return { ...acct, token: await tokenFor(acct) };
}
/** An account with two-step sign-in switched on. */
async function protectedPerson(role = 'coach') {
  const p = await person(role);
  const setup = await api('POST', '/auth/mfa/setup', { token: p.token, body: {} });
  assert.equal(setup.status, 200, setup.text);
  const enabled = await api('POST', '/auth/mfa/enable', { token: p.token, body: { code: codeFor(setup.body.secret) } });
  assert.equal(enabled.status, 200, enabled.text);
  // The code that confirmed set-up counts as used, exactly as it should. A real person signs in minutes later with a newer code, so move
  // the "last used" mark back to stand in for that time passing. (The tests about reuse then use real, current codes.)
  await ctx.admin.query(`UPDATE account_mfa SET last_step = $2 WHERE account_id = $1`, [p.id, stepAt(Date.now()) - 10]);
  return { ...p, secret: setup.body.secret as string, recoveryCodes: enabled.body.recoveryCodes as string[] };
}
const signIn = (email: string, password = PASSWORD, headers: Record<string, string> = {}) => api('POST', '/auth/login', { body: { identifier: email, password }, headers });
const verify = (body: unknown, headers: Record<string, string> = {}) => api('POST', '/auth/mfa/verify', { body, headers });
const secondStep = async (p: { email: string; secret: string }, ahead = 0) => {
  const first = await signIn(p.email);
  assert.equal(first.body.mfaRequired, true, first.text);
  return verify({ mfaToken: first.body.mfaToken, code: codeFor(p.secret, ahead) });
};
const failures = async (id: string) => (await ctx.admin.query(`SELECT failed_logins, locked_until FROM accounts WHERE id = $1`, [id])).rows[0];

describe('setting it up', () => {
  test('set-up gives a secret and a scannable address; nothing is protected until a right code confirms it', async () => {
    const p = await person();
    assert.deepEqual((await api('GET', '/auth/mfa', { token: p.token })).body, { enabled: false, setupStarted: false, required: false, recoveryCodesLeft: 0 });
    const setup = await api('POST', '/auth/mfa/setup', { token: p.token, body: {} });
    assert.equal(setup.status, 200, setup.text);
    assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\/Trot:.+\?secret=.+&issuer=Trot&algorithm=SHA1&digits=6&period=30$/);
    assert.equal((await api('GET', '/auth/mfa', { token: p.token })).body.setupStarted, true);
    assert.equal((await signIn(p.email)).body.mfaRequired, undefined, 'a started set-up does not change signing in');
    const bad = await api('POST', '/auth/mfa/enable', { token: p.token, body: { code: wrongCode(setup.body.secret) } });
    assert.equal(bad.status, 400, bad.text);
    assert.equal((await api('GET', '/auth/mfa', { token: p.token })).body.enabled, false);
  });

  test('the right code turns it on and shows 10 recovery codes once; the secret is stored encrypted', async () => {
    const p = await person();
    const setup = await api('POST', '/auth/mfa/setup', { token: p.token, body: {} });
    const on = await api('POST', '/auth/mfa/enable', { token: p.token, body: { code: codeFor(setup.body.secret) } });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.body.recoveryCodes.length, 10);
    for (const c of on.body.recoveryCodes) assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    assert.deepEqual((await api('GET', '/auth/mfa', { token: p.token })).body, { enabled: true, setupStarted: false, required: false, recoveryCodesLeft: 10 });
    const stored = (await ctx.admin.query(`SELECT secret_enc FROM account_mfa WHERE account_id = $1`, [p.id])).rows[0].secret_enc as string;
    assert.ok(stored.startsWith('v1:') && !stored.includes(setup.body.secret), 'not the plain secret');
    const codes = (await ctx.admin.query(`SELECT code_hash FROM mfa_recovery_codes WHERE account_id = $1`, [p.id])).rows.map((r) => r.code_hash);
    assert.equal(codes.length, 10);
    assert.ok(!codes.includes(on.body.recoveryCodes[0]), 'only hashes are kept');
    assert.ok((await auditActions(p.id)).includes('auth.mfa_enabled'));
    assert.equal((await api('POST', '/auth/mfa/enable', { token: p.token, body: { code: codeFor(setup.body.secret, 1) } })).status, 409, 'already on');
    assert.equal((await api('POST', '/auth/mfa/setup', { token: p.token, body: {} })).status, 409, 'cannot start again while on');
  });

  test('starting set-up again before confirming replaces the secret, so an old QR code stops working', async () => {
    const p = await person();
    const first = await api('POST', '/auth/mfa/setup', { token: p.token, body: {} });
    const second = await api('POST', '/auth/mfa/setup', { token: p.token, body: {} });
    assert.notEqual(first.body.secret, second.body.secret);
    assert.equal((await api('POST', '/auth/mfa/enable', { token: p.token, body: { code: codeFor(first.body.secret) } })).status, 400);
    assert.equal((await api('POST', '/auth/mfa/enable', { token: p.token, body: { code: codeFor(second.body.secret) } })).status, 200);
  });

  test('enabling without starting is a conflict; anyone (even a customer) can switch it on; nobody signed in cannot', async () => {
    const p = await person('customer');
    assert.equal((await api('POST', '/auth/mfa/enable', { token: p.token, body: { code: '123456' } })).status, 409);
    const on = await protectedPerson('customer');
    assert.equal(on.recoveryCodes.length, 10);
    for (const [method, path] of [['GET', '/auth/mfa'], ['POST', '/auth/mfa/setup'], ['POST', '/auth/mfa/enable'], ['POST', '/auth/mfa/disable'], ['POST', '/auth/mfa/recovery-codes']] as const) {
      assert.equal((await api(method, path, { body: {} })).status, 401, `${method} ${path}`);
    }
  });
});

describe('signing in with the second step', () => {
  test('after the password, signing in answers with a short-lived token and NO session; the right code finishes it', async () => {
    const p = await protectedPerson();
    const first = await signIn(p.email);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.mfaRequired, true);
    assert.equal(first.body.accessToken, undefined, 'no access token yet');
    assert.equal(first.body.refreshToken, undefined, 'no refresh token yet');
    assert.equal(first.body.expiresIn, 300);
    const done = await verify({ mfaToken: first.body.mfaToken, code: codeFor(p.secret) });
    assert.equal(done.status, 200, done.text);
    assert.ok(done.body.accessToken && done.body.refreshToken);
    assert.equal(done.body.user.id, p.id);
    assert.equal((await api('GET', '/auth/me', { token: done.body.accessToken })).body.mfaEnabled, true);
  });

  test('the sign-in token cannot be used as an access token, and an access token cannot stand in for the code', async () => {
    const p = await protectedPerson();
    const first = await signIn(p.email);
    assert.equal((await api('GET', '/auth/me', { token: first.body.mfaToken })).status, 401, 'a sign-in token is not an access token');
    assert.equal((await verify({ mfaToken: p.token, code: codeFor(p.secret) })).status, 401, 'an access token is not a sign-in token');
  });

  test('forged, expired and wrong-key sign-in tokens are refused, and so is a token for an account that is locked or gone', async () => {
    const p = await protectedPerson();
    const build = (o: { key?: Uint8Array; aud?: string; exp?: string | number; sub?: string; typ?: string } = {}) =>
      new SignJWT({ typ: o.typ ?? 'mfa' }).setProtectedHeader({ alg: 'HS256' }).setSubject(o.sub ?? p.id).setIssuer('trot').setAudience(o.aud ?? 'trot-api:mfa').setIssuedAt().setExpirationTime(o.exp ?? '5m').sign(o.key ?? key());
    const good = await build();
    assert.equal((await verify({ mfaToken: good, code: codeFor(p.secret, 2) })).status, 401, 'control: a wrong code with a good token is simply refused');
    const bad = [
      ['wrong key', await build({ key: new TextEncoder().encode('x'.repeat(40)) })],
      ['wrong audience (an access token\'s)', await build({ aud: 'trot-api' })],
      ['expired', await new SignJWT({ typ: 'mfa' }).setProtectedHeader({ alg: 'HS256' }).setSubject(p.id).setIssuer('trot').setAudience('trot-api:mfa').setIssuedAt(Math.floor(Date.now() / 1000) - 3600).setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(key())],
      ['not a sign-in token by its type', await build({ typ: 'other' })],
      ['not an id', await build({ sub: `1' OR '1'='1` })],
      ['garbage', 'a'.repeat(100)],
    ] as const;
    for (const [why, mfaToken] of bad) assert.equal((await verify({ mfaToken, code: codeFor(p.secret) })).status, 401, why);
    await ctx.admin.query(`UPDATE accounts SET status = 'locked' WHERE id = $1`, [p.id]);
    assert.equal((await verify({ mfaToken: good, code: codeFor(p.secret) })).status, 401, 'an account locked after the password step');
  });

  test('a code can be used only once: the same code again is refused, the next one works', async () => {
    const p = await protectedPerson();
    const code = codeFor(p.secret);
    const first = await signIn(p.email);
    assert.equal((await verify({ mfaToken: first.body.mfaToken, code })).status, 200);
    const again = await signIn(p.email);
    const replay = await verify({ mfaToken: again.body.mfaToken, code });
    assert.equal(replay.status, 401, 'a seen code is worthless');
    assert.equal(replay.body.message, 'Invalid code.');
    assert.equal((await verify({ mfaToken: again.body.mfaToken, code: codeFor(p.secret, 1) })).status, 200, 'the next code');
    const old = await signIn(p.email);
    assert.equal((await verify({ mfaToken: old.body.mfaToken, code: codeFor(p.secret, -1) })).status, 401, 'an older code than one already used');
  });

  test('two requests with the same code at the same moment: exactly one gets in', async () => {
    const p = await protectedPerson();
    const code = codeFor(p.secret);
    const tokens = await Promise.all([signIn(p.email), signIn(p.email), signIn(p.email)]);
    const results = await Promise.all(tokens.map((t) => verify({ mfaToken: t.body.mfaToken, code })));
    assert.equal(results.filter((r) => r.status === 200).length, 1, results.map((r) => r.status).join());
  });

  test('wrong codes count against the account like wrong passwords, and enough of them lock it even for the right code', async () => {
    const p = await protectedPerson();
    const max = appConfig().auth.maxFailedLogins;
    const first = await signIn(p.email);
    for (let i = 0; i < max; i++) {
      const r = await verify({ mfaToken: first.body.mfaToken, code: wrongCode(p.secret) });
      assert.equal(r.status, 401);
      assert.equal(r.body.message, 'Invalid code.');
    }
    assert.ok((await failures(p.id)).locked_until, 'locked');
    assert.equal((await verify({ mfaToken: first.body.mfaToken, code: codeFor(p.secret) })).status, 401, 'the right code does not help once locked');
    assert.equal((await signIn(p.email)).status, 401, 'and neither does the password');
    const logged = (await ctx.admin.query(`SELECT detail FROM audit_log WHERE actor_account_id = $1 AND action = 'auth.login_failed'`, [p.id])).rows;
    assert.ok(logged.some((r) => r.detail.mfa === true), 'the failed codes are in the audit log');
  });

  test('a good second step clears earlier failures', async () => {
    const p = await protectedPerson();
    const first = await signIn(p.email);
    await verify({ mfaToken: first.body.mfaToken, code: wrongCode(p.secret) });
    assert.equal((await failures(p.id)).failed_logins, 1);
    assert.equal((await verify({ mfaToken: first.body.mfaToken, code: codeFor(p.secret) })).status, 200);
    assert.equal((await failures(p.id)).failed_logins, 0);
  });

  test('the website gets its refresh token as a cookie and never in the body, like an ordinary sign-in', async () => {
    const p = await protectedPerson();
    const first = await signIn(p.email, PASSWORD, { 'x-trot-client': 'web' });
    const done = await verify({ mfaToken: first.body.mfaToken, code: codeFor(p.secret) }, { 'x-trot-client': 'web' });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.refreshToken, undefined);
    assert.match(done.headers.get('set-cookie') ?? '', /trot_refresh=.+HttpOnly/i);
  });

  test('the request must carry exactly one of a code and a recovery code', async () => {
    const p = await protectedPerson();
    const { mfaToken } = (await signIn(p.email)).body;
    for (const body of [{ mfaToken }, { mfaToken, code: codeFor(p.secret), recoveryCode: p.recoveryCodes[0] }, { code: codeFor(p.secret) }, { mfaToken, code: '' }, {}]) {
      assert.equal((await verify(body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
  });
});

describe('recovery codes', () => {
  test('a recovery code signs in once, in any case and without the dash, and then is used up', async () => {
    const p = await protectedPerson();
    const code = p.recoveryCodes[0];
    const first = await signIn(p.email);
    const ok = await verify({ mfaToken: first.body.mfaToken, recoveryCode: code.toLowerCase().replace('-', ' ') });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await api('GET', '/auth/mfa', { token: ok.body.accessToken })).body.recoveryCodesLeft, 9);
    const again = await signIn(p.email);
    assert.equal((await verify({ mfaToken: again.body.mfaToken, recoveryCode: code })).status, 401, 'used up');
    assert.equal((await verify({ mfaToken: again.body.mfaToken, recoveryCode: 'AAAAA-BBBBB' })).status, 401, 'not a code of this account');
    assert.ok((await auditActions(p.id)).includes('auth.mfa_recovery_used'));
  });

  test('a recovery code of ANOTHER account does not work', async () => {
    const a = await protectedPerson();
    const b = await protectedPerson();
    const first = await signIn(b.email);
    assert.equal((await verify({ mfaToken: first.body.mfaToken, recoveryCode: a.recoveryCodes[0] })).status, 401);
  });

  test('new recovery codes need a current code, and the old ones stop working', async () => {
    const p = await protectedPerson();
    assert.equal((await api('POST', '/auth/mfa/recovery-codes', { token: p.token, body: { code: wrongCode(p.secret) } })).status, 400);
    const fresh = await api('POST', '/auth/mfa/recovery-codes', { token: p.token, body: { code: codeFor(p.secret, 1) } });
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal(fresh.body.recoveryCodes.length, 10);
    const first = await signIn(p.email);
    assert.equal((await verify({ mfaToken: first.body.mfaToken, recoveryCode: p.recoveryCodes[0] })).status, 401, 'an old code');
    assert.equal((await verify({ mfaToken: first.body.mfaToken, recoveryCode: fresh.body.recoveryCodes[0] })).status, 200, 'a new code');
    assert.ok((await auditActions(p.id)).includes('auth.mfa_codes_regenerated'));
  });
});

describe('turning it off', () => {
  test('needs the password and a current code, and then signing in is a single step again', async () => {
    const p = await protectedPerson();
    assert.equal((await api('POST', '/auth/mfa/disable', { token: p.token, body: { password: 'wrong-password-1', code: codeFor(p.secret, 1) } })).status, 400, 'wrong password');
    assert.equal((await api('POST', '/auth/mfa/disable', { token: p.token, body: { password: PASSWORD, code: wrongCode(p.secret) } })).status, 400, 'wrong code');
    assert.equal((await api('GET', '/auth/mfa', { token: p.token })).body.enabled, true, 'still on after two refusals');
    assert.equal((await api('POST', '/auth/mfa/disable', { token: p.token, body: { password: PASSWORD, code: codeFor(p.secret, 1) } })).status, 200);
    assert.deepEqual((await api('GET', '/auth/mfa', { token: p.token })).body, { enabled: false, setupStarted: false, required: false, recoveryCodesLeft: 0 });
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE account_id = $1`, [p.id])).rows[0].n, 0);
    const plain = await signIn(p.email);
    assert.ok(plain.body.accessToken && !plain.body.mfaRequired);
    assert.ok((await auditActions(p.id)).includes('auth.mfa_disabled'));
  });

  test('a recovery code can switch it off too (a lost phone)', async () => {
    const p = await protectedPerson();
    assert.equal((await api('POST', '/auth/mfa/disable', { token: p.token, body: { password: PASSWORD, code: p.recoveryCodes[3] } })).status, 200);
    assert.ok(!(await signIn(p.email)).body.mfaRequired);
  });
});

describe('the club\'s policy: roles that must use it', () => {
  const require = (roles: string[]) => { appConfig().auth.mfaRequiredRoles = roles; };
  after(() => require([]));

  test('a required role can sign in but do nothing except set it up; once it is set up everything works again', async () => {
    require(['manager']);
    try {
      const m = await person('manager');
      const me = await api('GET', '/auth/me', { token: m.token });
      assert.equal(me.status, 200);
      assert.deepEqual([me.body.mfaEnabled, me.body.mfaEnrollmentRequired], [false, true]);
      const blocked = await api('GET', '/branches', { token: m.token });
      assert.equal(blocked.status, 403, blocked.text);
      assert.equal(blocked.body.problems[0].code, 'MFA_ENROLLMENT_REQUIRED');
      assert.equal((await api('GET', '/auth/mfa', { token: m.token })).body.required, true);
      const setup = await api('POST', '/auth/mfa/setup', { token: m.token, body: {} });
      assert.equal(setup.status, 200, 'setting it up is allowed');
      assert.equal((await api('GET', '/branches', { token: m.token })).status, 403, 'still blocked until it is confirmed');
      assert.equal((await api('POST', '/auth/mfa/enable', { token: m.token, body: { code: codeFor(setup.body.secret) } })).status, 200);
      assert.equal((await api('GET', '/branches', { token: m.token })).status, 200, 'unblocked on the very next request, with the same token');
      const off = await api('POST', '/auth/mfa/disable', { token: m.token, body: { password: PASSWORD, code: codeFor(setup.body.secret, 1) } });
      assert.equal(off.status, 403, 'a required role cannot turn it off');
      assert.equal(off.body.problems[0].code, 'MFA_REQUIRED_FOR_ROLE');
    } finally { require([]); }
  });

  test('other roles are not affected, and ending the policy frees people at once', async () => {
    require(['manager']);
    try {
      const coach = await person('coach');
      assert.equal((await api('GET', '/branches', { token: coach.token })).status, 200);
      const m = await person('manager');
      assert.equal((await api('GET', '/branches', { token: m.token })).status, 403);
      require([]);
      assert.equal((await api('GET', '/branches', { token: m.token })).status, 200, 'the change applies on the next request');
    } finally { require([]); }
  });

  test('a role that is required and already protected signs in with two steps like anyone else', async () => {
    const m = await protectedPerson('manager');
    require(['manager']);
    try {
      const done = await secondStep(m);
      assert.equal(done.status, 200, done.text);
      assert.equal((await api('GET', '/branches', { token: done.body.accessToken })).status, 200);
    } finally { require([]); }
  });
});

describe('a manager can reset a colleague\'s two-step sign-in', () => {
  test('it is removed, their sessions end, it is audited, and signing in is a single step again', async () => {
    const coach = await protectedPerson('coach');
    const boss = await person('manager');
    const done = await secondStep(coach);
    assert.equal(done.status, 200);
    const reset = await api('POST', `/accounts/${coach.id}/mfa/reset`, { token: boss.token, body: {} });
    assert.equal(reset.status, 201, reset.text);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM account_mfa WHERE account_id = $1`, [coach.id])).rows[0].n, 0);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE account_id = $1`, [coach.id])).rows[0].n, 0);
    assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: done.body.refreshToken } })).status, 401, 'their sign-in ended');
    assert.ok(!(await signIn(coach.email)).body.mfaRequired);
    const logged = (await ctx.admin.query(`SELECT actor_account_id FROM audit_log WHERE entity_id = $1 AND action = 'auth.mfa_reset'`, [coach.id])).rows;
    assert.equal(logged.length, 1);
    assert.equal(logged[0].actor_account_id, boss.id);
  });

  test('only a manager or owner, never on someone of equal rank, themselves, a customer, or another branch', async () => {
    const coach = await protectedPerson('coach');
    assert.equal((await api('POST', `/accounts/${coach.id}/mfa/reset`, { body: {} })).status, 401);
    assert.equal((await api('POST', `/accounts/${coach.id}/mfa/reset`, { token: (await person('coach')).token, body: {} })).status, 403);
    assert.equal((await api('POST', `/accounts/${coach.id}/mfa/reset`, { token: (await person('reception')).token, body: {} })).status, 403);
    const m1 = await protectedPerson('manager');
    const m2 = await person('manager');
    assert.equal((await api('POST', `/accounts/${m1.id}/mfa/reset`, { token: m2.token, body: {} })).status, 403, 'an equal rank');
    assert.equal((await api('POST', `/accounts/${m2.id}/mfa/reset`, { token: m2.token, body: {} })).status, 403, 'yourself');
    assert.equal((await api('POST', `/accounts/${(await person('customer')).id}/mfa/reset`, { token: m2.token, body: {} })).status, 422, 'a customer');
    const elsewhere = await person('manager', [await makeBranch()]);
    assert.equal((await api('POST', `/accounts/${coach.id}/mfa/reset`, { token: elsewhere.token, body: {} })).status, 404, 'another branch');
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM account_mfa WHERE account_id = $1`, [coach.id])).rows[0].n, 1, 'none of those removed it');
    const owner = await person('owner');
    assert.equal((await api('POST', `/accounts/${m1.id}/mfa/reset`, { token: owner.token, body: {} })).status, 201, 'an owner can reset a manager');
  });
});

describe('what the sign-in answer reveals', () => {
  test('a wrong password is the same answer whether or not two-step sign-in is on, and a code is never asked for before the password is right', async () => {
    const withMfa = await protectedPerson();
    const without = await person();
    const a = await signIn(withMfa.email, 'definitely-wrong-1');
    const b = await signIn(without.email, 'definitely-wrong-1');
    assert.deepEqual([a.status, a.body.message], [401, 'Invalid credentials.']);
    assert.deepEqual([b.status, b.body.message], [401, 'Invalid credentials.']);
    assert.equal(a.body.mfaRequired, undefined, 'nothing about two-step sign-in leaks before the password is proven');
  });

  test('the sign-in routes are rate limited per address', async () => {
    const p = await protectedPerson();
    const original = appConfig().rateLimit.authMax;
    appConfig().rateLimit.authMax = 3;
    await ctx.admin.query(`DELETE FROM rate_limits WHERE key LIKE $1`, [`${process.env.RATE_LIMIT_KEY_PREFIX}%`]);
    try {
      const { mfaToken } = (await signIn(p.email)).body;
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await verify({ mfaToken, code: wrongCode(p.secret) })).status);
      assert.ok(codes.includes(429), codes.join());
    } finally {
      appConfig().rateLimit.authMax = original;
      await ctx.admin.query(`DELETE FROM rate_limits WHERE key LIKE $1`, [`${process.env.RATE_LIMIT_KEY_PREFIX}%`]);
    }
  });
});

