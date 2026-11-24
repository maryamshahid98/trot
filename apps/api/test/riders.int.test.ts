import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, BRANCH, ctx, makeAccount, makeBranch, startApp, stopApp, tokenFor, randomDay } from './helpers.ts';
import { codes, guard, HOUR, LONG_LIVED_UNTIL, makeClass, makeRider, verifyDocs } from './booking-helpers.ts';
import type { Json } from './helpers.ts';

before(startApp);
after(stopApp);

async function person(role: string, branchIds = [BRANCH]) {
  const acct = await makeAccount({ role, branchIds });
  return { ...acct, token: await tokenFor(acct) };
}
const post = (path: string, token: string | undefined, body: unknown = {}) => api('POST', path, { token, body });
const ADULT = '1990-04-12';
const CHILD = '2015-05-30';
let n = 0;
const name = (p = 'Rider') => `${p} ${Date.now()}-${n++}`;

describe('POST /riders', () => {
  test('no token, and a coach, are refused', async () => {
    assert.equal((await post('/riders', undefined, {})).status, 401);
    assert.equal((await post('/riders', (await person('coach')).token, { fullName: 'x', dateOfBirth: ADULT })).status, 403);
  });

  test('bad input names the fields', async () => {
    const c = await person('customer');
    const bad: unknown[] = [
      {},
      { fullName: '', dateOfBirth: ADULT, relation: 'self' },
      { fullName: 'A', dateOfBirth: '2015-02-30', relation: 'ward' },
      { fullName: 'A', dateOfBirth: '12/04/1990', relation: 'self' },
      { fullName: 'A', dateOfBirth: '2999-01-01', relation: 'self' },
      { fullName: 'A', dateOfBirth: '1800-01-01', relation: 'self' },
      { fullName: 'A'.repeat(500), dateOfBirth: ADULT, relation: 'self' },
      { fullName: 'A', dateOfBirth: ADULT, relation: 'cousin' },
      { fullName: 'A', dateOfBirth: ADULT, relation: 'self', emergencyContact: { name: 'x' } },
    ];
    for (const body of bad) {
      const r = await post('/riders', c.token, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.body.problems.length > 0);
    }
    assert.equal((await post('/riders', c.token, { fullName: 'A', dateOfBirth: ADULT })).status, 400, 'a customer must say self or ward');
    assert.equal((await api('POST', '/riders', { token: c.token, rawBody: '{oops' })).status, 400);
  });

  test('a customer adds themselves: it waits for approval and is linked to their account', async () => {
    const c = await person('customer');
    const r = await post('/riders', c.token, { fullName: name(), dateOfBirth: ADULT, relation: 'self', medicalNotes: 'asthma', emergencyContact: { name: 'Sam', phone: '+966500000000' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'pending_review');
    const row = (await ctx.admin.query(`SELECT account_id, status FROM riders WHERE id = $1`, [r.body.id])).rows[0];
    assert.equal(row.account_id, c.id);
  });

  test('a second profile for the same customer is refused', async () => {
    const c = await person('customer');
    const body = { fullName: name(), dateOfBirth: ADULT, relation: 'self' };
    assert.equal((await post('/riders', c.token, body)).status, 201);
    const again = await post('/riders', c.token, body);
    assert.equal(again.status, 409);
    assert.deepEqual(codes(again), ['ALREADY_HAS_PROFILE']);
  });

  test('two requests at once still make one profile', async () => {
    const c = await person('customer');
    const body = { fullName: name(), dateOfBirth: ADULT, relation: 'self' };
    const rs = await Promise.all([post('/riders', c.token, body), post('/riders', c.token, body), post('/riders', c.token, body)]);
    assert.equal(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.status)));
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM riders WHERE account_id = $1`, [c.id])).rows[0].n, 1);
  });

  test('a child cannot add themselves, and an adult cannot be added as a ward', async () => {
    const c = await person('customer');
    const child = await post('/riders', c.token, { fullName: name(), dateOfBirth: CHILD, relation: 'self' });
    assert.equal(child.status, 422);
    assert.deepEqual(codes(child), ['CHILD_NEEDS_GUARDIAN']);
    const adult = await post('/riders', c.token, { fullName: name(), dateOfBirth: ADULT, relation: 'ward' });
    assert.equal(adult.status, 422);
    assert.deepEqual(codes(adult), ['ADULT_NEEDS_OWN_ACCOUNT']);
  });

  test('a parent adds a child: the parent becomes the guardian', async () => {
    const c = await person('customer');
    const r = await post('/riders', c.token, { fullName: name('Kid'), dateOfBirth: CHILD, relation: 'ward' });
    assert.equal(r.status, 201, r.text);
    const link = await ctx.admin.query(`SELECT 1 FROM guardian_riders WHERE rider_id = $1 AND guardian_account_id = $2`, [r.body.id, c.id]);
    assert.equal(link.rowCount, 1);
    const row = (await ctx.admin.query(`SELECT account_id FROM riders WHERE id = $1`, [r.body.id])).rows[0];
    assert.equal(row.account_id, null);
  });

  test('a customer cannot use the staff-only fields', async () => {
    const c = await person('customer');
    const other = await person('customer');
    assert.equal((await post('/riders', c.token, { fullName: name(), dateOfBirth: CHILD, relation: 'ward', guardianAccountId: other.id })).status, 403);
    assert.equal((await post('/riders', c.token, { fullName: name(), dateOfBirth: ADULT, relation: 'self', isWalkIn: true })).status, 403);
  });

  test('staff add a rider who is approved straight away, optionally linked to a guardian', async () => {
    const rec = await person('reception');
    const parent = await person('customer');
    const r = await post('/riders', rec.token, { fullName: name('Walk'), dateOfBirth: CHILD, guardianAccountId: parent.id, isWalkIn: true });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'active');
    assert.equal((await ctx.admin.query(`SELECT is_walk_in FROM riders WHERE id = $1`, [r.body.id])).rows[0].is_walk_in, true);
    assert.equal((await ctx.admin.query(`SELECT 1 FROM guardian_riders WHERE rider_id = $1 AND guardian_account_id = $2`, [r.body.id, parent.id])).rowCount, 1);
  });

  test('a guardian who is not a customer of the branch is refused', async () => {
    const rec = await person('reception');
    const coach = await person('coach');
    const elsewhere = await person('customer', [await makeBranch()]);
    for (const guardianAccountId of [coach.id, elsewhere.id, '00000000-0000-0000-0000-00000000dead']) {
      const r = await post('/riders', rec.token, { fullName: name(), dateOfBirth: CHILD, guardianAccountId });
      assert.equal(r.status, 422, guardianAccountId);
      assert.deepEqual(codes(r), ['GUARDIAN_NOT_ELIGIBLE']);
    }
  });

  test('staff cannot add a rider to a branch they do not work in', async () => {
    const rec = await person('reception');
    const other = await makeBranch();
    assert.equal((await post('/riders', rec.token, { branchId: other, fullName: name(), dateOfBirth: ADULT })).status, 403);
  });

  test('creation is audited without the medical text', async () => {
    const c = await person('customer');
    const r = await post('/riders', c.token, { fullName: name(), dateOfBirth: ADULT, relation: 'self', medicalNotes: 'SECRET-NOTE' });
    const rows = (await ctx.admin.query(`SELECT action, detail::text AS d FROM audit_log WHERE entity_id = $1`, [r.body.id])).rows;
    assert.deepEqual(rows.map((x) => x.action), ['rider.create']);
    assert.ok(!rows[0].d.includes('SECRET-NOTE'));
  });
});

describe('reading riders', () => {
  test('mine: own profile and children only; staff refused', async () => {
    const c = await person('customer');
    const stranger = await person('customer');
    await post('/riders', c.token, { fullName: 'Me', dateOfBirth: ADULT, relation: 'self' });
    await post('/riders', c.token, { fullName: 'Kid', dateOfBirth: CHILD, relation: 'ward' });
    await post('/riders', stranger.token, { fullName: 'Not mine', dateOfBirth: ADULT, relation: 'self' });
    const r = await api('GET', '/riders/mine', { token: c.token });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.riders.map((x: Json) => x.fullName).sort(), ['Kid', 'Me']);
    assert.equal((await api('GET', '/riders/mine')).status, 401);
    assert.equal((await api('GET', '/riders/mine', { token: (await person('reception')).token })).status, 403);
  });

  test('get: the family and staff can; other customers and other branches cannot, and cannot tell it exists', async () => {
    const c = await person('customer');
    const created = await post('/riders', c.token, { fullName: name(), dateOfBirth: ADULT, relation: 'self', allergies: 'penicillin' });
    const id = created.body.id;
    const own = await api('GET', `/riders/${id}`, { token: c.token });
    assert.equal(own.status, 200);
    assert.equal(own.body.allergies, 'penicillin');
    assert.equal(own.body.dateOfBirth, ADULT);
    assert.equal((await api('GET', `/riders/${id}`, { token: (await person('reception')).token })).status, 200);
    assert.equal((await api('GET', `/riders/${id}`, { token: (await person('customer')).token })).status, 404);
    assert.equal((await api('GET', `/riders/${id}`, { token: (await person('manager', [await makeBranch()])).token })).status, 404);
    assert.equal((await api('GET', `/riders/${id}`, { token: (await person('coach')).token })).status, 403);
    assert.equal((await api('GET', `/riders/not-an-id`, { token: c.token })).status, 400);
    assert.equal((await api('GET', `/riders/00000000-0000-0000-0000-00000000dead`, { token: c.token })).status, 404);
  });

  test('list: staff only, with search, filter and paging, and no medical details', async () => {
    const rec = await person('reception');
    const tag = `Zork${Date.now()}`;
    for (const i of [1, 2, 3]) await makeRider({ name: `${tag} ${i}`, status: i === 3 ? 'suspended' : 'active' });
    await makeRider({ name: `${tag}%literal` });
    assert.equal((await api('GET', '/riders', { token: (await person('customer')).token })).status, 403);
    assert.equal((await api('GET', '/riders')).status, 401);

    const found = await api('GET', `/riders?q=${tag}&limit=2`, { token: rec.token });
    assert.equal(found.status, 200);
    assert.equal(found.body.total, 4);
    assert.equal(found.body.riders.length, 2);
    const page2 = await api('GET', `/riders?q=${tag}&limit=2&offset=2`, { token: rec.token });
    assert.equal(page2.body.riders.length, 2);
    const susp = await api('GET', `/riders?q=${tag}&status=suspended`, { token: rec.token });
    assert.equal(susp.body.total, 1);
    // A literal % must not act as a wildcard.
    const literal = await api('GET', `/riders?q=${encodeURIComponent('%literal')}`, { token: rec.token });
    assert.equal(literal.body.total, 1);
    const wild = await api('GET', `/riders?q=${encodeURIComponent('%')}`, { token: rec.token });
    assert.equal(wild.body.total, 1, 'only the name that really contains a percent sign');
    for (const banned of ['medical', 'allergies', 'emergency']) assert.ok(!found.text.toLowerCase().includes(banned));
  });

  test('list: bad input, and another branch is not visible', async () => {
    const rec = await person('reception');
    for (const qs of ['limit=0', 'limit=999', 'offset=-1', 'status=banana', 'limit=abc', `branchId=nope`]) {
      assert.equal((await api('GET', `/riders?${qs}`, { token: rec.token })).status, 400, qs);
    }
    assert.equal((await api('GET', `/riders?branchId=${await makeBranch()}`, { token: rec.token })).status, 403);
    const otherBranch = await makeBranch();
    await makeRider({ name: 'Hidden Elsewhere', branchId: otherBranch });
    assert.equal((await api('GET', `/riders?q=Hidden Elsewhere`, { token: rec.token })).body.total, 0);
  });
});

describe('PATCH /riders/:id', () => {
  async function mineRider() {
    const c = await person('customer');
    const r = await post('/riders', c.token, { fullName: name(), dateOfBirth: ADULT, relation: 'self', medicalNotes: 'old' });
    return { ...c, id: r.body.id as string };
  }

  test('a customer edits notes, and null clears them', async () => {
    const x = await mineRider();
    const r = await api('PATCH', `/riders/${x.id}`, { token: x.token, body: { medicalNotes: 'new notes', emergencyContact: { name: 'Sam', phone: '123' } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.medicalNotes, 'new notes');
    assert.equal(r.body.emergencyContact.name, 'Sam');
    const cleared = await api('PATCH', `/riders/${x.id}`, { token: x.token, body: { medicalNotes: null } });
    assert.equal(cleared.body.medicalNotes, null);
  });

  test('empty body, unknown fields and a customer changing the date of birth are all refused', async () => {
    const x = await mineRider();
    for (const body of [{}, { nothing: 1 }, { dateOfBirth: '2000-01-01' }, { level: 'advanced' }, { status: 'active' }, { fullName: '' }]) {
      assert.equal((await api('PATCH', `/riders/${x.id}`, { token: x.token, body })).status, 400, JSON.stringify(body));
    }
    const row = (await ctx.admin.query(`SELECT to_char(date_of_birth,'YYYY-MM-DD') AS d, level, status FROM riders WHERE id = $1`, [x.id])).rows[0];
    assert.deepEqual(row, { d: ADULT, level: 'beginner', status: 'pending_review' });
  });

  test('staff can correct the date of birth; others cannot touch the rider', async () => {
    const x = await mineRider();
    assert.equal((await api('PATCH', `/riders/${x.id}`, { token: (await person('reception')).token, body: { dateOfBirth: '1991-01-01' } })).status, 200);
    assert.equal((await api('PATCH', `/riders/${x.id}`, { token: (await person('customer')).token, body: { fullName: 'Hacked' } })).status, 404);
    assert.equal((await api('PATCH', `/riders/${x.id}`, { token: (await person('coach')).token, body: { fullName: 'Hacked' } })).status, 403);
    assert.equal((await api('PATCH', `/riders/${x.id}`, { body: { fullName: 'Hacked' } })).status, 401);
  });

  test('the audit trail records which fields changed, never the text', async () => {
    const x = await mineRider();
    await api('PATCH', `/riders/${x.id}`, { token: x.token, body: { medicalNotes: 'PRIVATE-TEXT' } });
    const d = (await ctx.admin.query(`SELECT detail::text AS d FROM audit_log WHERE entity_id = $1 AND action = 'rider.update'`, [x.id])).rows[0].d;
    assert.ok(d.includes('medicalNotes') && !d.includes('PRIVATE-TEXT'));
  });
});

describe('level and status', () => {
  async function pendingRider() {
    const c = await person('customer');
    const r = await post('/riders', c.token, { fullName: name(), dateOfBirth: ADULT, relation: 'self' });
    return r.body.id as string;
  }

  test('level correction: managers and owners only (a coach assesses instead), with a reason, a real level, and a kept history', async () => {
    const id = await pendingRider();
    const fix = { level: 'advanced', reason: 'Entered wrongly at sign-up' };
    assert.equal((await post(`/riders/${id}/level`, (await person('customer')).token, fix)).status, 403);
    assert.equal((await post(`/riders/${id}/level`, (await person('reception')).token, fix)).status, 403);
    assert.equal((await post(`/riders/${id}/level`, (await person('coach')).token, fix)).status, 403, 'a coach recommends through an assessment; a manager approves');
    assert.equal((await post(`/riders/${id}/level`, undefined, fix)).status, 401);
    const manager = await person('manager');
    assert.equal((await post(`/riders/${id}/level`, manager.token, { level: 'expert', reason: 'x' })).status, 400, 'not a level');
    assert.equal((await post(`/riders/${id}/level`, manager.token, { level: 'intermediate' })).status, 400, 'a reason is required');
    assert.equal((await post(`/riders/${id}/level`, manager.token, { level: 'intermediate', reason: '   ' })).status, 400, 'a blank reason is not a reason');
    assert.equal((await post(`/riders/${id}/level`, manager.token, { level: 'intermediate', reason: 'Placed by the head coach' })).status, 201);
    assert.equal((await ctx.admin.query(`SELECT level FROM riders WHERE id = $1`, [id])).rows[0].level, 'intermediate');
    const history = (await ctx.admin.query(`SELECT from_level, to_level, reason, note, changed_by FROM rider_level_history WHERE rider_id = $1 ORDER BY id`, [id])).rows;
    assert.deepEqual(history.map((h) => [h.from_level, h.to_level, h.reason]), [[null, 'beginner', 'initial'], ['beginner', 'intermediate', 'correction']]);
    assert.equal(history[1].note, 'Placed by the head coach');
    assert.equal(history[1].changed_by, manager.id);
    assert.equal((await post(`/riders/${id}/level`, (await person('manager', [await makeBranch()])).token, fix)).status, 404);
  });

  test('reception can approve or reject a sign-up but not suspend', async () => {
    const rec = await person('reception');
    const a = await pendingRider();
    assert.equal((await post(`/riders/${a}/status`, rec.token, { status: 'suspended', reason: 'x' })).status, 403);
    assert.equal((await post(`/riders/${a}/status`, rec.token, { status: 'active' })).status, 201);
    assert.equal((await post(`/riders/${a}/status`, rec.token, { status: 'inactive', reason: 'too late' })).status, 403, 'after sign-up only a manager decides');
    const b = await pendingRider();
    assert.equal((await post(`/riders/${b}/status`, rec.token, { status: 'inactive' })).status, 400, 'a rejection needs a reason');
    assert.equal((await post(`/riders/${b}/status`, rec.token, { status: 'inactive', reason: 'duplicate' })).status, 201);
  });

  test('a manager changes status with a reason, which is audited; the same status twice is a conflict', async () => {
    const mgr = await person('manager');
    const id = await pendingRider();
    assert.equal((await post(`/riders/${id}/status`, mgr.token, { status: 'active' })).status, 201);
    assert.equal((await post(`/riders/${id}/status`, mgr.token, { status: 'suspended' })).status, 400);
    assert.equal((await post(`/riders/${id}/status`, mgr.token, { status: 'archived', reason: 'x' })).status, 400, 'archiving is not a button');
    assert.equal((await post(`/riders/${id}/status`, mgr.token, { status: 'nonsense', reason: 'x' })).status, 400);
    assert.equal((await post(`/riders/${id}/status`, mgr.token, { status: 'suspended', reason: 'unsafe behaviour' })).status, 201);
    const again = await post(`/riders/${id}/status`, mgr.token, { status: 'suspended', reason: 'again' });
    assert.equal(again.status, 409);
    const d = JSON.parse((await ctx.admin.query(`SELECT detail::text AS d FROM audit_log WHERE entity_id = $1 AND action = 'rider.status' ORDER BY at DESC LIMIT 1`, [id])).rows[0].d);
    assert.deepEqual(d, { from: 'active', to: 'suspended', reason: 'unsafe behaviour' });
  });

  test('a customer cannot approve themselves; other branches cannot touch it', async () => {
    const c = await person('customer');
    const r = await post('/riders', c.token, { fullName: name(), dateOfBirth: ADULT, relation: 'self' });
    assert.equal((await post(`/riders/${r.body.id}/status`, c.token, { status: 'active' })).status, 403);
    assert.equal((await post(`/riders/${r.body.id}/status`, (await person('manager', [await makeBranch()])).token, { status: 'active' })).status, 404);
  });

  test('a suspended rider can no longer book', async () => {
    const mgr = await person('manager');
    const rider = await makeRider();
    await verifyDocs(rider);
    await post(`/riders/${rider}/status`, mgr.token, { status: 'suspended', reason: 'test' });
    const occ = await makeClass({ startsAt: randomDay() + 8 * HOUR });
    const r = await post('/bookings', mgr.token, { occurrenceId: occ, riderId: rider, payWith: 'office' });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r), ['RIDER_NOT_ACTIVE']);
  });
});

describe('guardians', () => {
  test('staff add, list and remove guardians; customers cannot', async () => {
    const rec = await person('reception');
    const p1 = await person('customer');
    const p2 = await person('customer');
    const kid = await makeRider({ dob: CHILD });
    await guard(p1.id, kid);
    assert.equal((await post(`/riders/${kid}/guardians`, p1.token, { accountId: p2.id })).status, 403);
    assert.equal((await post(`/riders/${kid}/guardians`, rec.token, { accountId: p2.id })).status, 201);
    const dup = await post(`/riders/${kid}/guardians`, rec.token, { accountId: p2.id });
    assert.equal(dup.status, 409);
    const list = await api('GET', `/riders/${kid}/guardians`, { token: rec.token });
    assert.equal(list.body.guardians.length, 2);
    assert.equal((await api('DELETE', `/riders/${kid}/guardians/${p1.id}`, { token: rec.token })).status, 200);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM guardian_riders WHERE rider_id = $1`, [kid])).rows[0].n, 1);
  });

  test('the last guardian of a child cannot be removed; an adult can lose theirs', async () => {
    const rec = await person('reception');
    const p = await person('customer');
    const kid = await makeRider({ dob: CHILD });
    await guard(p.id, kid);
    const r = await api('DELETE', `/riders/${kid}/guardians/${p.id}`, { token: rec.token });
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r), ['LAST_GUARDIAN']);
    const adult = await makeRider({ dob: ADULT });
    await guard(p.id, adult);
    assert.equal((await api('DELETE', `/riders/${adult}/guardians/${p.id}`, { token: rec.token })).status, 200);
  });

  test('bad ids, strangers and non-customers are refused', async () => {
    const rec = await person('reception');
    const kid = await makeRider({ dob: CHILD });
    const coach = await person('coach');
    assert.equal((await post(`/riders/${kid}/guardians`, rec.token, { accountId: 'nope' })).status, 400);
    const notCustomer = await post(`/riders/${kid}/guardians`, rec.token, { accountId: coach.id });
    assert.equal(notCustomer.status, 422);
    assert.equal((await api('DELETE', `/riders/${kid}/guardians/${coach.id}`, { token: rec.token })).status, 404);
    assert.equal((await api('DELETE', `/riders/${kid}/guardians/xyz`, { token: rec.token })).status, 400);
    assert.equal((await api('GET', `/riders/${kid}/guardians`, { token: (await person('customer')).token })).status, 403);
    assert.equal((await post(`/riders/${kid}/guardians`, (await person('manager', [await makeBranch()])).token, { accountId: coach.id })).status, 404);
  });
});

