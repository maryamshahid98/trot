import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, BRANCH, ctx, login, makeAccount, makeBranch, PASSWORD, randomDay, startApp, stopApp } from './helpers.ts';
import { codes, HOUR, makeClass } from './booking-helpers.ts';
import { auditActions, customer, post, staff } from './flow-helpers.ts';
import type { Json } from './helpers.ts';

before(startApp);
after(stopApp);

const get = (path: string, token?: string) => api('GET', path, { token });
const patch = (path: string, token: string | undefined, body: unknown) => api('PATCH', path, { token, body });
const put = (path: string, token: string | undefined, body: unknown) => api('PUT', path, { token, body });
let n = 0;
const email = () => `new${Date.now()}${n++}@trot-test.invalid`;
const phone = () => `+9665${String(Date.now()).slice(-6)}${String(n++).padStart(2, '0')}`.slice(0, 14);
const NEW_PW = 'Fresh-pass-77';
const body = (o: Record<string, unknown> = {}) => ({ fullName: 'New Person', email: email(), role: 'coach', branchIds: [BRANCH], password: NEW_PW, ...o });
const row = async (id: string) => (await ctx.admin.query(`SELECT * FROM accounts WHERE id = $1`, [id])).rows[0];
const branchesOf = async (id: string): Promise<string[]> => (await ctx.admin.query(`SELECT branch_id FROM account_branches WHERE account_id = $1 ORDER BY 1`, [id])).rows.map((r) => r.branch_id);

describe('who may manage accounts', () => {
  test('no token is refused, and only managers and owners may use these routes', async () => {
    const target = await makeAccount({ role: 'coach' });
    for (const [method, path] of [['GET', '/accounts'], ['POST', '/accounts'], ['GET', `/accounts/${target.id}`], ['PATCH', `/accounts/${target.id}`], ['POST', `/accounts/${target.id}/role`], ['POST', `/accounts/${target.id}/status`], ['POST', `/accounts/${target.id}/unlock`], ['POST', `/accounts/${target.id}/reset-password`], ['PUT', `/accounts/${target.id}/branches`]] as const) {
      assert.equal((await api(method, path)).status, 401, `${method} ${path}`);
      for (const role of ['customer', 'coach', 'stable_hand', 'reception']) assert.equal((await api(method, path, { token: (await staff(role)).token, body: {} })).status, 403, `${role} ${method} ${path}`);
    }
  });
});

