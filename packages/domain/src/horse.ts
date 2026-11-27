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
  /** The riders themselves, for the horse's weight and age limits. */
  riders?: readonly { weightKg?: number; ageYears?: number }[];
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

  if (horse.formats?.length && !horse.formats.includes(occ.format)) add("HORSE_NOT_FOR_THIS_WORK", "This horse is not used for this kind of class or ride.");
  const riders = i.riders ?? [];
  const maxKg = horse.maxRiderWeightKg;
  if (maxKg !== undefined) {
    // An unknown weight cannot be assumed to be safe.
    if (riders.some((r) => r.weightKg === undefined)) add("RIDER_WEIGHT_UNKNOWN", `Record every rider's weight: this horse carries at most ${maxKg} kg.`);
    if (riders.some((r) => r.weightKg !== undefined && r.weightKg > maxKg)) add("RIDER_TOO_HEAVY", `This horse carries at most ${maxKg} kg.`);
  }
  const minAge = horse.minRiderAge;
  if (minAge !== undefined && riders.some((r) => r.ageYears !== undefined && r.ageYears < minAge)) add("RIDER_TOO_YOUNG_FOR_HORSE", `Riders of this horse must be at least ${minAge}.`);

  const others = i.assignments.filter((a) => a.occurrenceId !== occ.id);
  if (others.some((a) => a.startsAt < occ.endsAt && occ.startsAt < a.endsAt)) add("HORSE_OVERLAP", "The horse is already working at this time.");

  const gap = policy.horseMinRestBetweenMinutes * MS.minute;
  const tooClose = others.some((a) => !(a.startsAt < occ.endsAt && occ.startsAt < a.endsAt) && (a.endsAt <= occ.startsAt ? occ.startsAt - a.endsAt < gap : a.startsAt - occ.endsAt < gap));
  if (tooClose) add("HORSE_REST_GAP", `The horse needs ${policy.horseMinRestBetweenMinutes} minutes of rest between sessions.`);

  const day = others.filter((a) => dayKeyOf(a.startsAt) === dayKeyOf(occ.startsAt)).length;
  const perDay = horse.maxSessionsPerDay ?? policy.horseMaxSessionsPerDay;
  if (day + 1 > perDay) add("HORSE_DAILY_LIMIT", `Limit of ${perDay} sessions a day reached.`);
  const week = others.filter((a) => weekKeyOf(a.startsAt) === weekKeyOf(occ.startsAt)).length;
  const perWeek = horse.maxSessionsPerWeek ?? policy.horseMaxSessionsPerWeek;
  if (week + 1 > perWeek) add("HORSE_WEEKLY_LIMIT", `Limit of ${perWeek} sessions a week reached.`);

  return { allowed: reasons.length === 0, reasons };
}
