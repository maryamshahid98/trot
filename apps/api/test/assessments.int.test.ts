// Skills, assessments and level history: a level changes only by an approved assessment (or a manager's written correction),
// a second person approves, and every change is kept for good.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ctx, makeBranch, startApp, stopApp } from './helpers.ts';
import type { Json } from './helpers.ts';
import { makeRider } from './booking-helpers.ts';
import { auditActions, customer, staff } from './flow-helpers.ts';

before(startApp);
after(stopApp);

/** A private branch with a manager, a second manager, a coach and a second coach, so each test has its own skills and riders. */
async function club() {
  const branch = await makeBranch();
  const m1 = await staff('manager', [branch]);
  const m2 = await staff('manager', [branch]);
  const coach = await staff('coach', [branch]);
  const coach2 = await staff('coach', [branch]);
  const reception = await staff('reception', [branch]);
  const rider = (level = 'beginner', status = 'active') => makeRider({ branchId: branch, level, status, name: 'Amal Test' });
  const skill = async (name: string, forLevel = 'intermediate') => {
    const r = await api('POST', '/skills', { token: m1.token, body: { branchId: branch, name, forLevel } });
    assert.equal(r.status, 201, r.text);
    return r.body.id as string;
  };
  return { branch, m1, m2, coach, coach2, reception, rider, skill };
}
type Club = Awaited<ReturnType<typeof club>>;

const start = async (token: string, riderId: string) => {
  const r = await api('POST', '/assessments', { token, body: { riderId } });
  assert.equal(r.status, 201, r.text);
  return r.body.id as string;
};
const fill = (token: string, id: string, body: unknown) => api('PUT', `/assessments/${id}`, { token, body });
const submit = (token: string, id: string) => api('POST', `/assessments/${id}/submit`, { token, body: {} });
const decide = (token: string | undefined, id: string, body: unknown) => api('POST', `/assessments/${id}/decision`, { token, body });
const levelOf = async (riderId: string) => (await ctx.admin.query(`SELECT level FROM riders WHERE id = $1`, [riderId])).rows[0].level as string;
const history = async (riderId: string) => (await ctx.admin.query(`SELECT from_level, to_level, reason, assessment_id, changed_by FROM rider_level_history WHERE rider_id = $1 ORDER BY id`, [riderId])).rows;
const reasons = (res: { body: Json }) => (res.body.problems as Json[]).map((p) => p.message).join(' | ');

/** An assessment ready to be decided: two skills for the next level, both passed. */
async function submitted(k: Club, riderId?: string) {
  const a = await k.skill('Rising trot');
  const b = await k.skill('Canter transitions');
  const rid = riderId ?? (await k.rider());
  const id = await start(k.coach.token, rid);
  assert.equal((await fill(k.coach.token, id, { notes: 'Ready.', ratings: [{ skillId: a, rating: 4 }, { skillId: b, rating: 3 }] })).status, 200);
  assert.equal((await submit(k.coach.token, id)).status, 200);
  return { id, rid };
}

