import { z } from 'zod';
import { LEVELS, LIMITS } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const text = (max: number) => z.string().trim().max(max);
const nonEmpty = (o: object) => Object.keys(o).length > 0;

export const IdParam = z.object({ id: uuid });
export const RECOMMENDATIONS = ['promote', 'stay', 'further_assessment'] as const;
export const ASSESSMENT_STATUSES = ['draft', 'submitted', 'needs_more', 'approved', 'rejected'] as const;

export const ListSkills = z.object({
  branchId: uuid.optional(),
  forLevel: z.enum(LEVELS).optional(),
  includeInactive: z.enum(['true', 'false']).default('false'),
});
export const CreateSkill = z.object({
  branchId: uuid.optional(),
  name: z.string().trim().min(1).max(LIMITS.titleMax),
  description: text(LIMITS.notesMax).optional(),
  forLevel: z.enum(LEVELS),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export const UpdateSkill = z
  .object({
    name: z.string().trim().min(1).max(LIMITS.titleMax).optional(),
    description: text(LIMITS.notesMax).nullable().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    active: z.boolean().optional(),
  })
  .refine(nonEmpty, 'say what to change');

export const CreateAssessment = z.object({ riderId: uuid });
export const UpdateAssessment = z
  .object({
    recommendation: z.enum(RECOMMENDATIONS).optional(),
    targetLevel: z.enum(LEVELS).optional(),
    notes: text(LIMITS.notesMax).optional(),
    // The skills rated so far. A skill listed again replaces its earlier rating.
    ratings: z.array(z.object({ skillId: uuid, rating: z.number().int().min(1).max(5), evidence: text(LIMITS.reasonMax).optional() })).max(100).optional(),
  })
  .refine(nonEmpty, 'say what to change');
export const Decide = z.object({ decision: z.enum(['approve', 'reject', 'request_more']), note: text(LIMITS.reasonMax).optional() });
export const ListAssessments = z.object({
  branchId: uuid.optional(),
  riderId: uuid.optional(),
  status: z.enum(ASSESSMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
