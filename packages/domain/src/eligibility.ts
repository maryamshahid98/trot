import type { Booking, Occurrence, PayWith, Reason, Rider } from "./types.ts";
import { LEVEL_ORDER } from "./types.ts";
import type { Policy } from "./policy.ts";
import { MS } from "./policy.ts";

const YEAR_MS = 365.2425 * MS.day;
export const utcDayKey = (ms: number) => String(Math.floor(ms / MS.day));

/** A booking holds a place unless it is cancelled/no-show, or its pay-at-office hold has expired. */
export function holdsPlace(b: Booking, now: number, policy: Policy): boolean {
  switch (b.status) {
    case "confirmed":
    case "checked_in":
    case "completed":
      return true;
    case "pending_office_payment":
      return b.createdAt + policy.officeHoldMinutes * MS.minute > now;
    default:
      return false;
  }
}

export interface EligibilityInput {
  rider: Rider;
  occurrence: Occurrence;
  now: number;
  policy: Policy;
  payWith: PayWith;
  /** Package balance for the rider's chosen package (only used when payWith is "package"). */
  packageBalance?: number;
  /** All of this rider's bookings with their occurrences. */
  riderBookings: { booking: Booking; occurrence: Occurrence }[];
  /** True when the chosen package names this ride type. Without it a package never pays for a ride. */
  rideCovered?: boolean;
  /** Day grouping, so branches in other time zones count "per day" correctly. Defaults to UTC days. */
  dayKeyOf?: (ms: number) => string;
}

export interface EligibilityResult {
  allowed: boolean;
  reasons: Reason[];
}

/**
 * The required documents that will not be valid for this class (BR-023). Used when booking and again at check-in,
 * because a medical clearance can expire, or a new waiver be published, in between.
 */
export function documentReasons(rider: Rider, occ: Occurrence, policy: Policy): Reason[] {
  const reasons: Reason[] = [];
  const add = (code: string, message: string) => reasons.push({ code, message });
  if (policy.requireMedicalForm) {
    if (rider.medicalFormExpiresAt === undefined) add("MEDICAL_MISSING", "A medical form is needed.");
    else if (rider.medicalFormExpiresAt < occ.startsAt) add("MEDICAL_EXPIRED", "The medical form will have expired by this class.");
  }
  if (policy.requireWaiver && rider.waiverSignedAt === undefined) add("WAIVER_MISSING", "The waiver has not been signed.");
  return reasons;
}

/** Why a rider may not book this class. Returns every reason at once so the app can explain them all. */
export function checkEligibility(i: EligibilityInput): EligibilityResult {
  const { rider, occurrence: occ, now, policy } = i;
  const dayKeyOf = i.dayKeyOf ?? utcDayKey;
  const reasons: Reason[] = [];
  const add = (code: string, message: string) => reasons.push({ code, message });

  if (rider.status !== "active") add("RIDER_NOT_ACTIVE", "This rider is not approved yet.");
  if (occ.status !== "published") add("CLASS_NOT_BOOKABLE", "This class is not open for booking.");
  if (occ.startsAt <= now) add("CLASS_STARTED", "This class has already started.");

  if (LEVEL_ORDER[rider.level] < LEVEL_ORDER[occ.minLevel]) {
    add("LEVEL_TOO_LOW", `This class needs ${occ.minLevel} level.`);
  }

  reasons.push(...documentReasons(rider, occ, policy));

  const age = (now - rider.dateOfBirth) / YEAR_MS;
  // A ride may set its own youngest age. It is judged on the day of the ride, not today.
  if (occ.minAgeYears !== undefined && occ.minAgeYears !== null && (occ.startsAt - rider.dateOfBirth) / YEAR_MS < occ.minAgeYears) {
    add("RIDER_TOO_YOUNG", `Riders must be at least ${occ.minAgeYears} years old for this ride.`);
  }
  if (age < policy.guardianRequiredUnderAge && !rider.guardianId) add("GUARDIAN_REQUIRED", "A guardian must be linked to this rider.");
  if (age < policy.guardianRequiredUnderAge && rider.hasEmergencyContact === false) add("EMERGENCY_CONTACT_REQUIRED", "An emergency contact is needed for this rider.");

  const active = i.riderBookings.filter(({ booking }) => holdsPlace(booking, now, policy));
  if (active.some(({ booking }) => booking.occurrenceId === occ.id)) add("DUPLICATE_BOOKING", "Already booked in this class.");
  if (active.some(({ occurrence: o }) => o.id !== occ.id && o.startsAt < occ.endsAt && occ.startsAt < o.endsAt)) {
    add("RIDER_OVERLAP", "This overlaps another booking for the same rider.");
  }
  const sameDay = active.filter(({ occurrence: o }) => o.id !== occ.id && dayKeyOf(o.startsAt) === dayKeyOf(occ.startsAt)).length;
  if (sameDay + 1 > policy.maxBookingsPerRiderPerDay) add("DAILY_LIMIT", "Too many classes booked on that day.");

  // A class package never pays for a ride. Rides are paid at the office (BR-034, BR-035).
  if (occ.maxAgeYears != null && Math.floor((occ.startsAt - rider.dateOfBirth) / YEAR_MS) > occ.maxAgeYears) add("RIDER_TOO_OLD", `Riders must be ${occ.maxAgeYears} or younger.`);
  if (occ.maxRiderWeightKg != null) {
    if (rider.weightKg === undefined) add("RIDER_WEIGHT_REQUIRED", `Record the rider's weight: the limit is ${occ.maxRiderWeightKg} kg.`);
    else if (rider.weightKg > occ.maxRiderWeightKg) add("RIDER_OVER_WEIGHT", `The weight limit is ${occ.maxRiderWeightKg} kg.`);
  }
  if (occ.bookUntilHours != null && now > occ.startsAt - occ.bookUntilHours * MS.hour && occ.startsAt > now) add("BOOKING_CLOSED", `Booking closed ${occ.bookUntilHours} hours before the start.`);
  if (i.payWith === "package" && occ.singleVisit) add("SINGLE_VISIT_NO_PACKAGE", "A one-off visit is paid by itself, not from a package.");

  if (i.payWith === "package" && occ.format === "ride" && !i.rideCovered) add("RIDE_NOT_IN_PACKAGE", "A class package does not cover rides. Choose pay at the office.");
  else if (i.payWith === "package" && (i.packageBalance ?? 0) <= 0) add("NO_PACKAGE_BALANCE", "No classes left in the package.");

  return { allowed: reasons.length === 0, reasons };
}
