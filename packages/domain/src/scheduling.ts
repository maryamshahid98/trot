import type { Blackout, Occurrence, Reason } from "./types.ts";

export interface Override {
  reason: string;
  byRole: "reception" | "manager" | "owner";
  byUserId: string;
}

/** Problems that are never allowed, with or without an override. */
const HARD = new Set(["BAD_TIME", "BAD_CAPACITY", "IN_THE_PAST"]);

/** What the branch and the arena allow. Anything left out is not checked. */
export interface SiteRules {
  arenaCapacity?: number;
  arenaLevels?: readonly string[];
  minLevel?: string;
  outsideOpeningHours?: boolean;
  onHoliday?: boolean;
  /** Pass the current time to refuse a session that has already started. */
  now?: number;
  /** A shared arena takes several sessions at once, as long as the places add up to no more than it holds. */
  arenaShared?: boolean;
  outsideArenaHours?: boolean;
  /** Anything else already worked out that stands in the way (the instructor's qualifications and hours). */
  extra?: readonly Reason[];
}

export function validateOccurrence(
  candidate: Pick<Occurrence, "id" | "startsAt" | "endsAt" | "capacity" | "arenaId" | "coachId">,
  existing: readonly Occurrence[],
  blackouts: readonly Blackout[],
  site: SiteRules = {},
): Reason[] {
  const reasons: Reason[] = [];
  const add = (code: string, message: string) => reasons.push({ code, message });
  const overlaps = (a: { startsAt: number; endsAt: number }, b: { startsAt: number; endsAt: number }) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

  if (candidate.endsAt <= candidate.startsAt) add("BAD_TIME", "The end time must be after the start time.");
  if (!Number.isInteger(candidate.capacity) || candidate.capacity < 1) add("BAD_CAPACITY", "Capacity must be at least 1.");

  if (site.now !== undefined && candidate.startsAt <= site.now) add("IN_THE_PAST", "The start time has already passed.");
  if (site.arenaCapacity !== undefined && candidate.capacity > site.arenaCapacity) add("ARENA_CAPACITY", `The arena holds at most ${site.arenaCapacity} riders.`);
  if (site.arenaLevels && site.minLevel && !site.arenaLevels.includes(site.minLevel)) add("ARENA_LEVEL", `The arena is not approved for ${site.minLevel} riders.`);
  if (site.outsideOpeningHours) add("OUTSIDE_HOURS", "This is outside the branch's opening hours.");
  if (site.onHoliday) add("HOLIDAY", "The branch is closed for a holiday that day.");

  const live = existing.filter((o) => o.id !== candidate.id && o.status !== "cancelled");
  const sameArena = live.filter((o) => o.arenaId === candidate.arenaId && overlaps(o, candidate));
  if (!site.arenaShared) {
    if (sameArena.length) add("ARENA_OVERLAP", "The arena is already booked at this time.");
  } else if (site.arenaCapacity !== undefined && sameArena.reduce((n, o) => n + o.capacity, candidate.capacity) > site.arenaCapacity) {
    add("ARENA_SHARED_FULL", `Together these sessions need more than the ${site.arenaCapacity} places the arena holds.`);
  }
  if (site.outsideArenaHours) add("OUTSIDE_ARENA_HOURS", "This is outside the arena's hours.");
  reasons.push(...(site.extra ?? []));
  if (live.some((o) => o.coachId === candidate.coachId && overlaps(o, candidate))) add("COACH_OVERLAP", "The coach already has a class at this time.");

  for (const b of blackouts) {
    if (!(candidate.startsAt < b.to && b.from < candidate.endsAt)) continue;
    if (b.kind === "arena_closure" && b.targetId === candidate.arenaId) add("ARENA_CLOSED", "The arena is closed at this time.");
    if (b.kind === "coach_unavailable" && b.targetId === candidate.coachId) add("COACH_UNAVAILABLE", "The coach is not available at this time.");
  }
  return reasons;
}

/** An override needs a manager or owner and a written reason, and can never waive impossible times or capacities. */
export function canOverride(reasons: readonly Reason[], override?: Override): { ok: boolean; message?: string } {
  if (reasons.length === 0) return { ok: true };
  if (reasons.some((r) => HARD.has(r.code))) return { ok: false, message: "These problems cannot be overridden." };
  if (!override) return { ok: false, message: "An override is needed." };
  if (override.byRole === "reception") return { ok: false, message: "Only a manager or owner can override." };
  if (!override.reason.trim()) return { ok: false, message: "A reason is required." };
  return { ok: true };
}
