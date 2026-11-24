export interface Occurrence {
  id: string; title: string; format: string; minLevel: string; status: string; capacity: number; priceMinor: number;
  arenaId: string; arenaName: string; coachId: string; coachName: string; rideTypeId: string | null; minAgeYears: number | null;
  startsAt: string; endsAt: string;
}
export interface Rider { id: string; fullName: string; dateOfBirth: string; level: string; status: string; isWalkIn: boolean; createdAt: string }
export interface RiderDetail extends Rider {
  branchId: string; accountId: string | null; medicalNotes: string | null; allergies: string | null;
  emergencyContact: { name: string; phone: string; relationship?: string } | null;
}
export interface RosterBooking { id: string; status: string; payWith: string; createdAt: string; riderId: string; riderName: string; level: string }
export interface WaitEntry { id: string; status: string; joinedAt: string; offerExpiresAt: string | null; riderId: string; riderName: string }
export interface Arena { id: string; name: string; maxCapacity: number }
export interface Staff { id: string; fullName: string; role: string }
export interface Horse { id: string; name: string; status: string; suitableLevels: string[]; arenaIds: string[]; notes: string | null }
export interface RideType {
  id: string; name: string; description: string | null; priceMinor: number; durationMinutes: number; capacity: number; minLevel: string;
  minAgeYears: number | null; active: boolean; activeFrom: string | null; activeTo: string | null;
}
export interface PackageType { id: string; name: string; classes: number; priceMinor: number; validDays: number; classFormats: string[]; active: boolean }
export interface Receipt {
  id: string; number: string; amountMinor: number; vatMinor: number; method: string; issuedAt: string;
  riderId: string; riderName: string; forBookingId: string | null; forPackageId: string | null; issuedBy: string | null;
}
