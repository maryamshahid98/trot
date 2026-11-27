import { z } from 'zod';
import { DOC_KINDS, LEVELS, LIMITS, RELATIONS, SETTABLE_RIDER_STATUSES, RIDER_STATUSES } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const plain = (max: number) => z.string().trim().min(1).max(max);
const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time such as 2026-12-01T16:00:00+03:00');

/** A real calendar date, not in the future, not absurdly old. */
export const birthDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must look like 2015-05-30')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'is not a real date')
  .refine((s) => Date.parse(`${s}T00:00:00Z`) <= Date.now(), 'cannot be in the future')
  .refine((s) => Number(s.slice(0, 4)) >= LIMITS.earliestBirthYear, 'is too long ago');

const phoneNumber = plain(40).refine((s) => /^\+?[0-9 ()-]+$/.test(s) && s.replace(/\D/g, '').length >= 3, 'must be a phone number, for example +966500000000');
const emergencyContact = z.object({ name: plain(LIMITS.nameMax), phone: phoneNumber, relationship: plain(60).optional() }).strict();
const notes = z.string().trim().max(LIMITS.notesMax);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date such as 2026-12-01').refine((s) => !Number.isNaN(Date.parse(s)), 'must be a real date');
/** What the desk records about a rider beyond name and birth date (CUS-003). */
const about = {
  heightCm: z.number().int().min(50).max(250).nullable().optional(),
  weightKg: z.number().int().min(10).max(250).nullable().optional(),
  ridingExperience: notes.nullable().optional(),
  preferences: notes.nullable().optional(),
  restrictions: notes.nullable().optional(),
  phone: phoneNumber.nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
};
export const WaiverQuery = z.object({ branchId: uuid.optional() });
export const PublishWaiver = z.object({ branchId: uuid.optional(), version: plain(40), body: z.string().trim().min(1).max(20_000), requiresResign: z.boolean().default(true) });
const guardianFlags = { relationship: plain(60).nullable().optional(), hasAuthority: z.boolean().optional(), isPrimary: z.boolean().optional(), isBilling: z.boolean().optional(), isEmergency: z.boolean().optional() };
export const UpdateGuardian = z.object(guardianFlags).refine((v) => Object.keys(v).length > 0, 'send at least one field to change');

export const CreateRider = z.object({
  ...about,
  branchId: uuid.optional(),
  fullName: plain(LIMITS.nameMax),
  dateOfBirth: birthDate,
  relation: z.enum(RELATIONS).optional(), // customers say whether this is themselves or a child
  emergencyContact: emergencyContact.optional(),
  medicalNotes: notes.optional(),
  allergies: notes.optional(),
  guardianAccountId: uuid.optional(), // staff only
  isWalkIn: z.boolean().optional(), // staff only
  confirmDuplicate: z.boolean().optional(), // staff only: save although a rider with this name and birth date exists
});

export const UpdateRiderCustomer = z
  .object({ fullName: plain(LIMITS.nameMax), emergencyContact: emergencyContact.nullable(), medicalNotes: notes.nullable(), allergies: notes.nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');
export const UpdateRiderStaff = z
  .object({ fullName: plain(LIMITS.nameMax), dateOfBirth: birthDate, emergencyContact: emergencyContact.nullable(), medicalNotes: notes.nullable(), allergies: notes.nullable(), ...about })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');

// A level normally changes through an approved assessment. This is for correcting a mistake, so the reason is required.
export const SetLevel = z.object({ level: z.enum(LEVELS), reason: plain(LIMITS.reasonMax) });
export const SetStatus = z.object({ status: z.enum(SETTABLE_RIDER_STATUSES), reason: plain(LIMITS.reasonMax).optional(), from: day.optional(), until: day.optional() });

export const ListRiders = z.object({
  branchId: uuid.optional(),
  q: z.string().trim().max(LIMITS.searchMax).optional(),
  status: z.enum(RIDER_STATUSES as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.ridersListMax).default(LIMITS.ridersListDefault),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const IdParam = z.object({ id: uuid });
export const GuardianParams = z.object({ id: uuid, accountId: uuid });
export const AddGuardian = z.object({ accountId: uuid, ...guardianFlags });

export const SubmitDocument = z.object({
  kind: z.enum(DOC_KINDS as [string, ...string[]]),
  fileRef: plain(LIMITS.fileRefMax).optional(),
  signedAt: isoTime.optional(),
  expiresAt: isoTime.optional(),
});
export const RejectDocument = z.object({ reason: plain(LIMITS.reasonMax) });