describe('creating accounts', () => {
  test('a manager creates a coach who can sign in at once; the password is never shown', async () => {
    const manager = await staff('manager');
    const b = body({ phone: phone() });
    const res = await post('/accounts', manager.token, b);
    assert.equal(res.status, 201);
    assert.equal((await login(b.email, NEW_PW)).status, 200);
    const got = await get(`/accounts/${res.body.id}`, manager.token);
    assert.equal(got.status, 200);
    assert.equal(got.body.role, 'coach');
    assert.deepEqual(got.body.branchIds, [BRANCH]);
    assert.ok(!JSON.stringify(got.body).toLowerCase().includes('password'));
    assert.ok((await auditActions(res.body.id)).includes('account.create'));
    const detail = (await ctx.admin.query(`SELECT detail::text AS d FROM audit_log WHERE entity_id = $1 AND action = 'account.create'`, [res.body.id])).rows[0].d;
    assert.ok(!detail.includes(NEW_PW));
  });

  test('nobody can give a role as high as their own; only an owner makes managers; owners cannot be made here', async () => {
    const manager = await staff('manager');
    const owner = await staff('owner');
    const asManager = await post('/accounts', manager.token, body({ role: 'manager' }));
    assert.equal(asManager.status, 403);
    assert.ok(codes(asManager).includes('ROLE_TOO_HIGH'));
    assert.equal((await post('/accounts', manager.token, body({ role: 'owner' }))).status, 400);
    assert.equal((await post('/accounts', owner.token, body({ role: 'owner' }))).status, 400);
    assert.equal((await post('/accounts', owner.token, body({ role: 'manager' }))).status, 201);
    assert.equal((await post('/accounts', manager.token, body({ role: 'customer' }))).status, 400);
  });

  test('email and phone must be new, whatever the capital letters', async () => {
    const manager = await staff('manager');
    const takenPhone = phone();
    const first = body({ phone: takenPhone });
    assert.equal((await post('/accounts', manager.token, first)).status, 201);
    const sameEmail = await post('/accounts', manager.token, body({ email: first.email.toUpperCase() }));
    assert.equal(sameEmail.status, 409);
    assert.ok(codes(sameEmail).includes('EMAIL_TAKEN'));
    const samePhone = await post('/accounts', manager.token, body({ phone: takenPhone }));
    assert.equal(samePhone.status, 409);
    assert.ok(codes(samePhone).includes('PHONE_TAKEN'));
  });

  test('branches must be ones the manager works in', async () => {
    const manager = await staff('manager');
    const foreign = await makeBranch();
    assert.equal((await post('/accounts', manager.token, body({ branchIds: [foreign] }))).status, 403);
    assert.equal((await post('/accounts', manager.token, body({ branchIds: [BRANCH, foreign] }))).status, 403);
  });

  test('bad input is refused with 400', async () => {
    const manager = await staff('manager');
    for (const bad of [
      {}, body({ password: 'short' }), body({ email: 'nope' }), body({ phone: 'abc' }), body({ phone: '123' }), body({ branchIds: [] }), body({ branchIds: [BRANCH, BRANCH] }),
      body({ branchIds: ['x'] }), body({ role: 'wizard' }), body({ fullName: '' }), body({ fullName: 'x'.repeat(500) }), body({ locale: 'fr' }), body({ password: 'x'.repeat(500) }),
    ]) assert.equal((await post('/accounts', manager.token, bad)).status, 400, JSON.stringify(bad).slice(0, 90));
  });
});

describe('seeing accounts', () => {
  test('a manager sees people in their branches only, and customers too', async () => {
    const other = await makeBranch();
    const manager = await staff('manager');
    const outsider = await makeAccount({ role: 'coach', branchIds: [other] });
    const mine = await makeAccount({ role: 'coach' });
    const cust = await customer();
    // Every test file adds people to this branch, so the whole list is far longer than one page. Find each person by their own email.
    const find = async (who: { email: string }) => {
      const res = await get(`/accounts?q=${encodeURIComponent(who.email)}`, manager.token);
      assert.equal(res.status, 200);
      return res.body.accounts.map((a: Json) => a.id) as string[];
    };
    assert.deepEqual(await find(mine), [mine.id]);
    assert.deepEqual(await find(cust), [cust.id]);
    assert.deepEqual(await find(outsider), []);
    assert.equal((await get(`/accounts/${outsider.id}`, manager.token)).status, 404);
    assert.equal((await get('/accounts/not-an-id', manager.token)).status, 400);
    assert.equal((await get(`/accounts/00000000-0000-0000-0000-00000000dead`, manager.token)).status, 404);
  });

  test('filters, search, paging; % is a letter; a branch you do not work in is refused', async () => {
    const manager = await staff('manager');
    const tag = `Zz${Date.now()}`;
    for (const role of ['coach', 'reception']) {
      const id: string = (await ctx.admin.query(`INSERT INTO accounts (role, full_name, email) VALUES ($1,$2,$3) RETURNING id`, [role, `${tag} ${role}`, email()])).rows[0].id;
      await ctx.admin.query(`INSERT INTO account_branches (account_id, branch_id) VALUES ($1,$2)`, [id, BRANCH]);
    }
    const byName = await get(`/accounts?q=${tag}`, manager.token);
    assert.equal(byName.body.total, 2);
    assert.equal((await get(`/accounts?q=${tag}&role=coach`, manager.token)).body.total, 1);
    const page = await get(`/accounts?q=${tag}&limit=1&offset=1`, manager.token);
    assert.equal(page.body.accounts.length, 1);
    assert.equal(page.body.total, 2);
    assert.equal((await get('/accounts?q=%25', manager.token)).body.total, 0);
    assert.equal((await get(`/accounts?branchId=${await makeBranch()}`, manager.token)).status, 403);
    for (const bad of ['role=wizard', 'status=zzz', 'limit=0', 'limit=9999', 'offset=-1', 'limit=abc']) assert.equal((await get(`/accounts?${bad}`, manager.token)).status, 400, bad);
  });
});

