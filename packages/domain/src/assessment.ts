// Promotion rules: when may an assessment recommend a higher level, and what happens to the rider's level. Pure code, no database.
import { LEVEL_ORDER } from "./types.ts";
import type { Level } from "./types.ts";

export type Recommendation = "promote" | "stay" | "further_assessment";

/** Each skill is rated 1 (not yet) to 5 (confident). A rating at or above the pass mark counts as shown. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const DEFAULT_PASS_RATING = 3;

const ORDERED = (Object.keys(LEVEL_ORDER) as Level[]).sort((a, b) => LEVEL_ORDER[a] - LEVEL_ORDER[b]);

/** The level above this one, or null for the highest. */
export function nextLevel(level: Level): Level | null {
  return ORDERED[LEVEL_ORDER[level] + 1] ?? null;
}

export interface RequiredSkill { id: string; name: string }
export interface SkillRating { skillId: string; rating: number }
export interface UnmetSkills { missing: string[]; belowPass: string[] }

/** Which of the skills needed for the next level have not been rated, or were rated below the pass mark. Names are returned, for messages. */
export function unmetSkills(required: readonly RequiredSkill[], ratings: readonly SkillRating[], passRating: number = DEFAULT_PASS_RATING): UnmetSkills {
  const byId = new Map(ratings.map((r) => [r.skillId, r.rating]));
  const missing: string[] = [];
  const belowPass: string[] = [];
  for (const s of required) {
    const r = byId.get(s.id);
    if (r === undefined) missing.push(s.name);
    else if (r < passRating) belowPass.push(s.name);
  }
  return { missing, belowPass };
}

export interface AssessmentCheck { ok: boolean; reasons: string[] }

/**
 * Whether an assessment may be submitted for approval.
 *  - promote: the target must be exactly one level up, every skill the club requires for that level must be rated and passed.
 *    If the club has set up no skills for that level, written notes are required instead (so a promotion is never a bare click).
 *  - stay / further_assessment: the level does not change, and the reasons must be written down.
 */
export function checkAssessment(a: {
  fromLevel: Level; targetLevel: Level; recommendation: Recommendation; notes: string | null | undefined;
  requiredSkills: readonly RequiredSkill[]; ratings: readonly SkillRating[]; passRating?: number;
}): AssessmentCheck {
  const reasons: string[] = [];
  const hasNotes = (a.notes ?? "").trim().length > 0;
  if (a.recommendation === "promote") {
    if (nextLevel(a.fromLevel) !== a.targetLevel) reasons.push(`A promotion goes exactly one level up, from ${a.fromLevel} to ${nextLevel(a.fromLevel) ?? "(there is no higher level)"}.`);
    if (a.requiredSkills.length === 0) {
      if (!hasNotes) reasons.push(`No skills are set up for ${a.targetLevel}, so the assessor's notes are required to justify the promotion.`);
    } else {
      const u = unmetSkills(a.requiredSkills, a.ratings, a.passRating ?? DEFAULT_PASS_RATING);
      if (u.missing.length) reasons.push(`Not yet rated: ${u.missing.join(", ")}.`);
      if (u.belowPass.length) reasons.push(`Below the pass mark: ${u.belowPass.join(", ")}.`);
    }
  } else {
    if (a.targetLevel !== a.fromLevel) reasons.push("The level does not change, so the target level must stay the same.");
    if (!hasNotes) reasons.push("Say in the notes why the level stays the same or why more assessment is needed.");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * What approving does to the rider. Approving a promotion moves the rider to the target level, but only if the rider is still at the
 * level the assessment started from (another change may have happened meanwhile). Any other approval leaves the level alone.
 */
export function levelAfterApproval(a: { fromLevel: Level; targetLevel: Level; recommendation: Recommendation }, currentLevel: Level):
  | { changes: false }
  | { changes: true; to: Level }
  | { stale: true } {
  if (a.recommendation !== "promote") return { changes: false };
  if (currentLevel !== a.fromLevel) return { stale: true };
  return { changes: true, to: a.targetLevel };
}
