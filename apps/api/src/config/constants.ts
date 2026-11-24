// Named constants: values that are part of the product's rules or of the database schema.
// Deployment settings (secrets, URLs, timeouts that differ per environment) are NOT here. They live in env.ts.
// A test (test/constants.int.test.ts) checks the lists below against the database enums, so they cannot drift apart.

export const ROLE = {
  CUSTOMER: 'customer',
  COACH: 'coach',
  STABLE_HAND: 'stable_hand',
  RECEPTION: 'reception',
  MANAGER: 'manager',
  OWNER: 'owner',
} as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];
export const ROLES = Object.values(ROLE);

export const ACCOUNT_STATUS = { ACTIVE: 'active', LOCKED: 'locked', DELETED: 'deleted' } as const;
/** The statuses an administrator may set. Deletion belongs to the erase process, not to this screen. */
export const SETTABLE_ACCOUNT_STATUSES = [ACCOUNT_STATUS.ACTIVE, ACCOUNT_STATUS.LOCKED] as const;
export const LEAVE_STATUS = { REQUESTED: 'requested', APPROVED: 'approved', REJECTED: 'rejected' } as const;
export const LEAVE_STATUSES = Object.values(LEAVE_STATUS);
export const OCCURRENCE_STATUS = { DRAFT: 'draft', PUBLISHED: 'published', IN_PROGRESS: 'in_progress', COMPLETED: 'completed', CANCELLED: 'cancelled' } as const;
/** Statuses a new class may be created with. */
export const CREATABLE_OCCURRENCE_STATUSES = [OCCURRENCE_STATUS.DRAFT, OCCURRENCE_STATUS.PUBLISHED] as const;

/** The kinds of class a lesson schedule or a class package can name. A ride is a different thing and is not on this list. */
export const CLASS_FORMATS = ['private', 'semi_private', 'group', 'trial', 'camp', 'assessment', 'open_riding'] as const;
/** The format of a scheduled ride. Only rides made from a ride type carry it. */
export const RIDE_FORMAT = 'ride';
/** Everything the database's class_format enum holds. A test keeps this and the database in step. */
export const FORMATS = [...CLASS_FORMATS, RIDE_FORMAT] as const;
/** What the schedule can be asked to show. */
export const SCHEDULE_KIND = { CLASS: 'class', RIDE: 'ride' } as const;
export const SCHEDULE_KINDS = Object.values(SCHEDULE_KIND);
export const LEVELS = ['beginner', 'intermediate', 'advanced'] as const;

/** Any 8-4-4-4-12 hex id. The demo ids are not "version 4" uuids, so zod's own uuid() is too strict. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres error codes the API reacts to. */
export const PG_ERROR = {
  EXCLUSION_VIOLATION: '23P01',
  FOREIGN_KEY_VIOLATION: '23503',
  INSUFFICIENT_PRIVILEGE: '42501',
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514', // the ledger raises this when a balance would go below zero
} as const;