describe('editing accounts', () => {
  test('a manager edits contact details of a coach; empty change and taken email are refused', async () => {
    const manager = await staff('manager');
    const coach = await makeAccount({ role: 'coach' });
    const other = await makeAccount({ role: 'coach' });
    const res = await patch(`/accounts/${coach.id}`, manager.token, { fullName: 'Renamed', phone: '+966500000123', locale: 'ar' });
    assert.equal(res.status, 200);
    assert.equal(res.body.fullName, 'Renamed');
    assert.equal(res.body.locale, 'ar');
    assert.equal((await patch(`/accounts/${coach.id}`, manager.token, {})).status, 400);
    assert.equal((await patch(`/accounts/${coach.id}`, manager.token, { email: other.email.toUpperCase() })).status, 409);
    assert.equal((await patch(`/accounts/${coach.id}`, manager.token, { phone: null })).status, 200);
    assert.equal((await row(coach.id)).phone, null);
  });

  test('a manager cannot edit another manager or an owner, but can edit themselves', async () => {
    const manager = await staff('manager');
    const peer = await staff('manager');
    const owner = await staff('owner');
    assert.equal((await patch(`/accounts/${peer.id}`, manager.token, { fullName: 'X' })).status, 403);
    assert.equal((await patch(`/accounts/${owner.id}`, manager.token, { fullName: 'X' })).status, 403);
    assert.equal((await patch(`/accounts/${manager.id}`, manager.token, { fullName: 'Me' })).status, 200);
    assert.equal((await patch(`/accounts/${peer.id}`, owner.token, { fullName: 'By owner' })).status, 200);
  });

  test('another branch cannot edit this person', async () => {
    const coach = await makeAccount({ role: 'coach' });
    const outsider = await staff('manager', [await makeBranch()]);
    assert.equal((await patch(`/accounts/${coach.id}`, outsider.token, { fullName: 'X' })).status, 404);
  });
});

describe('role changes', () => {
  test('a manager changes a coach to reception; same role, self, peers and customers are refused', async () => {
    const manager = await staff('manager');
    const coach = await makeAccount({ role: 'coach', branchIds: [BRANCH] });
    const res = await post(`/accounts/${coach.id}/role`, manager.token, { role: 'reception', reason: 'Moved to the desk' });
    assert.equal(res.status, 201);
    assert.equal((await row(coach.id)).role, 'reception');
    assert.equal((await post(`/accounts/${coach.id}/role`, manager.token, { role: 'reception' })).status, 409);
    const self = await post(`/accounts/${manager.id}/role`, manager.token, { role: 'coach' });
    assert.equal(self.status, 403);
    assert.ok(codes(self).includes('CANNOT_ACT_ON_SELF'));
    const peer = await staff('manager');
    assert.equal((await post(`/accounts/${peer.id}/role`, manager.token, { role: 'coach' })).status, 403);
    assert.equal((await post(`/accounts/${coach.id}/role`, manager.token, { role: 'manager' })).status, 403);
    assert.equal((await post(`/accounts/${coach.id}/role`, manager.token, { role: 'owner' })).status, 400);
    const cust = await customer();
    const c = await post(`/accounts/${cust.id}/role`, manager.token, { role: 'coach' });
    assert.equal(c.status, 422);
    assert.ok(codes(c).includes('NOT_STAFF'));
    assert.deepEqual((await auditActions(coach.id)).filter((a) => a === 'account.role'), ['account.role']);
  });

  test('an owner can promote a coach to manager; a coach with classes ahead cannot change role', async () => {
    const owner = await staff('owner');
    const manager = await staff('manager');
    const coach = await makeAccount({ role: 'coach' });
    await makeClass({ startsAt: randomDay() + 8 * HOUR, coachId: coach.id });
    const blocked = await post(`/accounts/${coach.id}/role`, manager.token, { role: 'reception' });
    assert.equal(blocked.status, 409);
    assert.ok(codes(blocked).includes('COACH_HAS_CLASSES'));
    const free = await makeAccount({ role: 'coach' });
    assert.equal((await post(`/accounts/${free.id}/role`, owner.token, { role: 'manager' })).status, 201);
  });

  test('a role change applies on the very next request', async () => {
    const manager = await staff('manager');
    const target = await staff('reception');
    assert.equal((await get('/accounts', target.token)).status, 403);
    assert.equal((await post(`/accounts/${target.id}/role`, (await staff('owner')).token, { role: 'manager' })).status, 201);
    assert.equal((await get('/accounts', target.token)).status, 200);
    void manager;
  });
});

