import type { Blackout, Occurrence, Reason } from "./types.ts";

export interface Override {
  reason: string;
  byRole: "reception" | "manager" | "owner";
  byUserId: string;
}

/** Problems that are never allowed, with or without an override. */
const HARD = new Set(["BAD_TIME", "BAD_CAPACITY"]);

export function validateOccurrence(
  candidate: Pick<Occurrence, "id" | "startsAt" | "endsAt" | "capacity" | "arenaId" | "coachId">,
  existing: readonly Occurrence[],
  blackouts: readonly Blackout[],
): Reason[] {
  const reasons: Reason[] = [];
  const add = (code: string, message: string) => reasons.push({ code, message });
  const overlaps = (a: { startsAt: number; endsAt: number }, b: { startsAt: number; endsAt: number }) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

  if (candidate.endsAt <= candidate.startsAt) add("BAD_TIME", "The end time must be after the start time.");
  if (!Number.isInteger(candidate.capacity) || candidate.capacity < 1) add("BAD_CAPACITY", "Capacity must be at least 1.");

  const live = existing.filter((o) => o.id !== candidate.id && o.status !== "cancelled");
  if (live.some((o) => o.arenaId === candidate.arenaId && overlaps(o, candidate))) add("ARENA_OVERLAP", "The arena is already booked at this time.");
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
