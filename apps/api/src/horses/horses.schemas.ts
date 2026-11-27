import { z } from 'zod';
import { FORMATS, HORSE_STATUSES, LEVELS, LIMITS } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time such as 2026-12-01T16:00:00+03:00');
const reason = z.string().trim().min(1, 'a reason is required').max(LIMITS.reasonMax);

const levels = z.array(z.enum(LEVELS)).min(1).max(LEVELS.length).refine((a) => new Set(a).size === a.length, 'must not repeat a level');
const arenaIds = z.array(uuid).max(50).refine((a) => new Set(a).size === a.length, 'must not repeat an arena');
const fields = {
  name: z.string().trim().min(1).max(LIMITS.horseNameMax),
  suitableLevels: levels,
  arenaIds,
  notes: z.string().trim().max(LIMITS.notesMax).nullable(),
};
const label_ = z.string().trim().max(120).nullable().optional();
const whole = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();
/** Identity, stabling and safety limits (HOR-001..003). */
const profile = {
  owner: label_, stable: label_, stall: label_,
  maxRiderWeightKg: whole(10, 250), minRiderAge: whole(0, 99), maxSessionsPerDay: whole(1, 20), maxSessionsPerWeek: whole(1, 100),
  formats: z.array(z.enum(FORMATS)).optional(),
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date such as 2026-12-01');
export const CARE_KINDS = ['health', 'vaccination', 'farrier', 'medication', 'care'] as const;
export const AddCare = z.object({ kind: z.enum(CARE_KINDS), happenedOn: day, dueOn: day.nullable().optional(), notes: z.string().trim().max(LIMITS.notesMax).nullable().optional() });

export const IdParam = z.object({ id: uuid });
export const AssignmentParams = z.object({ id: uuid, assignmentId: uuid });

export const CreateHorse = z.object({ ...profile, branchId: uuid.optional(), name: fields.name, suitableLevels: levels, arenaIds: arenaIds.default([]), notes: fields.notes.optional() });
export const UpdateHorse = z
  .object({ ...fields, ...profile })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');
export const ListHorses = z.object({
  branchId: uuid.optional(),
  status: z.enum(HORSE_STATUSES as [string, ...string[]]).optional(),
  q: z.string().trim().max(LIMITS.searchMax).optional(),
});
export const SetHorseStatus = z.object({ status: z.enum(HORSE_STATUSES as [string, ...string[]]), reason: reason.optional() });
export const WorkloadQuery = z.object({ from: isoTime, to: isoTime });

export const AssignHorse = z.object({
  horseId: uuid,
  riderId: uuid.optional(),
  override: z.object({ reason }).optional(),
});
export const SuggestQuery = z.object({ riderId: uuid.optional() });