/** Audit log vocabulary. */
export const ENTITY = { ACCOUNT: 'account', OCCURRENCE: 'occurrence', BOOKING: 'booking', WAITLIST_ENTRY: 'waitlist_entry', RIDER: 'rider', DOCUMENT: 'document', PACKAGE_TYPE: 'package_type', PACKAGE: 'package', RECEIPT: 'receipt', ADJUSTMENT: 'adjustment', HORSE: 'horse', ASSIGNMENT: 'horse_assignment', BRANCH: 'branch', INCIDENT: 'incident', ARENA: 'arena', ARENA_CLOSURE: 'arena_closure', STAFF_LEAVE: 'staff_leave', RIDE_TYPE: 'ride_type' } as const;
export const AUDIT = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  REFRESH_REUSE_DETECTED: 'auth.refresh_reuse_detected',
  PASSWORD_CHANGED: 'auth.password_changed',
  OCCURRENCE_CREATE: 'occurrence.create',
  OCCURRENCE_CREATE_OVERRIDE: 'occurrence.create_override',
  BOOKING_CREATE: 'booking.create',
  BOOKING_WAITLIST: 'booking.waitlist',
  BOOKING_CANCEL: 'booking.cancel',
  RIDER_CREATE: 'rider.create',
  RIDER_UPDATE: 'rider.update',
  RIDER_LEVEL: 'rider.level',
  RIDER_STATUS: 'rider.status',
  GUARDIAN_ADD: 'guardian.add',
  GUARDIAN_REMOVE: 'guardian.remove',
  DOCUMENT_SUBMIT: 'document.submit',
  DOCUMENT_VERIFY: 'document.verify',
  DOCUMENT_REJECT: 'document.reject',
  BOOKING_CHECK_IN: 'booking.check_in',
  BOOKING_NO_SHOW: 'booking.no_show',
  BOOKING_HOLD_EXPIRED: 'booking.hold_expired',
  CLASS_COMPLETE: 'class.complete',
  CLASS_CANCEL: 'class.cancel',
  WAITLIST_OFFER: 'waitlist.offer',
  WAITLIST_ACCEPT: 'waitlist.accept',
  WAITLIST_LEAVE: 'waitlist.leave',
  PACKAGE_TYPE_CREATE: 'package_type.create',
  PACKAGE_TYPE_UPDATE: 'package_type.update',
  PACKAGE_SELL: 'package.sell',
  PACKAGE_ADJUST: 'package.adjust',
  PACKAGE_STATUS: 'package.status',
  PAYMENT_RECORD: 'payment.record',
  BOOKING_CONFIRM_UNPAID: 'booking.confirm_unpaid',
  ADJUSTMENT_CREATE: 'adjustment.create',
  ACCOUNT_CREATE: 'account.create',
  ACCOUNT_UPDATE: 'account.update',
  ACCOUNT_ROLE: 'account.role',
  ACCOUNT_STATUS: 'account.status',
  ACCOUNT_UNLOCK: 'account.unlock',
  ACCOUNT_PASSWORD_RESET: 'account.password_reset',
  ACCOUNT_BRANCHES: 'account.branches',
  BRANCH_UPDATE: 'branch.update',
  POLICY_UPDATE: 'branch.policy_update',
  ARENA_CREATE: 'arena.create',
  ARENA_UPDATE: 'arena.update',
  CLOSURE_CREATE: 'arena.closure_create',
  CLOSURE_DELETE: 'arena.closure_delete',
  LEAVE_CREATE: 'leave.create',
  LEAVE_DECIDE: 'leave.decide',
  LEAVE_CANCEL: 'leave.cancel',
  PACKAGE_EXPIRED: 'package.expire',
  INCIDENT_CREATE: 'incident.create',
  INCIDENT_STATUS: 'incident.status',
  HORSE_CREATE: 'horse.create',
  HORSE_UPDATE: 'horse.update',
  HORSE_STATUS: 'horse.status',
  HORSE_ASSIGN: 'horse.assign',
  HORSE_ASSIGN_OVERRIDE: 'horse.assign_override',
  HORSE_UNASSIGN: 'horse.unassign',
  RIDE_TYPE_CREATE: 'ride_type.create',
  RIDE_TYPE_UPDATE: 'ride_type.update',
} as const;

/** Input and output limits. */
export const LIMITS = {
  identifierMin: 3,
  identifierMax: 254,
  passwordMax: 256, // the longest password we will even try to check
  newPasswordMin: 10,
  newPasswordMax: 128,
  refreshTokenMin: 20,
  refreshTokenMax: 200,
  titleMax: 120,
  overrideReasonMax: 500,
  userAgentMax: 300,
  scheduleMaxRangeDays: 62,
  scheduleListLimit: 1000,
  bookingsListLimit: 200,
  checkInOpensMinutes: 60,
  receiptsListDefault: 50,
  receiptsListMax: 200,
  packageTypeNameMax: 120,
  packageClassesMax: 500,
  packageValidDaysMax: 1095,
  priceMaxMinor: 10_000_000,
  adjustClassesMax: 100,
  horseNameMax: 80,
  horseListMax: 500,
  workloadMaxRangeDays: 62,
  horseSuggestionsMax: 50,
  accountsListDefault: 50,
  accountsListMax: 200,
  phoneMin: 8,
  phoneMax: 15,
  arenaNameMax: 80,
  arenaCapacityMax: 100,
  closureMaxDays: 366,
  affectedClassesShown: 20,
  jobBatchSize: 500,
  reportMaxDays: 366,
  reportListMax: 200,
  auditListDefault: 50,
  auditListMax: 200,
  actionMax: 80,
  incidentKindMax: 80,
  incidentDescriptionMax: 2000,
  incidentsListDefault: 50,
  incidentsListMax: 200,
  rideTypeNameMax: 80,
  rideDescriptionMax: 1000,
  rideDurationMinMinutes: 5,
  rideDurationMaxMinutes: 600,
  rideMinAgeMax: 99,
  rideTypesListMax: 200,
  futureSkewMinutes: 5,
  ridersListDefault: 50,
  ridersListMax: 200,
  nameMax: 120,
  notesMax: 2000,
  fileRefMax: 500,
  reasonMax: 500,
  searchMax: 100,
  earliestBirthYear: 1900,
  jobAdvisoryLockKey: 7_301_001, // any fixed number; every API server uses the same one so only one runs the background job at a time
  rateLimitSweepChance: 0.01, // on about 1 in 100 rate-limited requests, delete the counters whose window has ended
} as const;