describe('locking, unlocking and passwords', () => {
  test('locking needs a reason, ends every sign-in at once, and unlocking restores it', async () => {
    const manager = await staff('manager');
    const coach = await makeAccount({ role: 'coach' });
    const session = await login(coach.email);
    assert.equal(session.status, 200);
    const token = session.body.accessToken;
    assert.equal((await get('/branches', token)).status, 200);
    assert.equal((await post(`/accounts/${coach.id}/status`, manager.token, { status: 'locked' })).status, 400);
    assert.equal((await post(`/accounts/${coach.id}/status`, manager.token, { status: 'locked', reason: 'Left the club' })).status, 201);
    assert.equal((await get('/branches', token)).status, 401);
    assert.equal((await login(coach.email)).status, 401);
    assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: session.body.refreshToken } })).status, 401);
    assert.equal((await post(`/accounts/${coach.id}/status`, manager.token, { status: 'locked', reason: 'again' })).status, 409);
    assert.equal((await post(`/accounts/${coach.id}/status`, manager.token, { status: 'active' })).status, 201);
    assert.equal((await login(coach.email)).status, 200);
    assert.equal((await post(`/accounts/${coach.id}/status`, manager.token, { status: 'deleted', reason: 'x' })).status, 400);
    assert.deepEqual((await auditActions(coach.id)).filter((a) => a === 'account.status'), ['account.status', 'account.status']);
  });

  test('you cannot lock yourself, a peer or an owner; a manager can lock a customer', async () => {
    const manager = await staff('manager');
    const peer = await staff('manager');
    const owner = await staff('owner');
    for (const id of [manager.id, peer.id, owner.id]) assert.equal((await post(`/accounts/${id}/status`, manager.token, { status: 'locked', reason: 'x' })).status, 403);
    const cust = await customer();
    assert.equal((await post(`/accounts/${cust.id}/status`, manager.token, { status: 'locked', reason: 'Abuse of staff' })).status, 201);
    assert.equal((await get('/bookings/mine', cust.token)).status, 401);
  });

  test('the short lockout after wrong passwords can be lifted by a manager', async () => {
    const manager = await staff('manager');
    const coach = await makeAccount({ role: 'coach' });
    await ctx.admin.query(`UPDATE accounts SET failed_logins = 3, locked_until = now() + interval '30 minutes' WHERE id = $1`, [coach.id]);
    assert.equal((await login(coach.email)).status, 401);
    assert.equal((await post(`/accounts/${coach.id}/unlock`, manager.token)).status, 201);
    assert.equal((await login(coach.email)).status, 200);
    assert.equal((await post(`/accounts/${manager.id}/unlock`, manager.token)).status, 403);
  });

  test('a manager resets a staff password: the old one stops working and old sign-ins end', async () => {
    const manager = await staff('manager');
    const coach = await makeAccount({ role: 'coach' });
    const session = await login(coach.email);
    const res = await post(`/accounts/${coach.id}/reset-password`, manager.token, { newPassword: NEW_PW });
    assert.equal(res.status, 201);
    assert.equal((await login(coach.email, PASSWORD)).status, 401);
    assert.equal((await login(coach.email, NEW_PW)).status, 200);
    assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: session.body.refreshToken } })).status, 401);
    const log = (await ctx.admin.query(`SELECT detail::text AS d FROM audit_log WHERE entity_id = $1 AND action = 'account.password_reset'`, [coach.id])).rows[0].d;
    assert.ok(!log.includes(NEW_PW));
    assert.equal((await post(`/accounts/${coach.id}/reset-password`, manager.token, { newPassword: 'short' })).status, 400);
    assert.equal((await post(`/accounts/${manager.id}/reset-password`, manager.token, { newPassword: NEW_PW })).status, 403);
    assert.equal((await post(`/accounts/${(await customer()).id}/reset-password`, manager.token, { newPassword: NEW_PW })).status, 422);
    assert.equal((await post(`/accounts/${(await staff('manager')).id}/reset-password`, manager.token, { newPassword: NEW_PW })).status, 403);
  });
});

