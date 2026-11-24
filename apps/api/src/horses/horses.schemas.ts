import { z } from 'zod';
import { HORSE_STATUSES, LEVELS, LIMITS } from '../config/constants.ts';
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

export const IdParam = z.object({ id: uuid });
export const AssignmentParams = z.object({ id: uuid, assignmentId: uuid });

export const CreateHorse = z.object({ branchId: uuid.optional(), name: fields.name, suitableLevels: levels, arenaIds: arenaIds.default([]), notes: fields.notes.optional() });
export const UpdateHorse = z
  .object(fields)
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
