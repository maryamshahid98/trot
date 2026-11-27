import { z } from 'zod';
import { ACCOUNT_STATUS, ASSIGNABLE_ROLES, FORMATS, LEVELS, LIMITS, LOCALES, ROLES, SETTABLE_ACCOUNT_STATUSES } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const name = z.string().trim().min(1).max(LIMITS.nameMax);
const email = z.string().trim().toLowerCase().email().max(LIMITS.identifierMax);
const phone = z.string().trim().regex(new RegExp(`^\\+?[0-9]{${LIMITS.phoneMin},${LIMITS.phoneMax}}$`), 'must be digits only, with an optional leading +');
const password = z.string().min(LIMITS.newPasswordMin, `must be at least ${LIMITS.newPasswordMin} characters`).max(LIMITS.newPasswordMax);
const reason = z.string().trim().min(1, 'a reason is required').max(LIMITS.reasonMax);
const branchIds = z.array(uuid).min(1, 'choose at least one branch').max(50).refine((a) => new Set(a).size === a.length, 'must not repeat a branch');

export const IdParam = z.object({ id: uuid });
export const ListAccounts = z.object({
  branchId: uuid.optional(),
  role: z.enum(ROLES as unknown as [string, ...string[]]).optional(),
  status: z.enum(Object.values(ACCOUNT_STATUS) as [string, ...string[]]).optional(),
  q: z.string().trim().max(LIMITS.searchMax).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.accountsListMax).default(LIMITS.accountsListDefault),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export const CreateAccount = z.object({
  fullName: name, email, phone: phone.optional(), role: z.enum(ASSIGNABLE_ROLES), branchIds, password,
  locale: z.enum(LOCALES).default('en'),
});
export const UpdateAccount = z
  .object({ fullName: name, email, phone: phone.nullable(), locale: z.enum(LOCALES) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');
export const SetRole = z.object({ role: z.enum(ASSIGNABLE_ROLES), reason: reason.optional() });
export const SetStatus = z.object({ status: z.enum(SETTABLE_ACCOUNT_STATUSES), reason: reason.optional() });
export const ResetPassword = z.object({ newPassword: password });
export const SetBranches = z.object({ branchIds });

/** A short list of working staff for pickers (who can teach, who can lead a ride). */
export const ListStaff = z.object({ branchId: uuid.optional(), role: z.enum(ASSIGNABLE_ROLES).optional() });

/** A parent or customer added at the desk. They have no password until they use the app. */
export const CreateCustomer = z
  .object({ branchId: uuid.optional(), fullName: name, email: email.optional(), phone: phone.optional() })
  .refine((v) => v.email || v.phone, { message: 'give a phone number or an email', path: ['phone'] });
export const SearchCustomers = z.object({ branchId: uuid.optional(), q: z.string().trim().min(2).max(LIMITS.searchMax) });

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time such as 08:00').nullable();
export const StaffProfile = z.object({
  qualifications: z.string().trim().max(LIMITS.notesMax).nullable().default(null),
  levels: z.array(z.enum(LEVELS)).min(1, 'choose at least one level'),
  formats: z.array(z.enum(FORMATS)).default([]),
  certificationExpires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date such as 2026-12-01').nullable().default(null),
  workDays: z.array(z.number().int().min(0).max(6)).default([]),
  workFrom: clock.default(null),
  workTo: clock.default(null),
  maxSessionsPerDay: z.number().int().min(1).max(20).nullable().default(null),
}).refine((v) => !v.workFrom === !v.workTo && (!v.workFrom || v.workFrom < (v.workTo as string)), { message: 'give both a start and a later end, or neither', path: ['workTo'] });