/** The test database is dropped and rebuilt on every run, so only a database whose name ends like this may be used for it. */
export const TEST_DATABASE_SUFFIX = '_test';

/** scrypt cost. The parameters are stored inside every hash, so raising them later does not break old passwords. */
export const SCRYPT = { N: 16384, R: 8, P: 1, keyLength: 64, saltBytes: 16 } as const;

/** Headers and CORS rules that are the same in every environment. */
export const CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";
export const CORS_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'];
export const CORS_HEADERS = ['authorization', 'content-type', 'x-trot-client'];

/**
 * The website keeps its refresh token in a cookie that scripts cannot read. It says it is the website with this header,
 * which a page on another site cannot send (the browser would first ask the API, and the API only allows listed sites).
 * The mobile apps leave the header out and keep using the token in the request and response body.
 */
export const CLIENT_HEADER = 'x-trot-client';
export const CLIENT_WEB = 'web';
export const REFRESH_COOKIE = {
  name: 'trot_refresh',
  path: '/auth', // sent only to the sign-in routes
  sameSite: 'strict' as const,
};
export const BEARER_PREFIX = 'Bearer ';

// ---------- bookings ----------
export const RIDER_STATUS = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  ACTIVE: 'active',
  RESTRICTED: 'restricted',
  SUSPENDED: 'suspended',
  INACTIVE: 'inactive',
  ARCHIVED: 'archived',
} as const;
export const RIDER_STATUSES = Object.values(RIDER_STATUS);
/** Statuses the API lets staff set directly. Archiving goes through the privacy process, never a button. */
export const SETTABLE_RIDER_STATUSES = [RIDER_STATUS.ACTIVE, RIDER_STATUS.RESTRICTED, RIDER_STATUS.SUSPENDED, RIDER_STATUS.INACTIVE] as const;
export const RELATION = { SELF: 'self', WARD: 'ward' } as const;
export const RELATIONS = [RELATION.SELF, RELATION.WARD] as const;
export const BOOKING_STATUS = {
  PENDING_OFFICE_PAYMENT: 'pending_office_payment',
  CONFIRMED: 'confirmed',
  CHECKED_IN: 'checked_in',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show',
} as const;
export const PAY_WITH_VALUES = ['package', 'office'] as const;
export const PAY_WITH = { PACKAGE: 'package', OFFICE: 'office' } as const;
export const CANCEL_CAUSES = ['customer', 'club', 'weather'] as const;
export const CANCEL_CAUSE = { CUSTOMER: 'customer', CLUB: 'club', WEATHER: 'weather' } as const;
/** Why a whole class can be cancelled. A class is never cancelled "by the customer". */
export const CLASS_CANCEL_CAUSES = [CANCEL_CAUSE.CLUB, CANCEL_CAUSE.WEATHER] as const;
export const BOOKING_SOURCE = { CUSTOMER_APP: 'customer_app', STAFF_PORTAL: 'staff_portal' } as const;
/** Only a document a staff member has verified counts. A submitted but unchecked form does not. */
export const DOC_KIND = { MEDICAL_FORM: 'medical_form', WAIVER: 'waiver', PHOTO_PERMISSION: 'photo_permission', ID_DOCUMENT: 'id_document' } as const;
export const DOC_KINDS = Object.values(DOC_KIND);
export const DOC_STATUS = { DRAFT: 'draft', SUBMITTED: 'submitted', VERIFIED: 'verified', REJECTED: 'rejected', EXPIRED: 'expired', SUPERSEDED: 'superseded' } as const;
export const PACKAGE_STATUS = { PENDING: 'pending', ACTIVE: 'active', FROZEN: 'frozen', EXHAUSTED: 'exhausted', EXPIRED: 'expired', CANCELLED: 'cancelled' } as const;
/** Statuses staff may move a package to. The rest happen by themselves. */
export const SETTABLE_PACKAGE_STATUSES = [PACKAGE_STATUS.ACTIVE, PACKAGE_STATUS.FROZEN, PACKAGE_STATUS.CANCELLED] as const;
export const LEDGER_REASON = { PURCHASE: 'purchase', USE: 'use', RETURN: 'return', ADJUSTMENT: 'adjustment', EXPIRY: 'expiry' } as const;
export const WAITLIST_STATUS = { ACTIVE: 'active', OFFERED: 'offered', CONVERTED: 'converted', EXPIRED: 'expired', DECLINED: 'declined', REMOVED: 'removed' } as const;
/** Problem codes the API adds on top of the rules code's own. */
export const PROBLEM = {
  RIDER_WRONG_BRANCH: 'RIDER_WRONG_BRANCH',
  PACKAGE_NOT_FOUND: 'PACKAGE_NOT_FOUND',
  PACKAGE_NOT_ACTIVE: 'PACKAGE_NOT_ACTIVE',
  PACKAGE_EXPIRED: 'PACKAGE_EXPIRED',
  PACKAGE_FORMAT_MISMATCH: 'PACKAGE_FORMAT_MISMATCH',
  NO_PACKAGE_BALANCE: 'NO_PACKAGE_BALANCE',
  CANNOT_CANCEL: 'CANNOT_CANCEL',
  ALREADY_WAITLISTED: 'ALREADY_WAITLISTED',
} as const;

