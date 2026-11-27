export interface Occurrence {
  id: string; title: string; format: string; minLevel: string; status: string; capacity: number; priceMinor: number;
  arenaId: string; arenaName: string; coachId: string; coachName: string; rideTypeId: string | null; minAgeYears: number | null;
  startsAt: string; endsAt: string; seriesId?: string | null; booked: number; horses: string | null;
}
export interface Rider { id: string; fullName: string; dateOfBirth: string; level: string; status: string; isWalkIn: boolean; createdAt: string }
export interface RiderDetail extends Rider {
  branchId: string; accountId: string | null; medicalNotes: string | null; allergies: string | null;
  emergencyContact: { name: string; phone: string; relationship?: string } | null;
  heightCm: number | null; weightKg: number | null; ridingExperience: string | null; preferences: string | null; restrictions: string | null; phone: string | null; email: string | null;
  restrictedFrom: string | null; restrictedUntil: string | null;
}
export interface RosterBooking { number: string; attendance: string | null; horseId: string | null; outcome: string | null; skillIds: string[]; notes: string | null; id: string; status: string; payWith: string; createdAt: string; riderId: string; riderName: string; level: string; source: string; holdExpiresAt: string | null; owedMinor: number | null }
export interface WaitEntry { id: string; status: string; joinedAt: string; offerExpiresAt: string | null; riderId: string; riderName: string }
export interface Arena {
  id: string; name: string; maxCapacity: number; supportedLevels: string[]; kind: string | null; surface: string | null; activities: string | null;
  lengthM: number | null; widthM: number | null; sharedUse: boolean; opensAt: string | null; closesAt: string | null;
}
export interface Staff { id: string; fullName: string; role: string }
export interface Horse {
  id: string; name: string; status: string; suitableLevels: string[]; arenaIds: string[]; notes: string | null; owner: string | null; stable: string | null; stall: string | null;
  maxRiderWeightKg: number | null; minRiderAge: number | null; maxSessionsPerDay: number | null; maxSessionsPerWeek: number | null; formats: string[]; nextCareDue: string | null;
}
export interface RideType {
  id: string; name: string; description: string | null; priceMinor: number; durationMinutes: number; capacity: number; minLevel: string;
  minAgeYears: number | null; active: boolean; activeFrom: string | null; activeTo: string | null;
  arenaId: string | null; maxRiderWeightKg: number | null; bookUntilHours: number | null; cancelHours: number | null; horseRequired: boolean;
  rates: { id: string; fromDate: string; priceMinor: number; durationMinutes: number }[];
}
export interface ClassType {
  id: string; name: string; format: string; discipline: string | null; durationMinutes: number; capacity: number; minLevel: string; minAgeYears: number | null; maxAgeYears: number | null;
  priceMinor: number; prerequisites: string | null; cancelHours: number | null; singleVisit: boolean; active: boolean;
}
export interface PackageType {
  id: string; name: string; classes: number; priceMinor: number; validDays: number; classFormats: string[]; active: boolean;
  rideTypeIds: string[]; arenaIds: string[]; levels: string[]; fromTime: string | null; toTime: string | null; family: boolean;
}
export interface Receipt {
  id: string; number: string; amountMinor: number; vatMinor: number; method: string; issuedAt: string;
  riderId: string; riderName: string; forBookingId: string | null; forPackageId: string | null; issuedBy: string | null; terminalRef?: string | null;
  seller?: { name: string; taxNumber: string | null; address: string | null; phone: string | null; email: string | null; branchName: string };
}