describe('skills', () => {
  test('managers and owners set up the skills for each level; other roles can read but not change them', async () => {
    const k = await club();
    const body = { branchId: k.branch, name: 'Rising trot', forLevel: 'intermediate', description: 'Rises on the correct diagonal' };
    assert.equal((await api('POST', '/skills', { body })).status, 401);
    for (const who of [k.coach, k.reception]) assert.equal((await api('POST', '/skills', { token: who.token, body })).status, 403);
    const made = await api('POST', '/skills', { token: k.m1.token, body });
    assert.equal(made.status, 201, made.text);
    assert.equal((await api('POST', '/skills', { token: k.m1.token, body })).status, 409, 'the same skill twice for a level');
    await api('POST', '/skills', { token: k.m1.token, body: { branchId: k.branch, name: 'Jumping a cross-pole', forLevel: 'advanced' } });
    for (const who of [k.coach, k.reception, k.m2]) {
      const list = await api('GET', `/skills?branchId=${k.branch}`, { token: who.token });
      assert.equal(list.status, 200);
      assert.equal(list.body.skills.length, 2);
    }
    assert.equal((await api('GET', `/skills?branchId=${k.branch}&forLevel=advanced`, { token: k.coach.token })).body.skills.length, 1);
    assert.equal((await api('GET', `/skills?branchId=${k.branch}`, { token: (await customer({ branchId: k.branch })).token })).status, 403);
  });

  test('a skill can be renamed and switched off; a switched-off skill is no longer required; bad input is refused', async () => {
    const k = await club();
    const id = await k.skill('Old skill');
    assert.equal((await api('PATCH', `/skills/${id}`, { token: k.m1.token, body: {} })).status, 400, 'nothing to change');
    assert.equal((await api('PATCH', `/skills/${id}`, { token: k.coach.token, body: { name: 'x' } })).status, 403);
    assert.equal((await api('PATCH', `/skills/${id}`, { token: k.m1.token, body: { name: 'Renamed', sortOrder: 2 } })).status, 200);
    assert.equal((await api('PATCH', `/skills/${id}`, { token: k.m1.token, body: { active: false } })).status, 200);
    assert.equal((await api('GET', `/skills?branchId=${k.branch}`, { token: k.m1.token })).body.skills.length, 0, 'hidden when off');
    assert.equal((await api('GET', `/skills?branchId=${k.branch}&includeInactive=true`, { token: k.m1.token })).body.skills[0].name, 'Renamed');
    for (const bad of [{ name: '', forLevel: 'beginner' }, { name: 'x', forLevel: 'expert' }, { name: 'x' }, { name: 'x', forLevel: 'beginner', sortOrder: -1 }]) {
      assert.equal((await api('POST', '/skills', { token: k.m1.token, body: { branchId: k.branch, ...bad } })).status, 400, JSON.stringify(bad));
    }
    const other = await staff('manager', [await makeBranch()]);
    assert.equal((await api('PATCH', `/skills/${id}`, { token: other.token, body: { name: 'hijack' } })).status, 404, 'another branch cannot touch it');
  });
});