/** Codes the rider and document endpoints add. */
export const RIDER_PROBLEM = {
  ADULT_NEEDS_OWN_ACCOUNT: 'ADULT_NEEDS_OWN_ACCOUNT',
  CHILD_NEEDS_GUARDIAN: 'CHILD_NEEDS_GUARDIAN',
  ALREADY_HAS_PROFILE: 'ALREADY_HAS_PROFILE',
  NOT_ALLOWED_STATUS: 'NOT_ALLOWED_STATUS',
  SAME_STATUS: 'SAME_STATUS',
  DOCUMENT_NOT_PENDING: 'DOCUMENT_NOT_PENDING',
  DOCUMENT_ALREADY_EXPIRED: 'DOCUMENT_ALREADY_EXPIRED',
  GUARDIAN_NOT_ELIGIBLE: 'GUARDIAN_NOT_ELIGIBLE',
  LAST_GUARDIAN: 'LAST_GUARDIAN',
} as const;

/** Codes for attendance, class lifecycle and the waitlist. */
export const FLOW_PROBLEM = {
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  ALREADY_CHECKED_IN: 'ALREADY_CHECKED_IN',
  NOT_CHECKABLE: 'NOT_CHECKABLE',
  CHECKIN_TOO_EARLY: 'CHECKIN_TOO_EARLY',
  CHECKIN_CLOSED: 'CHECKIN_CLOSED',
  CLASS_NOT_RUNNING: 'CLASS_NOT_RUNNING',
  RIDER_NOT_ACTIVE: 'RIDER_NOT_ACTIVE',
  NO_SHOW_TOO_EARLY: 'NO_SHOW_TOO_EARLY',
  NOT_NO_SHOWABLE: 'NOT_NO_SHOWABLE',
  CLASS_NOT_STARTED: 'CLASS_NOT_STARTED',
  CLASS_NOT_COMPLETABLE: 'CLASS_NOT_COMPLETABLE',
  CLASS_NOT_CANCELLABLE: 'CLASS_NOT_CANCELLABLE',
  UNRESOLVED_BOOKINGS: 'UNRESOLVED_BOOKINGS',
  NOT_OFFERED: 'NOT_OFFERED',
  OFFER_EXPIRED: 'OFFER_EXPIRED',
  PLACE_TAKEN: 'PLACE_TAKEN',
} as const;

