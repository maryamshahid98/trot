import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAssessment, levelAfterApproval, nextLevel, unmetSkills } from '../src/index.ts';

const skills = [{ id: 'a', name: 'Rising trot' }, { id: 'b', name: 'Canter transitions' }];
const base = { fromLevel: 'beginner' as const, targetLevel: 'intermediate' as const, recommendation: 'promote' as const, notes: '', requiredSkills: skills };

test('the level above, and none above the highest', () => {
  assert.equal(nextLevel('beginner'), 'intermediate');
  assert.equal(nextLevel('intermediate'), 'advanced');
  assert.equal(nextLevel('advanced'), null);
});

test('which required skills are missing or below the pass mark', () => {
  assert.deepEqual(unmetSkills(skills, []), { missing: ['Rising trot', 'Canter transitions'], belowPass: [] });
  assert.deepEqual(unmetSkills(skills, [{ skillId: 'a', rating: 2 }, { skillId: 'b', rating: 3 }]), { missing: [], belowPass: ['Rising trot'] });
  assert.deepEqual(unmetSkills(skills, [{ skillId: 'a', rating: 3 }, { skillId: 'b', rating: 5 }]), { missing: [], belowPass: [] });
  assert.deepEqual(unmetSkills(skills, [{ skillId: 'a', rating: 4 }], 5).belowPass, ['Rising trot'], 'the pass mark can be changed');
  assert.deepEqual(unmetSkills([], []), { missing: [], belowPass: [] });
});

test('a promotion needs every required skill rated and passed', () => {
  assert.equal(checkAssessment({ ...base, ratings: [{ skillId: 'a', rating: 4 }, { skillId: 'b', rating: 3 }] }).ok, true);
  const r = checkAssessment({ ...base, ratings: [{ skillId: 'a', rating: 4 }] });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /Not yet rated: Canter transitions/);
  const low = checkAssessment({ ...base, ratings: [{ skillId: 'a', rating: 1 }, { skillId: 'b', rating: 2 }] });
  assert.match(low.reasons.join(' '), /Below the pass mark: Rising trot, Canter transitions/);
});

test('a promotion goes exactly one level up', () => {
  const ok = [{ skillId: 'a', rating: 5 }, { skillId: 'b', rating: 5 }];
  assert.match(checkAssessment({ ...base, targetLevel: 'advanced', ratings: ok }).reasons.join(' '), /exactly one level up/);
  assert.match(checkAssessment({ ...base, targetLevel: 'beginner', ratings: ok }).reasons.join(' '), /exactly one level up/);
  assert.match(checkAssessment({ ...base, fromLevel: 'advanced', targetLevel: 'advanced', ratings: ok }).reasons.join(' '), /no higher level/);
});

test('with no skills set up for the level, a promotion needs written notes instead', () => {
  const none = { ...base, requiredSkills: [], ratings: [] };
  assert.equal(checkAssessment(none).ok, false);
  assert.equal(checkAssessment({ ...none, notes: '   ' }).ok, false, 'blanks are not notes');
  assert.equal(checkAssessment({ ...none, notes: 'Rides confidently at canter in the open arena.' }).ok, true);
});

test('staying at a level, or asking for more assessment, needs notes and no change of level', () => {
  for (const recommendation of ['stay', 'further_assessment'] as const) {
    const a = { ...base, recommendation, targetLevel: 'beginner' as const, requiredSkills: [], ratings: [] };
    assert.equal(checkAssessment(a).ok, false, `${recommendation} without notes`);
    assert.equal(checkAssessment({ ...a, notes: 'Needs more balance work.' }).ok, true);
    assert.match(checkAssessment({ ...a, targetLevel: 'intermediate', notes: 'x' }).reasons.join(' '), /target level must stay/);
  }
});

test('approving a promotion moves the level only while the rider is still where the assessment started', () => {
  const promo = { fromLevel: 'beginner' as const, targetLevel: 'intermediate' as const, recommendation: 'promote' as const };
  assert.deepEqual(levelAfterApproval(promo, 'beginner'), { changes: true, to: 'intermediate' });
  assert.deepEqual(levelAfterApproval(promo, 'intermediate'), { stale: true }, 'someone already changed it');
  assert.deepEqual(levelAfterApproval({ ...promo, recommendation: 'stay', targetLevel: 'beginner' }, 'beginner'), { changes: false });
  assert.deepEqual(levelAfterApproval({ ...promo, recommendation: 'further_assessment', targetLevel: 'beginner' }, 'advanced'), { changes: false });
});
