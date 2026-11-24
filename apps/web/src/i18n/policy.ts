/** Plain-language names and help for each booking rule. English only for now. */
export const POLICY_TEXT: Record<string, { label: string; hint: string }> = {
  freeCancelHoursBefore: { label: 'Free cancellation (hours before start)', hint: 'Cancelling earlier than this returns the class.' },
  officeHoldMinutes: { label: 'Hold for office payment (minutes)', hint: 'An unpaid office booking is released after this time.' },
  waitlistOfferMinutes: { label: 'Waitlist offer lasts (minutes)', hint: 'How long a rider has to accept a free place.' },
  maxBookingsPerRiderPerDay: { label: 'Most bookings per rider per day', hint: '' },
  guardianRequiredUnderAge: { label: 'Guardian required under age', hint: 'Riders younger than this need a linked guardian.' },
  horseMaxSessionsPerDay: { label: 'Most sessions per horse per day', hint: '' },
  horseMaxSessionsPerWeek: { label: 'Most sessions per horse per week', hint: '' },
  horseMinRestBetweenMinutes: { label: 'Rest between a horse’s sessions (minutes)', hint: '' },
  adjustmentManagerThresholdMinor: { label: 'Refund amount a manager may approve (halalas)', hint: 'Owner only. Larger amounts need an owner.' },
  lateCancelConsumesClass: { label: 'Late cancellation uses up the class', hint: '' },
  noShowConsumesClass: { label: 'No-show uses up the class', hint: '' },
  allowManagerUnpaidConfirmation: { label: 'Managers may confirm a rider without payment', hint: 'Owner only.' },
  requireMedicalForm: { label: 'Medical form required to book', hint: '' },
  requireWaiver: { label: 'Waiver required to book', hint: '' },
  horseSelection: { label: 'Who chooses the horse', hint: '' },
};