// ---------- money ----------
export const PAYMENT_METHODS = ['cash', 'card_at_desk', 'bank_transfer'] as const;
export const ADJUSTMENT_KINDS = ['refund', 'credit', 'write_off', 'correction'] as const;
export const ADJUSTMENT_KIND = { REFUND: 'refund', CREDIT: 'credit', WRITE_OFF: 'write_off', CORRECTION: 'correction' } as const;
/** Prices are shown VAT-inclusive; this is the share of a price that is VAT. Saudi standard rate. Confirm with the club's accountant. */
export const VAT_PERCENT = 15;
export const RECEIPT_PREFIX = 'R-';
export const PAYMENT_PROBLEM = {
  PACKAGE_TYPE_UNAVAILABLE: 'PACKAGE_TYPE_UNAVAILABLE',
  RIDER_NOT_ACTIVE: 'RIDER_NOT_ACTIVE',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  NOT_PENDING_PAYMENT: 'NOT_PENDING_PAYMENT',
  ALREADY_PAID: 'ALREADY_PAID',
  HOLD_EXPIRED: 'HOLD_EXPIRED',
  UNPAID_NOT_ALLOWED: 'UNPAID_NOT_ALLOWED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  PACKAGE_STATUS_LOCKED: 'PACKAGE_STATUS_LOCKED',
  SAME_STATUS: 'SAME_STATUS',
  NEEDS_MANAGER: 'NEEDS_MANAGER',
  OVER_REFUND: 'OVER_REFUND',
} as const;

// ---------- horses ----------
export const HORSE_STATUS = {
  AVAILABLE: 'available', RESTING: 'resting', RESERVED: 'reserved', UNDER_TRAINING: 'under_training', MEDICAL_HOLD: 'medical_hold', INJURED: 'injured', RETIRED: 'retired',
} as const;
export const HORSE_STATUSES = Object.values(HORSE_STATUS);
/**
 * Workload rules a manager may knowingly break, with a written reason (OD-03).
 * Safety rules (a horse that is injured, not approved for the arena, or too strong for the rider) can never be overridden.
 */
export const OVERRIDABLE_HORSE_CODES = ['HORSE_REST_GAP', 'HORSE_DAILY_LIMIT', 'HORSE_WEEKLY_LIMIT'] as const;
export const HORSE_PROBLEM = {
  RIDER_NOT_IN_CLASS: 'RIDER_NOT_IN_CLASS',
  RIDER_HAS_HORSE: 'RIDER_HAS_HORSE',
  HORSE_BUSY: 'HORSE_BUSY',
  CLASS_CLOSED: 'CLASS_CLOSED',
  NOT_OVERRIDABLE: 'NOT_OVERRIDABLE',
  ARENA_NOT_IN_BRANCH: 'ARENA_NOT_IN_BRANCH',
  HORSE_NOT_FOUND: 'HORSE_NOT_FOUND',
  SAME_STATUS: 'SAME_STATUS',
  HORSE_RETIRED: 'HORSE_RETIRED',
  ASSIGNMENT_NOT_FOUND: 'ASSIGNMENT_NOT_FOUND',
} as const;

// ---------- people, branches, arenas, leave ----------
/** How much authority a role has. Nobody may act on someone of equal or higher rank, or give a role as high as their own. */
export const ROLE_RANK = { customer: 0, coach: 1, stable_hand: 1, reception: 1, manager: 2, owner: 3 } as const;
/** Roles that can be given through the API. Owners are set up outside it. */
export const ASSIGNABLE_ROLES = [ROLE.COACH, ROLE.STABLE_HAND, ROLE.RECEPTION, ROLE.MANAGER] as const;
export const LOCALES = ['en', 'ar'] as const;
export const ADMIN_PROBLEM = {
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  ROLE_TOO_HIGH: 'ROLE_TOO_HIGH',
  CANNOT_ACT_ON_SELF: 'CANNOT_ACT_ON_SELF',
  NOT_STAFF: 'NOT_STAFF',
  SAME_VALUE: 'SAME_VALUE',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  PHONE_TAKEN: 'PHONE_TAKEN',
  ACCOUNT_DELETED: 'ACCOUNT_DELETED',
  COACH_HAS_CLASSES: 'COACH_HAS_CLASSES',
  ARENA_HAS_CLASSES: 'ARENA_HAS_CLASSES',
  ARENA_NOT_FOUND: 'ARENA_NOT_FOUND',
  NAME_TAKEN: 'NAME_TAKEN',
  CLOSURE_NOT_FOUND: 'CLOSURE_NOT_FOUND',
  LEAVE_NOT_FOUND: 'LEAVE_NOT_FOUND',
  LEAVE_ALREADY_DECIDED: 'LEAVE_ALREADY_DECIDED',
  LEAVE_HAS_CLASSES: 'LEAVE_HAS_CLASSES',
  LEAVE_IN_PAST: 'LEAVE_IN_PAST',
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  POLICY_INCONSISTENT: 'POLICY_INCONSISTENT',
  OWNER_ONLY_SETTING: 'OWNER_ONLY_SETTING',
  CLOSURE_IN_PAST: 'CLOSURE_IN_PAST',
} as const;

