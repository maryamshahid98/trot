// What hosting the API as a function relies on: the scheduled job over HTTP, the sign-in cookie under /api, and the address rewrite.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ctx, PASSWORD, startApp, stopApp, makeAccount } from './helpers.ts';
import { restorePath } from '../../../api/_path.mjs';

process.env.CRON_SECRET = 'scheduler-secret-for-tests';
process.env.PUBLIC_API_PATH = '/api';
before(startApp);
after(stopApp);

test('the scheduled job runs only for the scheduler', async () => {
  const get = (authorization?: string) => fetch(`${ctx.base}/internal/jobs`, { headers: authorization ? { authorization } : {} });
  for (const wrong of [undefined, 'Bearer nope', 'scheduler-secret-for-tests']) assert.equal((await get(wrong)).status, 401, String(wrong));
  const staff = await api('GET', '/internal/jobs', { token: 'anything' });
  assert.equal(staff.status, 401);
  const r = await get('Bearer scheduler-secret-for-tests');
  assert.equal(r.status, 200);
  const body = (await r.json()) as { branches?: number; skipped?: string };
  assert.ok((body.branches ?? 0) >= 1 || body.skipped === 'already running', JSON.stringify(body));
});

test('under /api the sign-in cookie is limited to the sign-in addresses the browser sees', async () => {
  const a = await makeAccount({ role: 'reception' });
  const r = await fetch(`${ctx.base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-trot-client': 'web' }, body: JSON.stringify({ identifier: a.email, password: PASSWORD }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const cookie = r.headers.get('set-cookie') ?? '';
  assert.match(cookie, /Path=\/api\/auth;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('the function gives the API the address it knows', () => {
  assert.equal(restorePath('/api/auth/login'), '/auth/login');
  assert.equal(restorePath('/api/index?__path=auth/login'), '/auth/login');
  assert.equal(restorePath('/api/index?__path=riders&branchId=1&q=a%20b'), '/riders?branchId=1&q=a+b');
  assert.equal(restorePath('/api/riders?branchId=1&__path=riders'), '/riders?branchId=1');
  assert.equal(restorePath('/api'), '/');
  assert.equal(restorePath('/apis/x'), '/apis/x');
});
