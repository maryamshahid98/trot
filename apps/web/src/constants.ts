/** Every fixed word the app depends on lives here, so no screen types them by hand. */
export const ROLE = {
  CUSTOMER: 'customer',
  COACH: 'coach',
  STABLE_HAND: 'stable_hand',
  RECEPTION: 'reception',
  MANAGER: 'manager',
  OWNER: 'owner',
} as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];

export const STAFF_ROLES: readonly Role[] = [ROLE.COACH, ROLE.STABLE_HAND, ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER];
const FRONT: readonly Role[] = [ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER];
const MANAGERS: readonly Role[] = [ROLE.MANAGER, ROLE.OWNER];
const ALL_STAFF = STAFF_ROLES;

export const THEME = { LIGHT: 'light', DARK: 'dark', SYSTEM: 'system' } as const;
export type Theme = (typeof THEME)[keyof typeof THEME];
export const LOCALE = { EN: 'en', AR: 'ar' } as const;
export type Locale = (typeof LOCALE)[keyof typeof LOCALE];

export const STORAGE = { THEME: 'trot.theme', LOCALE: 'trot.locale', BRANCH: 'trot.branch' } as const;
/** Tells the API this is the website, so the refresh token travels only in a cookie that scripts cannot read. */
export const CLIENT_HEADER = { name: 'X-Trot-Client', value: 'web' } as const;
export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
export const SIGNIN_PHOTO = '/images/signin-horse.jpg';
export const HTTP = { UNAUTHORIZED: 401 } as const;

export const PATH = {
  LOGIN: '/login',
  DASHBOARD: '/',
  CALENDAR: '/calendar',
  BOOKINGS: '/bookings',
  PEOPLE: '/people',
  HORSES: '/horses',
  STAFF: '/staff',
  MONEY: '/money',
  PROGRESS: '/progress',
  COMMS: '/comms',
  REPORTS: '/reports',
  ADMIN: '/admin',
} as const;

/** The menu. `roles` says who sees each item; the API still checks every request on its own. */
export const NAV = [
  { key: 'dashboard', path: PATH.DASHBOARD, icon: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z', roles: ALL_STAFF },
  { key: 'calendar', path: PATH.CALENDAR, icon: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M8 3v4M16 3v4', roles: ALL_STAFF },
  { key: 'bookings', path: PATH.BOOKINGS, icon: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z', roles: FRONT },
  { key: 'people', path: PATH.PEOPLE, icon: 'M2 20a7 7 0 0 1 14 0M18 20a6 6 0 0 0-3-5M16 4.5a3.5 3.5 0 0 1 0 7M9 4.5a3.5 3.5 0 1 0 0 7', roles: FRONT },
  { key: 'horses', path: PATH.HORSES, icon: 'M4 20V9l4-5 3 3h4l5 5v8', roles: ALL_STAFF },
  { key: 'staff', path: PATH.STAFF, icon: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0', roles: MANAGERS },
  { key: 'money', path: PATH.MONEY, icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4', roles: FRONT },
  { key: 'progress', path: PATH.PROGRESS, icon: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z', roles: [ROLE.COACH, ...MANAGERS] },
  { key: 'comms', path: PATH.COMMS, icon: 'M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4', roles: MANAGERS },
  { key: 'reports', path: PATH.REPORTS, icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2', roles: MANAGERS },
  { key: 'admin', path: PATH.ADMIN, icon: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3', roles: MANAGERS },
] as const;
export type NavKey = (typeof NAV)[number]['key'];

// ---------- values the API accepts (kept in step with apps/api/src/config/constants.ts) ----------
export const LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export const CLASS_FORMATS = ['private', 'semi_private', 'group', 'trial', 'camp', 'assessment', 'open_riding'] as const;
export const PAY_WITH = { PACKAGE: 'package', OFFICE: 'office' } as const;
export const PAYMENT_METHODS = ['cash', 'card_at_desk', 'bank_transfer'] as const;
export const ADJUSTMENT_KINDS = ['refund', 'credit', 'write_off', 'correction'] as const;
export const BOOKING_STATUS = { PENDING_OFFICE_PAYMENT: 'pending_office_payment', CONFIRMED: 'confirmed', CHECKED_IN: 'checked_in', COMPLETED: 'completed', CANCELLED: 'cancelled', NO_SHOW: 'no_show' } as const;
export const OCCURRENCE_STATUS = { DRAFT: 'draft', PUBLISHED: 'published', IN_PROGRESS: 'in_progress', COMPLETED: 'completed', CANCELLED: 'cancelled' } as const;
export const RIDER_STATUSES = ['active', 'restricted', 'suspended', 'inactive'] as const;
export const RIDER_FILTER_STATUSES = ['draft', 'pending_review', 'active', 'restricted', 'suspended', 'inactive', 'archived'] as const;
export const HORSE_STATUSES = ['available', 'resting', 'reserved', 'under_training', 'medical_hold', 'injured', 'retired'] as const;
export const DOC_KINDS = ['medical_form', 'waiver', 'photo_permission', 'id_document'] as const;
export const PACKAGE_STATUSES_SETTABLE = ['active', 'frozen', 'cancelled'] as const;
export const ASSIGNABLE_ROLES = ['coach', 'stable_hand', 'reception', 'manager'] as const;
export const ACCOUNT_STATUSES_SETTABLE = ['active', 'locked'] as const;
export const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const INCIDENT_STATUSES = ['open', 'under_review', 'action_in_progress', 'pending_closure', 'closed', 'reopened'] as const;
export const INCIDENT_TRANSITIONS: Record<string, readonly string[]> = {
  open: ['under_review'], under_review: ['action_in_progress', 'pending_closure'], action_in_progress: ['pending_closure'],
  pending_closure: ['closed', 'action_in_progress'], closed: ['reopened'], reopened: ['under_review'],
};
export const CANCEL_CAUSES_CLASS = ['club', 'weather'] as const;
export const HORSE_SELECTION_MODES = ['staff_assigns', 'customer_chooses_with_approval'] as const;
export const POLICY_NUMBERS = [
  'freeCancelHoursBefore', 'officeHoldMinutes', 'waitlistOfferMinutes', 'maxBookingsPerRiderPerDay', 'guardianRequiredUnderAge',
  'horseMaxSessionsPerDay', 'horseMaxSessionsPerWeek', 'horseMinRestBetweenMinutes', 'adjustmentManagerThresholdMinor',
] as const;
export const POLICY_FLAGS = ['lateCancelConsumesClass', 'noShowConsumesClass', 'allowManagerUnpaidConfirmation', 'requireMedicalForm', 'requireWaiver'] as const;
export const OWNER_ONLY_POLICY = ['adjustmentManagerThresholdMinor', 'allowManagerUnpaidConfirmation'] as const;
/** Staff roles that may schedule, take payments and manage riders. */
export const FRONT_DESK: readonly Role[] = [ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER];
export const MANAGER_ROLES: readonly Role[] = [ROLE.MANAGER, ROLE.OWNER];
export const RUNNER_ROLES: readonly Role[] = [ROLE.COACH, ...FRONT_DESK];
export const HORSE_TEAM: readonly Role[] = [ROLE.STABLE_HAND, ...MANAGER_ROLES];