describe('the assessment flow', () => {
  test('a coach rates the skills, a manager approves, the rider moves up, and the history and the family are told', async () => {
    const k = await club();
    const fam = await customer({ branchId: k.branch });
    const { id } = await submitted(k, fam.riderId);
    const a = await api('GET', `/assessments/${id}`, { token: k.m2.token });
    assert.equal(a.body.status, 'submitted');
    assert.equal(a.body.ratings.length, 2);
    assert.equal(await levelOf(fam.riderId), 'beginner', 'nothing changes before approval');

    const d = await decide(k.m2.token, id, { decision: 'approve', note: 'Well done' });
    assert.equal(d.status, 200, d.text);
    assert.deepEqual([d.body.status, d.body.level], ['approved', 'intermediate']);
    assert.equal(await levelOf(fam.riderId), 'intermediate');
    const h = await history(fam.riderId);
    const last = h.at(-1);
    assert.deepEqual([last.from_level, last.to_level, last.reason, last.assessment_id, last.changed_by], ['beginner', 'intermediate', 'assessment', id, k.m2.id]);
    assert.ok(h.some((x) => x.reason === 'initial') || h.length >= 1);
    const actions = await auditActions(id);
    for (const want of ['assessment.create', 'assessment.submit', 'assessment.decide']) assert.ok(actions.includes(want), want);
    const told = (await ctx.admin.query(`SELECT subject, body FROM notification_outbox WHERE account_id = $1 AND event = 'assessment.decided'`, [fam.id])).rows;
    assert.equal(told.length, 1);
    assert.match(told[0].body, /new level is intermediate/);
  });

  test('a promotion needs every skill for the next level rated and passed', async () => {
    const k = await club();
    const a = await k.skill('Rising trot');
    const b = await k.skill('Canter transitions');
    await k.skill('Something for advanced', 'advanced'); // another level's skill is not required
    const id = await start(k.coach.token, await k.rider());
    const none = await submit(k.coach.token, id);
    assert.equal(none.status, 422);
    assert.match(reasons(none), /Not yet rated: Canter transitions, Rising trot/);
    await fill(k.coach.token, id, { ratings: [{ skillId: a, rating: 5 }, { skillId: b, rating: 2 }] });
    const low = await submit(k.coach.token, id);
    assert.equal(low.status, 422);
    assert.match(reasons(low), /Below the pass mark: Canter transitions/);
    await fill(k.coach.token, id, { ratings: [{ skillId: b, rating: 3 }] }); // a later rating replaces the earlier one
    assert.equal((await submit(k.coach.token, id)).status, 200);
  });

  test('with no skills set up for the level, a promotion needs the assessor\'s notes; a skill switched off is not required', async () => {
    const k = await club();
    const id = await start(k.coach.token, await k.rider());
    assert.equal((await submit(k.coach.token, id)).status, 422);
    assert.equal((await fill(k.coach.token, id, { notes: 'Confident at canter in the open arena.' })).status, 200);
    assert.equal((await submit(k.coach.token, id)).status, 200);
    const off = await club();
    const sid = await off.skill('Retired skill');
    await api('PATCH', `/skills/${sid}`, { token: off.m1.token, body: { active: false } });
    const id2 = await start(off.coach.token, await off.rider());
    await fill(off.coach.token, id2, { notes: 'Fine.' });
    assert.equal((await submit(off.coach.token, id2)).status, 200);
  });

  test('ratings must be 1 to 5 and for a real, active skill of this branch', async () => {
    const k = await club();
    const s = await k.skill('Rising trot');
    const id = await start(k.coach.token, await k.rider());
    for (const rating of [0, 6, 2.5, '4']) assert.equal((await fill(k.coach.token, id, { ratings: [{ skillId: s, rating }] })).status, 400, String(rating));
    assert.equal((await fill(k.coach.token, id, { ratings: [{ skillId: '00000000-0000-0000-0000-00000000dead', rating: 3 }] })).status, 400);
    const foreign = await club();
    const theirs = await foreign.skill('Their skill');
    assert.equal((await fill(k.coach.token, id, { ratings: [{ skillId: theirs, rating: 3 }] })).status, 400, 'a skill from another branch');
    assert.equal((await fill(k.coach.token, id, {})).status, 400, 'nothing to change');
    await assert.rejects(ctx.admin.query(`INSERT INTO assessment_ratings (assessment_id, skill_id, rating) VALUES ($1,$2,9)`, [id, s]), /check constraint/, 'the database refuses it too');
  });

  test('staying at a level, or more assessment, needs notes and never changes the level', async () => {
    const k = await club();
    const rid = await k.rider();
    const id = await start(k.coach.token, rid);
    await fill(k.coach.token, id, { recommendation: 'stay' });
    assert.equal((await submit(k.coach.token, id)).status, 422, 'no notes');
    assert.equal((await fill(k.coach.token, id, { notes: 'Needs steadier hands first.', targetLevel: 'intermediate' })).status, 400, 'a target above the level makes no sense');
    await fill(k.coach.token, id, { notes: 'Needs steadier hands first.' });
    assert.equal((await submit(k.coach.token, id)).status, 200);
    const before = (await history(rid)).length;
    const d = await decide(k.m1.token, id, { decision: 'approve' });
    assert.equal(d.status, 200, d.text);
    assert.equal(await levelOf(rid), 'beginner');
    assert.equal((await history(rid)).length, before, 'no change of level, no history row');
  });

  test('the highest level has nowhere to go: the assessment starts as "stay"', async () => {
    const k = await club();
    const id = await start(k.coach.token, await k.rider('advanced'));
    const a = await api('GET', `/assessments/${id}`, { token: k.coach.token });
    assert.deepEqual([a.body.fromLevel, a.body.targetLevel, a.body.recommendation], ['advanced', 'advanced', 'stay']);
    assert.equal((await fill(k.coach.token, id, { recommendation: 'promote', notes: 'x' })).status, 200);
    assert.equal((await submit(k.coach.token, id)).status, 422);
  });
});