describe('branch membership', () => {
  test('a manager changes only their own branches; branches they do not manage are left alone', async () => {
    const b2 = await makeBranch();
    const b3 = await makeBranch();
    const manager = await staff('manager', [BRANCH, b2]);
    const coach = await makeAccount({ role: 'coach', branchIds: [BRANCH, b3] });
    const res = await put(`/accounts/${coach.id}/branches`, manager.token, { branchIds: [b2] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.branchIds, [b2]);
    assert.deepEqual((await branchesOf(coach.id)).sort(), [b2, b3].sort());
    assert.equal((await put(`/accounts/${coach.id}/branches`, manager.token, { branchIds: [b2, BRANCH] })).status, 200);
    assert.equal((await put(`/accounts/${coach.id}/branches`, manager.token, { branchIds: [await makeBranch()] })).status, 403);
    for (const bad of [{ branchIds: [] }, {}, { branchIds: ['x'] }]) assert.equal((await put(`/accounts/${coach.id}/branches`, manager.token, bad)).status, 400);
    assert.equal((await put(`/accounts/${manager.id}/branches`, manager.token, { branchIds: [BRANCH] })).status, 403);
    assert.equal((await put(`/accounts/${(await customer()).id}/branches`, manager.token, { branchIds: [BRANCH] })).status, 422);
  });

  test('a coach with classes ahead cannot be removed from that branch', async () => {
    const b2 = await makeBranch();
    const manager = await staff('manager', [BRANCH, b2]);
    const coach = await makeAccount({ role: 'coach', branchIds: [BRANCH, b2] });
    await makeClass({ startsAt: randomDay() + 8 * HOUR, coachId: coach.id });
    const res = await put(`/accounts/${coach.id}/branches`, manager.token, { branchIds: [b2] });
    assert.equal(res.status, 409);
    assert.ok(codes(res).includes('COACH_HAS_CLASSES'));
    assert.deepEqual((await branchesOf(coach.id)).sort(), [BRANCH, b2].sort());
  });

  test('a person who is already invisible to you cannot be touched', async () => {
    const outsider = await makeAccount({ role: 'coach', branchIds: [await makeBranch()] });
    const manager = await staff('manager');
    assert.equal((await put(`/accounts/${outsider.id}/branches`, manager.token, { branchIds: [BRANCH] })).status, 404);
    assert.deepEqual(await branchesOf(outsider.id).then((a) => a.includes(BRANCH)), false);
  });
});