describe('documents', () => {
  async function family() {
    const parent = await person('customer');
    const kid = await post('/riders', parent.token, { fullName: name('Kid'), dateOfBirth: CHILD, relation: 'ward' });
    return { parent, riderId: kid.body.id as string };
  }
  const submit = (token: string | undefined, riderId: string, body: unknown) => post(`/riders/${riderId}/documents`, token, body);

  test('a guardian submits; the document waits as submitted and the family can list it', async () => {
    const f = await family();
    const r = await submit(f.parent.token, f.riderId, { kind: 'medical_form', fileRef: 'uploads/form.pdf', expiresAt: '2045-01-01T00:00:00Z' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'submitted');
    const list = await api('GET', `/riders/${f.riderId}/documents`, { token: f.parent.token });
    assert.equal(list.body.documents.length, 1);
    assert.equal(list.body.documents[0].kind, 'medical_form');
  });

  test('no token, wrong people and bad input', async () => {
    const f = await family();
    assert.equal((await submit(undefined, f.riderId, { kind: 'waiver' })).status, 401);
    assert.equal((await submit((await person('customer')).token, f.riderId, { kind: 'waiver' })).status, 404);
    assert.equal((await submit((await person('coach')).token, f.riderId, { kind: 'waiver' })).status, 403);
    assert.equal((await api('GET', `/riders/${f.riderId}/documents`, { token: (await person('customer')).token })).status, 404);
    for (const body of [{}, { kind: 'passport' }, { kind: 'waiver', signedAt: 'yesterday' }, { kind: 'waiver', signedAt: '2999-01-01T00:00:00Z' }, { kind: 'waiver', signedAt: '2026-01-02T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z' }, { kind: 'waiver', fileRef: 'x'.repeat(600) }]) {
      assert.equal((await submit(f.parent.token, f.riderId, body)).status, 400, JSON.stringify(body));
    }
  });

  test('a newer submission replaces one still waiting for review', async () => {
    const f = await family();
    const first = await submit(f.parent.token, f.riderId, { kind: 'waiver' });
    const second = await submit(f.parent.token, f.riderId, { kind: 'waiver' });
    const status = async (id: string) => (await ctx.admin.query(`SELECT status FROM rider_documents WHERE id = $1`, [id])).rows[0].status;
    assert.equal(await status(first.body.id), 'superseded');
    assert.equal(await status(second.body.id), 'submitted');
  });

  test('only staff verify or reject, and each can happen once', async () => {
    const f = await family();
    const rec = await person('reception');
    const d = (await submit(f.parent.token, f.riderId, { kind: 'waiver' })).body.id;
    assert.equal((await post(`/documents/${d}/verify`, f.parent.token)).status, 403);
    assert.equal((await post(`/documents/${d}/verify`, undefined)).status, 401);
    assert.equal((await post(`/documents/${d}/verify`, (await person('manager', [await makeBranch()])).token)).status, 404);
    assert.equal((await post(`/documents/nope/verify`, rec.token)).status, 400);
    assert.equal((await post(`/documents/00000000-0000-0000-0000-00000000dead/verify`, rec.token)).status, 404);
    assert.equal((await post(`/documents/${d}/verify`, rec.token)).status, 201);
    const again = await post(`/documents/${d}/verify`, rec.token);
    assert.equal(again.status, 409);
    assert.deepEqual(codes(again), ['DOCUMENT_NOT_PENDING']);
    assert.equal((await post(`/documents/${d}/reject`, rec.token, { reason: 'late' })).status, 409);
  });

  test('a rejection needs a reason, is final, and is audited with it', async () => {
    const f = await family();
    const rec = await person('reception');
    const d = (await submit(f.parent.token, f.riderId, { kind: 'id_document' })).body.id;
    assert.equal((await post(`/documents/${d}/reject`, rec.token, {})).status, 400);
    assert.equal((await post(`/documents/${d}/reject`, rec.token, { reason: 'photo is blurry' })).status, 201);
    assert.equal((await post(`/documents/${d}/verify`, rec.token)).status, 409);
    const a = (await ctx.admin.query(`SELECT detail::text AS d FROM audit_log WHERE entity_id = $1 AND action = 'document.reject'`, [d])).rows[0].d;
    assert.ok(a.includes('photo is blurry'));
  });

  test('a document that has already expired cannot be verified', async () => {
    const f = await family();
    const rec = await person('reception');
    const d = (await submit(f.parent.token, f.riderId, { kind: 'medical_form', signedAt: '2020-01-01T00:00:00Z', expiresAt: '2021-01-01T00:00:00Z' })).body.id;
    const r = await post(`/documents/${d}/verify`, rec.token);
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r), ['DOCUMENT_ALREADY_EXPIRED']);
  });

  test('verifying a new form supersedes the old verified one, and two reviewers at once verify it once', async () => {
    const f = await family();
    const rec = await person('reception');
    const mgr = await person('manager');
    const old = (await submit(f.parent.token, f.riderId, { kind: 'medical_form' })).body.id;
    await post(`/documents/${old}/verify`, rec.token);
    const fresh = (await submit(f.parent.token, f.riderId, { kind: 'medical_form' })).body.id;
    const both = await Promise.all([post(`/documents/${fresh}/verify`, rec.token), post(`/documents/${fresh}/verify`, mgr.token)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
    const rows = (await ctx.admin.query(`SELECT id, status FROM rider_documents WHERE rider_id = $1 AND kind = 'medical_form'`, [f.riderId])).rows;
    assert.equal(rows.find((r) => r.id === old).status, 'superseded');
    assert.equal(rows.filter((r) => r.status === 'verified').length, 1);
  });

  test('from sign-up to first booking: submit, verify, approve, then book', async () => {
    const c = await person('customer');
    const rec = await person('reception');
    const me = await post('/riders', c.token, { fullName: name(), dateOfBirth: ADULT, relation: 'self' });
    const riderId = me.body.id;
    const occ = await makeClass({ startsAt: randomDay() + 8 * HOUR });
    const body = { occurrenceId: occ, riderId, payWith: 'office' };

    const blocked = await post('/bookings', c.token, body);
    assert.deepEqual(codes(blocked).sort(), ['MEDICAL_MISSING', 'RIDER_NOT_ACTIVE', 'WAIVER_MISSING']);

    for (const kind of ['medical_form', 'waiver']) {
      const d = await submit(c.token, riderId, { kind, expiresAt: kind === 'medical_form' ? `${LONG_LIVED_UNTIL}T00:00:00Z` : undefined });
      assert.equal((await post(`/documents/${d.body.id}/verify`, rec.token)).status, 201);
    }
    assert.deepEqual(codes(await post('/bookings', c.token, body)), ['RIDER_NOT_ACTIVE']);
    assert.equal((await post(`/riders/${riderId}/status`, rec.token, { status: 'active' })).status, 201);
    const ok = await post('/bookings', c.token, body);
    assert.equal(ok.status, 201, ok.text);
  });
});