describe('who may do what, and a second pair of eyes', () => {
  test('coaches, managers and owners start assessments; reception, customers and anonymous callers do not; only active riders', async () => {
    const k = await club();
    const rid = await k.rider();
    assert.equal((await api('POST', '/assessments', { body: { riderId: rid } })).status, 401);
    assert.equal((await api('POST', '/assessments', { token: k.reception.token, body: { riderId: rid } })).status, 403);
    assert.equal((await api('POST', '/assessments', { token: (await customer({ branchId: k.branch })).token, body: { riderId: rid } })).status, 403);
    assert.equal((await api('POST', '/assessments', { token: k.coach.token, body: { riderId: 'nope' } })).status, 400);
    assert.equal((await api('POST', '/assessments', { token: k.coach.token, body: { riderId: '00000000-0000-0000-0000-00000000dead' } })).status, 404);
    assert.equal((await api('POST', '/assessments', { token: k.coach.token, body: { riderId: await k.rider('beginner', 'suspended') } })).status, 409, 'a suspended rider');
    assert.equal((await api('POST', '/assessments', { token: (await staff('coach', [await makeBranch()])).token, body: { riderId: rid } })).status, 404, 'a coach of another branch');
    assert.equal((await api('POST', '/assessments', { token: k.m1.token, body: { riderId: rid } })).status, 201);
  });

  test('only one assessment is open for a rider at a time', async () => {
    const k = await club();
    const rid = await k.rider();
    await start(k.coach.token, rid);
    assert.equal((await api('POST', '/assessments', { token: k.coach2.token, body: { riderId: rid } })).status, 409);
  });

  test('only the assessor changes or submits it, and not after it is submitted', async () => {
    const k = await club();
    const id = await start(k.coach.token, await k.rider());
    assert.equal((await fill(k.coach2.token, id, { notes: 'mine now' })).status, 403);
    assert.equal((await submit(k.coach2.token, id)).status, 403);
    assert.equal((await fill(k.coach.token, id, { notes: 'Ready.' })).status, 200);
    assert.equal((await submit(k.coach.token, id)).status, 200);
    assert.equal((await fill(k.coach.token, id, { notes: 'changed my mind' })).status, 409);
    assert.equal((await submit(k.coach.token, id)).status, 409);
  });

  test('nobody decides their own assessment, a coach cannot decide at all, and only a submitted one can be decided', async () => {
    const k = await club();
    const id = await start(k.m1.token, await k.rider()); // a manager assessing
    await fill(k.m1.token, id, { notes: 'Ready.' });
    assert.equal((await decide(k.m2.token, id, { decision: 'approve' })).status, 409, 'not submitted yet');
    assert.equal((await submit(k.m1.token, id)).status, 200);
    const own = await decide(k.m1.token, id, { decision: 'approve' });
    assert.equal(own.status, 403, own.text);
    assert.match(own.body.message, /cannot decide your own/);
    assert.equal((await decide(k.coach.token, id, { decision: 'approve' })).status, 403);
    assert.equal((await decide(k.reception.token, id, { decision: 'approve' })).status, 403);
    assert.equal((await decide(undefined, id, { decision: 'approve' })).status, 401);
    assert.equal((await decide(k.m2.token, id, { decision: 'approve' })).status, 200);
    assert.equal((await decide(k.m2.token, id, { decision: 'approve' })).status, 409, 'a decided assessment is final');
    await assert.rejects(ctx.admin.query(`UPDATE assessments SET decided_by = assessor_id WHERE id = $1`, [id]), /assessor_does_not_decide/, 'and the database enforces it too');
  });

  test('sending it back needs a reason; the assessor can then improve it and submit again', async () => {
    const k = await club();
    const { id } = await submitted(k);
    assert.equal((await decide(k.m2.token, id, { decision: 'request_more' })).status, 400, 'a reason is required');
    assert.equal((await decide(k.m2.token, id, { decision: 'request_more', note: 'Show me the canter again' })).body.status, 'needs_more');
    assert.equal((await fill(k.coach.token, id, { notes: 'Rechecked canter, confident.' })).status, 200);
    assert.equal((await submit(k.coach.token, id)).status, 200);
    assert.equal((await decide(k.m2.token, id, { decision: 'approve' })).status, 200);
  });

  test('rejecting needs a reason, leaves the level alone, and tells the family', async () => {
    const k = await club();
    const fam = await customer({ branchId: k.branch });
    const { id } = await submitted(k, fam.riderId);
    assert.equal((await decide(k.m2.token, id, { decision: 'reject' })).status, 400);
    const r = await decide(k.m2.token, id, { decision: 'reject', note: 'Not yet steady enough' });
    assert.equal(r.status, 200, r.text);
    assert.equal(await levelOf(fam.riderId), 'beginner');
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = $1 AND event = 'assessment.decided'`, [fam.id])).rows[0].n, 1);
    assert.equal((await start(k.coach.token, fam.riderId)).length > 10, true, 'a rejected assessment no longer blocks a new one');
  });

  test('an approval is refused if the rider\'s level was changed after the assessment began', async () => {
    const k = await club();
    const { id, rid } = await submitted(k);
    assert.equal((await api('POST', `/riders/${rid}/level`, { token: k.m1.token, body: { level: 'intermediate', reason: 'Placed directly' } })).status, 201);
    const r = await decide(k.m2.token, id, { decision: 'approve' });
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.message, /Start a new assessment/);
    assert.equal(await levelOf(rid), 'intermediate');
    assert.equal((await history(rid)).filter((h) => h.reason === 'assessment').length, 0);
  });
});

describe('history and who can see progress', () => {
  test('the level history cannot be edited or deleted', async () => {
    const k = await club();
    const { id, rid } = await submitted(k);
    await decide(k.m2.token, id, { decision: 'approve' });
    await assert.rejects(ctx.admin.query(`UPDATE rider_level_history SET to_level = 'advanced' WHERE rider_id = $1`, [rid]), /append-only/);
    await assert.rejects(ctx.admin.query(`DELETE FROM rider_level_history WHERE rider_id = $1`, [rid]), /append-only/);
  });

  test('a family sees the level, the history and APPROVED results only, without the assessor\'s private notes; staff see everything', async () => {
    const k = await club();
    const fam = await customer({ branchId: k.branch });
    const sk = await k.skill('Rising trot');
    const first = await start(k.coach.token, fam.riderId);
    await fill(k.coach.token, first, { notes: 'PRIVATE first view', ratings: [{ skillId: sk, rating: 5, evidence: 'PRIVATE evidence' }] });
    await submit(k.coach.token, first);
    const family = () => api('GET', `/riders/${fam.riderId}/progress`, { token: fam.token });
    assert.equal((await family()).body.assessments.length, 0, 'a submitted assessment is not shown until approved');
    await decide(k.m2.token, first, { decision: 'approve' });
    const seen = await family();
    assert.equal(seen.status, 200, seen.text);
    assert.equal(seen.body.level, 'intermediate');
    assert.equal(seen.body.assessments.length, 1);
    assert.deepEqual(seen.body.assessments[0].ratings.map((r: Json) => [r.skillName, r.rating]), [['Rising trot', 5]]);
    const text = JSON.stringify(seen.body);
    assert.ok(!text.includes('PRIVATE'), 'no private notes or evidence');
    assert.equal(seen.body.assessments[0].assessorName, null);
    assert.ok(seen.body.history.length >= 1);
    const staffView = (await api('GET', `/riders/${fam.riderId}/progress`, { token: k.reception.token })).body;
    assert.match(JSON.stringify(staffView), /PRIVATE first view/);
    assert.equal((await api('GET', `/riders/${fam.riderId}/progress`, { token: (await customer({ branchId: k.branch })).token })).status, 404, 'another family');
    assert.equal((await api('GET', `/riders/${fam.riderId}/progress`, { token: (await staff('stable_hand', [k.branch])).token })).status, 403);
    assert.equal((await api('GET', `/riders/${fam.riderId}/progress`)).status, 401);
  });

  test('another branch cannot see, list or decide this branch\'s assessments', async () => {
    const k = await club();
    const { id } = await submitted(k);
    const other = await staff('manager', [await makeBranch()]);
    assert.equal((await api('GET', `/assessments/${id}`, { token: other.token })).status, 404);
    assert.equal((await decide(other.token, id, { decision: 'approve' })).status, 404);
    assert.equal((await api('GET', `/assessments?branchId=${k.branch}`, { token: other.token })).status, 404);
    assert.equal((await api('GET', '/assessments', { token: other.token })).body.total, 0);
  });

  test('the list can be filtered by status and rider, and pages', async () => {
    const k = await club();
    const { id, rid } = await submitted(k);
    await start(k.coach.token, await k.rider());
    const all = await api('GET', `/assessments?branchId=${k.branch}`, { token: k.m1.token });
    assert.equal(all.body.total, 2);
    assert.equal((await api('GET', `/assessments?branchId=${k.branch}&status=submitted`, { token: k.m1.token })).body.assessments[0].id, id);
    assert.equal((await api('GET', `/assessments?branchId=${k.branch}&riderId=${rid}`, { token: k.m1.token })).body.total, 1);
    assert.equal((await api('GET', `/assessments?branchId=${k.branch}&limit=1&offset=1`, { token: k.m1.token })).body.assessments.length, 1);
    assert.equal((await api('GET', `/assessments?branchId=${k.branch}&status=nonsense`, { token: k.m1.token })).status, 400);
  });
});
