import type { Horse, HorseAssignment, Level, Occurrence, Reason } from "./types.ts";
import type { Policy } from "./policy.ts";
import { MS } from "./policy.ts";
import { utcDayKey } from "./eligibility.ts";

/** Club week starting Saturday (Unix epoch day 0 is a Thursday, so shift by 2 days). Override per branch if needed. */
export const saturdayWeekKey = (ms: number) => String(Math.floor((ms - 2 * MS.day) / MS.week));

export interface HorseCheckInput {
  horse: Horse;
  occurrence: Occurrence;
  /** Levels of the riders who will ride this horse in the class. */
  riderLevels: Level[];
  /** Every other assignment of this horse (any day). */
  assignments: readonly HorseAssignment[];
  policy: Policy;
  dayKeyOf?: (ms: number) => string;
  weekKeyOf?: (ms: number) => string;
}

export function checkHorse(i: HorseCheckInput): { allowed: boolean; reasons: Reason[] } {
  const { horse, occurrence: occ, policy } = i;
  const dayKeyOf = i.dayKeyOf ?? utcDayKey;
  const weekKeyOf = i.weekKeyOf ?? saturdayWeekKey;
  const reasons: Reason[] = [];
  const add = (code: string, message: string) => reasons.push({ code, message });

  if (horse.status !== "available") add("HORSE_UNAVAILABLE", `Horse is ${horse.status.replace("_", " ")}.`);
  if (!horse.suitableArenaIds.includes(occ.arenaId)) add("ARENA_UNSUITABLE", "This horse is not approved for this arena.");
  if (i.riderLevels.some((l) => !horse.suitableLevels.includes(l))) add("LEVEL_UNSUITABLE", "This horse is not suitable for every rider's level.");

  const others = i.assignments.filter((a) => a.occurrenceId !== occ.id);
  if (others.some((a) => a.startsAt < occ.endsAt && occ.startsAt < a.endsAt)) add("HORSE_OVERLAP", "The horse is already working at this time.");

  const gap = policy.horseMinRestBetweenMinutes * MS.minute;
  const tooClose = others.some((a) => !(a.startsAt < occ.endsAt && occ.startsAt < a.endsAt) && (a.endsAt <= occ.startsAt ? occ.startsAt - a.endsAt < gap : a.startsAt - occ.endsAt < gap));
  if (tooClose) add("HORSE_REST_GAP", `The horse needs ${policy.horseMinRestBetweenMinutes} minutes of rest between sessions.`);

  const day = others.filter((a) => dayKeyOf(a.startsAt) === dayKeyOf(occ.startsAt)).length;
  if (day + 1 > policy.horseMaxSessionsPerDay) add("HORSE_DAILY_LIMIT", `Limit of ${policy.horseMaxSessionsPerDay} sessions a day reached.`);
  const week = others.filter((a) => weekKeyOf(a.startsAt) === weekKeyOf(occ.startsAt)).length;
  if (week + 1 > policy.horseMaxSessionsPerWeek) add("HORSE_WEEKLY_LIMIT", `Limit of ${policy.horseMaxSessionsPerWeek} sessions a week reached.`);

  return { allowed: reasons.length === 0, reasons };
}
