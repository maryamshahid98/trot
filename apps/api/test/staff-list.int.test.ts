import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, BRANCH, makeAccount, makeBranch, startApp, stopApp } from './helpers.ts';
import { customer, staff } from './flow-helpers.ts';

before(startApp);
after(stopApp);
const get = (path: string, token?: string) => api('GET', path, { token });

describe('staff list for pickers', () => {
  test('no token is 401, customer and coach are 403', async () => {
    assert.equal((await get('/staff')).status, 401);
    assert.equal((await get('/staff', (await customer()).token)).status, 403);
    assert.equal((await get('/staff', (await staff('coach')).token)).status, 403);
  });

  test('reception sees active coaches of their own branch only, with names and roles', async () => {
    const reception = await staff('reception');
    const coach = await staff('coach');
    const other = await makeBranch();
    const away = await makeAccount({ role: 'coach', branchIds: [other] });
    const locked = await makeAccount({ role: 'coach', branchIds: [BRANCH], status: 'locked' });
    const res = await get('/staff?role=coach', reception.token);
    assert.equal(res.status, 200);
    const ids = res.body.staff.map((s: any) => s.id);
    assert.ok(ids.includes(coach.id));
    assert.ok(!ids.includes(away.id), 'a coach from another branch is hidden');
    assert.ok(!ids.includes(locked.id), 'a locked account is hidden');
    assert.ok(res.body.staff.every((s: any) => s.role === 'coach'));
    assert.deepEqual(Object.keys(res.body.staff[0]).sort(), ['fullName', 'id', 'role']);
  });

  test('the role filter works, a bad role is 400, and another branch is refused', async () => {
    const manager = await staff('manager');
    const all = await get('/staff', manager.token);
    assert.equal(all.status, 200);
    assert.ok(all.body.staff.every((s: any) => s.role !== 'customer'));
    assert.equal((await get('/staff?role=customer', manager.token)).status, 400);
    assert.equal((await get('/staff?role=wizard', manager.token)).status, 400);
    const other = await makeBranch();
    assert.equal((await get(`/staff?branchId=${other}`, manager.token)).status, 403);
  });
});
