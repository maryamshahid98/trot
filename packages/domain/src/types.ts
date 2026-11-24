// Plain data types shared by the rules engine. No framework, no database.
// All instants are epoch milliseconds in UTC. Branch time zones are applied at the edges (API/UI), never here.

export type Id = string;

export type Level = "beginner" | "intermediate" | "advanced";
export const LEVEL_ORDER: Record<Level, number> = { beginner: 0, intermediate: 1, advanced: 2 };

export type RiderStatus = "draft" | "pending_review" | "active" | "restricted" | "suspended" | "inactive" | "archived";

export interface Rider {
  id: Id;
  status: RiderStatus;
  level: Level;
  dateOfBirth: number; // epoch ms
  guardianId?: Id;
  medicalFormExpiresAt?: number; // undefined = never provided
  waiverSignedAt?: number;
}

export type OccurrenceStatus = "draft" | "published" | "in_progress" | "completed" | "cancelled";

export interface Occurrence {
  id: Id;
  startsAt: number;
  endsAt: number;
  capacity: number;
  arenaId: Id;
  coachId: Id;
  minLevel: Level;
  status: OccurrenceStatus;
  format: "private" | "semi_private" | "group" | "trial" | "camp" | "assessment" | "open_riding" | "ride";
  priceMinor: number; // minor units (halalas)
  /** Rides only: the youngest age, in whole years, on the day of the ride. Copied from the ride type when the ride is scheduled. */
  minAgeYears?: number;
}

export type BookingStatus =
  | "pending_office_payment"
  | "confirmed"
  | "checked_in"
  | "completed"
  | "cancelled"
  | "no_show";

export type PayWith = "package" | "office";

export interface Booking {
  id: Id;
  riderId: Id;
  occurrenceId: Id;
  status: BookingStatus;
  payWith: PayWith;
  packageId?: Id;
  createdAt: number;
}

export interface Horse {
  id: Id;
  status: "available" | "resting" | "reserved" | "under_training" | "medical_hold" | "injured" | "retired";
  suitableLevels: Level[];
  suitableArenaIds: Id[];
}

export interface HorseAssignment {
  horseId: Id;
  occurrenceId: Id;
  startsAt: number;
  endsAt: number;
}

export type LedgerReason = "purchase" | "use" | "return" | "adjustment" | "expiry";
export interface LedgerEntry {
  id: Id;
  packageId: Id;
  delta: number; // classes; negative = used
  reason: LedgerReason;
  /** Idempotency key: the same key can only ever be applied once per package. */
  refKey: string;
  at: number;
  by: string; // "system" or a user id
  note?: string;
}

export interface Blackout {
  id: Id;
  kind: "arena_closure" | "coach_unavailable";
  targetId: Id; // arena id or coach id
  from: number;
  to: number;
}

export type Reason = { code: string; message: string };
