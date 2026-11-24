import { DEFAULT_POLICY, MS } from "../src/index.ts";
import type { Booking, Horse, LedgerEntry, Occurrence, Rider } from "../src/index.ts";

export const NOW = Date.UTC(2026, 10, 23, 10, 0); // Mon 23 Nov 2026 10:00 UTC
export const policy = { ...DEFAULT_POLICY };
export const at = (daysFromNow: number, hour = 16) => Date.UTC(2026, 10, 23 + daysFromNow, hour, 0);

export const rider = (o: Partial<Rider> = {}): Rider => ({
  id: "r1", status: "active", level: "intermediate", dateOfBirth: Date.UTC(2016, 2, 14), guardianId: "g1",
  medicalFormExpiresAt: at(120), waiverSignedAt: at(-20), ...o,
});

export const occ = (o: Partial<Occurrence> = {}): Occurrence => ({
  id: "o1", startsAt: at(8), endsAt: at(8, 17), capacity: 6, arenaId: "a3", coachId: "c1", minLevel: "beginner",
  status: "published", format: "group", priceMinor: 20_000, ...o,
});

export const booking = (o: Partial<Booking> = {}): Booking => ({
  id: "b1", riderId: "r1", occurrenceId: "o1", status: "confirmed", payWith: "package", packageId: "p1", createdAt: NOW - MS.day, ...o,
});

export const horse = (o: Partial<Horse> = {}): Horse => ({
  id: "h1", status: "available", suitableLevels: ["beginner", "intermediate"], suitableArenaIds: ["a2", "a3"], ...o,
});

export const entry = (o: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "e1", packageId: "p1", delta: 20, reason: "purchase", refKey: "purchase:p1", at: NOW - 30 * MS.day, by: "system", ...o,
});
