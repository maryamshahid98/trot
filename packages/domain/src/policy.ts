// Every rule that the club may change is a setting here, not a constant in code.
// Defaults reflect the working assumptions for open decisions OD-02..OD-06, OD-14.
// Times in minutes unless named otherwise.

export interface Policy {
  /** OD-06: customer may cancel free up to this many hours before start. */
  freeCancelHoursBefore: number;
  /** OD-06: whether a late cancellation consumes the class. */
  lateCancelConsumesClass: boolean;
  /** No-show consumes the class. */
  noShowConsumesClass: boolean;
  /** OD-04: how long a pay-at-office booking holds the place. */
  officeHoldMinutes: number;
  /** OD-14: whether an unpaid pay-at-office booking can be confirmed by a manager. */
  allowManagerUnpaidConfirmation: boolean;
  /** Waitlist offer lifetime. */
  waitlistOfferMinutes: number;
  /** Max active bookings one rider may hold starting on the same calendar day (UTC day computed by caller). */
  maxBookingsPerRiderPerDay: number;
  /** OD-07: documents required before booking. */
  requireMedicalForm: boolean;
  requireWaiver: boolean;
  /** OD-01: under this age a guardian is required. */
  guardianRequiredUnderAge: number;
  /** OD-03: horse workload measured in sessions. */
  horseMaxSessionsPerDay: number;
  horseMaxSessionsPerWeek: number;
  horseMinRestBetweenMinutes: number;
  /** OD-02: who picks the horse. */
  horseSelection: "staff_assigns" | "customer_chooses_with_approval";
  /** Refund/adjustment above this amount (minor units) needs a manager. */
  adjustmentManagerThresholdMinor: number;
}

export const DEFAULT_POLICY: Policy = {
  freeCancelHoursBefore: 24,
  lateCancelConsumesClass: true,
  noShowConsumesClass: true,
  officeHoldMinutes: 10,
  allowManagerUnpaidConfirmation: true,
  waitlistOfferMinutes: 120,
  maxBookingsPerRiderPerDay: 2,
  requireMedicalForm: true,
  requireWaiver: true,
  guardianRequiredUnderAge: 18,
  horseMaxSessionsPerDay: 3,
  horseMaxSessionsPerWeek: 15,
  horseMinRestBetweenMinutes: 60,
  horseSelection: "staff_assigns",
  adjustmentManagerThresholdMinor: 50_000, // SAR 500.00
};

export const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 } as const;
