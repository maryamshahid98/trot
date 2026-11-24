import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, BRANCH, ctx, makeBranch, startApp, stopApp } from './helpers.ts';
import { codes, DAY, makeRider } from './booking-helpers.ts';
import { auditActions, customer, post, staff } from './flow-helpers.ts';

before(startApp);
after(stopApp);

const get = (path: string, token?: string) => api('GET', path, { token });
const enc = encodeURIComponent;
const when = (agoMs = 3_600_000) => new Date(Date.now() - agoMs).toISOString();
const body = (o: Record<string, unknown> = {}) => ({ severity: 'medium', kind: 'fall', description: 'Rider slipped while mounting and bruised an arm.', occurredAt: when(), ...o });
const statusIn = async (id: string): Promise<string> => (await ctx.admin.query(`SELECT status FROM incidents WHERE id = $1`, [id])).rows[0].status;
const horseIn = async (branchId = BRANCH): Promise<string> => (await ctx.admin.query(`INSERT INTO horses (branch_id, name) VALUES ($1,$2) RETURNING id`, [branchId, `H ${Date.now()}${Math.random()}`])).rows[0].id;

describe('reporting an incident', () => {
  test('no token and customers are refused; any staff member can report', async () => {
    assert.equal((await post('/incidents', undefined, body())).status, 401);
    assert.equal((await post('/incidents', (await customer()).token, body())).status, 403);
    for (const role of ['coach', 'stable_hand', 'reception', 'manager', 'owner']) assert.equal((await post('/incidents', (await staff(role)).token, body())).status, 201, role);
  });

  test('it is saved as open, linked to a rider and a horse, and audited without the story', async () => {
    const coach = await staff('coach');
    const riderId = await makeRider();
    const horseId = await horseIn();
    const res = await post('/incidents', coach.token, body({ riderId, horseId, severity: 'high', description: 'SECRET-DETAIL bruised arm' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'open');
    const got = await get(`/incidents/${res.body.id}`, coach.token);
    assert.equal(got.status, 200);
    assert.deepEqual([got.body.riderId, got.body.horseId, got.body.severity, got.body.status], [riderId, horseId, 'high', 'open']);
    assert.equal(got.body.reportedBy, coach.id);
    assert.deepEqual(await auditActions(res.body.id), ['incident.create']);
    const audit = (await ctx.admin.query(`SELECT detail::text AS d FROM audit_log WHERE entity_id = $1`, [res.body.id])).rows[0].d;
    assert.ok(!audit.includes('SECRET-DETAIL'), 'the story stays out of the audit trail');
  });

  test('bad input is refused with 400', async () => {
    const coach = await staff('coach');
    for (const bad of [
      {}, body({ severity: 'catastrophic' }), body({ kind: '' }), body({ description: '' }), body({ description: 'x'.repeat(5000) }), body({ occurredAt: 'yesterday' }),
      body({ riderId: 'x' }), body({ horseId: 'x' }), body({ kind: 'k'.repeat(300) }),
    ]) assert.equal((await post('/incidents', coach.token, bad)).status, 400, JSON.stringify(bad).slice(0, 70));
  });

  test('an incident cannot be in the future, but a minute of clock difference is tolerated', async () => {
    const coach = await staff('coach');
    const future = await post('/incidents', coach.token, body({ occurredAt: new Date(Date.now() + DAY).toISOString() }));
    assert.equal(future.status, 400);
    assert.ok(codes(future).includes('IN_THE_FUTURE'));
    assert.equal((await post('/incidents', coach.token, body({ occurredAt: new Date(Date.now() + 60_000).toISOString() }))).status, 201);
  });

  test('a rider or horse from another branch is refused', async () => {
    const coach = await staff('coach');
    const other = await makeBranch();
    const foreignRider = await makeRider({ branchId: other });
    const r = await post('/incidents', coach.token, body({ riderId: foreignRider }));
    assert.equal(r.status, 422);
    assert.ok(codes(r).includes('RIDER_NOT_IN_BRANCH'));
    const h = await post('/incidents', coach.token, body({ horseId: await horseIn(other) }));
    assert.equal(h.status, 422);
    assert.ok(codes(h).includes('HORSE_NOT_IN_BRANCH'));
    assert.equal((await post('/incidents', coach.token, body({ branchId: other }))).status, 403);
  });
});

describe('who can see which incidents', () => {
  test('staff see only what they reported; managers see the whole branch; other branches see nothing', async () => {
    const a = await staff('coach');
    const b = await staff('stable_hand');
    const manager = await staff('manager');
    const mine = (await post('/incidents', a.token, body())).body.id;
    const theirs = (await post('/incidents', b.token, body())).body.id;
    const listA = (await get('/incidents?limit=200', a.token)).body.incidents.map((i: any) => i.id);
    assert.ok(listA.includes(mine) && !listA.includes(theirs));
    assert.equal((await get(`/incidents/${theirs}`, a.token)).status, 404);
    assert.equal((await get(`/incidents/${theirs}/history`, a.token)).status, 404);
    const listM = (await get('/incidents?limit=200', manager.token)).body.incidents.map((i: any) => i.id);
    assert.ok(listM.includes(mine) && listM.includes(theirs));
    const outsider = await staff('manager', [await makeBranch()]);
    assert.equal((await get(`/incidents/${mine}`, outsider.token)).status, 404);
    assert.ok(!(await get('/incidents?limit=200', outsider.token)).body.incidents.some((i: any) => i.id === mine));
    assert.equal((await get(`/incidents/${mine}`)).status, 401);
    assert.equal((await get(`/incidents/${mine}`, (await customer()).token)).status, 403);
    assert.equal((await get('/incidents/not-an-id', manager.token)).status, 400);
  });

  test('filters and paging', async () => {
    const branch = await makeBranch();
    const manager = await staff('manager', [branch]);
    const reporter = await staff('coach', [branch]);
    const ids: string[] = [];
    for (const severity of ['low', 'high', 'high']) ids.push((await post('/incidents', reporter.token, body({ severity, branchId: branch }))).body.id);
    await post(`/incidents/${ids[0]}/status`, manager.token, { status: 'under_review' });
    assert.equal((await get('/incidents?severity=high', manager.token)).body.total, 2);
    assert.equal((await get('/incidents?status=under_review', manager.token)).body.total, 1);
    const page = await get('/incidents?limit=2&offset=2', manager.token);
    assert.equal(page.body.incidents.length, 1);
    assert.equal(page.body.total, 3);
    assert.equal((await get(`/incidents?from=${enc(new Date(Date.now() + DAY).toISOString())}`, manager.token)).body.total, 0);
    for (const bad of ['severity=zzz', 'status=zzz', 'limit=0', 'limit=9999', 'offset=-1', 'from=nope']) assert.equal((await get(`/incidents?${bad}`, manager.token)).status, 400, bad);
  });
});

describe('moving an incident along', () => {
  test('only managers and owners change status; the path is followed in order', async () => {
    const coach = await staff('coach');
    const manager = await staff('manager');
    const id = (await post('/incidents', coach.token, body())).body.id;
    assert.equal((await post(`/incidents/${id}/status`, coach.token, { status: 'under_review' })).status, 403);
    assert.equal((await post(`/incidents/${id}/status`, undefined, { status: 'under_review' })).status, 401);
    for (const next of ['under_review', 'action_in_progress', 'pending_closure']) assert.equal((await post(`/incidents/${id}/status`, manager.token, { status: next })).status, 201, next);
    assert.equal((await post(`/incidents/${id}/status`, manager.token, { status: 'closed' })).status, 400, 'a note is needed to close');
    assert.equal((await post(`/incidents/${id}/status`, manager.token, { status: 'closed', note: 'Rider recovered, mounting block fixed' })).status, 201);
    assert.equal(await statusIn(id), 'closed');
    const history = await get(`/incidents/${id}/history`, manager.token);
    assert.deepEqual(history.body.history.map((h: any) => h.action), ['incident.create', 'incident.status', 'incident.status', 'incident.status', 'incident.status']);
    assert.equal(history.body.history[4].detail.note, 'Rider recovered, mounting block fixed');
  });

  test('skipping a step, going nowhere, or an unknown status is refused and the allowed next steps are listed', async () => {
    const manager = await staff('manager');
    const id = (await post('/incidents', manager.token, body())).body.id;
    const skip = await post(`/incidents/${id}/status`, manager.token, { status: 'closed', note: 'x' });
    assert.equal(skip.status, 409);
    assert.ok(codes(skip).includes('BAD_TRANSITION'));
    assert.deepEqual(skip.body.allowed, ['under_review']);
    assert.equal((await post(`/incidents/${id}/status`, manager.token, { status: 'open' })).status, 409);
    assert.equal((await post(`/incidents/${id}/status`, manager.token, { status: 'nope' })).status, 400);
    assert.equal((await post(`/incidents/${id}/status`, manager.token, {})).status, 400);
    assert.equal(await statusIn(id), 'open');
  });

  test('a closed incident can only be reopened, with a note, and then reviewed again', async () => {
    const manager = await staff('manager');
    const id = (await post('/incidents', manager.token, body({ severity: 'low' }))).body.id;
    await ctx.admin.query(`UPDATE incidents SET status = 'closed' WHERE id = $1`, [id]);
    assert.equal((await post(`/incidents/${id}/status`, manager.token, { status: 'under_review' })).status, 409);
    assert.equal((await post(`/incidents/${id}/status`, manager.token, { status: 'reopened' })).status, 400);
    assert.equal((await post(`/incidents/${id}/status`, manager.token, { status: 'reopened', note: 'New injury report' })).status, 201);
    assert.equal((await post(`/incidents/${id}/status`, manager.token, { status: 'under_review' })).status, 201);
  });

  test('only an owner can close a critical incident', async () => {
    const manager = await staff('manager');
    const owner = await staff('owner');
    const id = (await post('/incidents', manager.token, body({ severity: 'critical' }))).body.id;
    await ctx.admin.query(`UPDATE incidents SET status = 'pending_closure' WHERE id = $1`, [id]);
    const res = await post(`/incidents/${id}/status`, manager.token, { status: 'closed', note: 'Done' });
    assert.equal(res.status, 403);
    assert.ok(codes(res).includes('OWNER_MUST_CLOSE'));
    assert.equal(await statusIn(id), 'pending_closure');
    assert.equal((await post(`/incidents/${id}/status`, owner.token, { status: 'closed', note: 'Reviewed with the vet' })).status, 201);
  });

  test('another branch cannot change an incident, and two managers moving it at once leave one consistent result', async () => {
    const manager = await staff('manager');
    const second = await staff('manager');
    const id = (await post('/incidents', manager.token, body())).body.id;
    assert.equal((await post(`/incidents/${id}/status`, (await staff('manager', [await makeBranch()])).token, { status: 'under_review' })).status, 404);
    const results = await Promise.all([post(`/incidents/${id}/status`, manager.token, { status: 'under_review' }), post(`/incidents/${id}/status`, second.token, { status: 'under_review' })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await statusIn(id), 'under_review');
  });
});