/** Policy settings a manager may change, with the range each may take. Mirrors Policy in @trot/domain. */
export const POLICY_BOUNDS = {
  freeCancelHoursBefore: { min: 0, max: 720 },
  officeHoldMinutes: { min: 1, max: 1440 },
  waitlistOfferMinutes: { min: 5, max: 2880 },
  maxBookingsPerRiderPerDay: { min: 1, max: 20 },
  guardianRequiredUnderAge: { min: 0, max: 30 },
  horseMaxSessionsPerDay: { min: 1, max: 20 },
  horseMaxSessionsPerWeek: { min: 1, max: 100 },
  horseMinRestBetweenMinutes: { min: 0, max: 720 },
  adjustmentManagerThresholdMinor: { min: 0, max: 100_000_000 },
} as const;
export const POLICY_FLAGS = ['lateCancelConsumesClass', 'noShowConsumesClass', 'allowManagerUnpaidConfirmation', 'requireMedicalForm', 'requireWaiver'] as const;
export const HORSE_SELECTION_MODES = ['staff_assigns', 'customer_chooses_with_approval'] as const;
/** Money-control settings: only an owner may change them, so a manager cannot loosen the limit on their own approvals. */
export const OWNER_ONLY_POLICY_KEYS = ['adjustmentManagerThresholdMinor', 'allowManagerUnpaidConfirmation'] as const;
export const DECISIONS = { APPROVE: 'approve', REJECT: 'reject' } as const;

// ---------- incidents ----------
export const INCIDENT_SEVERITY = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' } as const;
export const INCIDENT_SEVERITIES = Object.values(INCIDENT_SEVERITY);
export const INCIDENT_STATUS = {
  OPEN: 'open', UNDER_REVIEW: 'under_review', ACTION_IN_PROGRESS: 'action_in_progress', PENDING_CLOSURE: 'pending_closure', CLOSED: 'closed', REOPENED: 'reopened',
} as const;
export const INCIDENT_STATUSES = Object.values(INCIDENT_STATUS);
/** Where each status may go next. An incident is never deleted; a closed one can only be reopened. */
export const INCIDENT_TRANSITIONS: Record<string, readonly string[]> = {
  open: ['under_review'],
  under_review: ['action_in_progress', 'pending_closure'],
  action_in_progress: ['pending_closure'],
  pending_closure: ['closed', 'action_in_progress'],
  closed: ['reopened'],
  reopened: ['under_review'],
};
export const INCIDENT_PROBLEM = {
  INCIDENT_NOT_FOUND: 'INCIDENT_NOT_FOUND',
  BAD_TRANSITION: 'BAD_TRANSITION',
  RIDER_NOT_IN_BRANCH: 'RIDER_NOT_IN_BRANCH',
  HORSE_NOT_IN_BRANCH: 'HORSE_NOT_IN_BRANCH',
  IN_THE_FUTURE: 'IN_THE_FUTURE',
  OWNER_MUST_CLOSE: 'OWNER_MUST_CLOSE',
} as const;
export const REPORT_PROBLEM = { RANGE_TOO_LONG: 'RANGE_TOO_LONG', BAD_RANGE: 'BAD_RANGE' } as const;

// ---------- rides ----------
/** Codes the ride endpoints add. The rules code adds RIDE_NOT_IN_PACKAGE and RIDER_TOO_YOUNG itself. */
export const RIDE_PROBLEM = {
  RIDE_TYPE_NOT_FOUND: 'RIDE_TYPE_NOT_FOUND',
  RIDE_TYPE_INACTIVE: 'RIDE_TYPE_INACTIVE',
  OUTSIDE_ACTIVE_DATES: 'OUTSIDE_ACTIVE_DATES',
  CAPACITY_OVER_TYPE: 'CAPACITY_OVER_TYPE',
  NAME_TAKEN: 'NAME_TAKEN',
  BAD_DATES: 'BAD_DATES',
} as const;
