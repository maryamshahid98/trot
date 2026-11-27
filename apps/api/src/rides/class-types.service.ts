import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser } from '../auth/decorators.ts';
import { writeAudit } from '../common/audit.ts';
import { branchFor } from '../common/branch.ts';
import { pgErrorCode } from '../common/errors.ts';
import { parse } from '../common/validate.ts';
import { CLASS_FORMATS, LEVELS, LIMITS, PG_ERROR } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const whole = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();
const shape = {
  name: z.string().trim().min(1).max(80), format: z.enum(CLASS_FORMATS), discipline: z.string().trim().max(120).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(600), capacity: z.number().int().min(1).max(LIMITS.arenaCapacityMax), minLevel: z.enum(LEVELS),
  minAgeYears: whole(0, 99), maxAgeYears: whole(0, 120), priceMinor: z.number().int().min(0).max(LIMITS.priceMaxMinor),
  prerequisites: z.string().trim().max(1000).nullable().optional(), cancelHours: whole(0, 720), singleVisit: z.boolean().optional(), active: z.boolean().optional(),
};
const Create = z.object({ branchId: uuid.optional(), ...shape });
const Update = z.object(shape).partial().refine((v) => Object.keys(v).length > 0, 'send at least one field to change');
const List = z.object({ branchId: uuid.optional() });
const COLUMNS: Record<string, string> = {
  name: 'name', format: 'format', discipline: 'discipline', durationMinutes: 'duration_minutes', capacity: 'capacity', minLevel: 'min_level', minAgeYears: 'min_age_years',
  maxAgeYears: 'max_age_years', priceMinor: 'price_minor', prerequisites: 'prerequisites', cancelHours: 'cancel_hours', singleVisit: 'single_visit', active: 'active',
};
const SELECT = Object.entries(COLUMNS).map(([k, c]) => `${c}${c === 'format' || c === 'min_level' ? '::text' : ''} AS "${k}"`).join(', ');

/** The lesson catalogue (CLS-001): what each kind of class is, so scheduling one starts from the club's own settings. */
@Injectable()
export class ClassTypesService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list(query: unknown, user: AuthUser) {
    const q = parse(List, query);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => ({
      classTypes: (await c.query(`SELECT id, ${SELECT} FROM class_types WHERE branch_id = $1 ORDER BY lower(name) LIMIT 200`, [branchId])).rows,
    }));
  }

  private fail(e: unknown): never {
    if (pgErrorCode(e) === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException('This branch already has a class type with that name.');
    if (pgErrorCode(e) === PG_ERROR.CHECK_VIOLATION) throw new ConflictException('The oldest age cannot be below the youngest.');
    throw e;
  }

  async create(body: unknown, user: AuthUser) {
    const b = parse(Create, body) as Record<string, unknown> & { branchId?: string; name: string };
    const branchId = branchFor(b.branchId, user);
    const keys = Object.keys(COLUMNS).filter((k) => b[k] !== undefined);
    try {
      return await this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
        const id: string = (await c.query(`INSERT INTO class_types (branch_id, ${keys.map((k) => COLUMNS[k]).join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`, [branchId, ...keys.map((k) => b[k])])).rows[0].id;
        await writeAudit(c, user, branchId, 'class_type.create', 'class_type', id, { name: b.name });
        return { id };
      });
    } catch (e: unknown) {
      return this.fail(e);
    }
  }

  async update(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(z.object({ id: uuid }), { id: rawId });
    const b = parse(Update, body) as Record<string, unknown>;
    const keys = Object.keys(COLUMNS).filter((k) => b[k] !== undefined);
    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const before = (await c.query(`SELECT branch_id AS "branchId", ${SELECT} FROM class_types WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!before) throw new NotFoundException('Class type not found.');
        await c.query(`UPDATE class_types SET ${keys.map((k, i) => `${COLUMNS[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => b[k])]);
        await writeAudit(c, user, before.branchId, 'class_type.update', 'class_type', id, { changes: Object.fromEntries(keys.filter((k) => before[k] !== b[k]).map((k) => [k, { from: before[k], to: b[k] }])) });
        return { id };
      });
    } catch (e: unknown) {
      return this.fail(e);
    }
  }
}
