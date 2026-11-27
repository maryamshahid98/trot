import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { writeAudit } from '../common/audit.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { branchFor } from '../common/branch.ts';
import { parse } from '../common/validate.ts';
import { ACCOUNT_STATUS, ENTITY, LIMITS, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { IdParam, ListStaff, StaffProfile } from './accounts.schemas.ts';

@Injectable()
export class StaffService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Only people who share a branch with you. */
  private async colleague(id: string, user: AuthUser) {
    const r = (await this.db.query(`SELECT a.id, a.full_name AS "fullName" FROM accounts a JOIN account_branches ab ON ab.account_id = a.id WHERE a.id = $1 AND ab.branch_id = ANY($2::uuid[]) AND a.role <> $3 LIMIT 1`, [id, user.branchIds, ROLE.CUSTOMER])).rows[0];
    if (!r) throw new NotFoundException('Staff member not found.');
    return r;
  }

  async profile(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const who = await this.colleague(id, user);
    const p = (
      await this.db.query(
        `SELECT qualifications, levels::text[] AS levels, formats::text[] AS formats, to_char(certification_expires, 'YYYY-MM-DD') AS "certificationExpires", work_days AS "workDays",
                to_char(work_from, 'HH24:MI') AS "workFrom", to_char(work_to, 'HH24:MI') AS "workTo", max_sessions_per_day AS "maxSessionsPerDay" FROM staff_profiles WHERE account_id = $1`,
        [id],
      )
    ).rows[0];
    return { ...who, profile: p ?? null };
  }

  async saveProfile(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(StaffProfile, body);
    await this.colleague(id, user);
    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO staff_profiles (account_id, qualifications, levels, formats, certification_expires, work_days, work_from, work_to, max_sessions_per_day)
         VALUES ($1,$2,$3::level[],$4::class_format[],$5,$6,$7,$8,$9)
         ON CONFLICT (account_id) DO UPDATE SET qualifications = excluded.qualifications, levels = excluded.levels, formats = excluded.formats, certification_expires = excluded.certification_expires,
           work_days = excluded.work_days, work_from = excluded.work_from, work_to = excluded.work_to, max_sessions_per_day = excluded.max_sessions_per_day`,
        [id, b.qualifications, b.levels, b.formats, b.certificationExpires, b.workDays, b.workFrom, b.workTo, b.maxSessionsPerDay],
      );
      await writeAudit(c, user, user.branchIds[0], 'staff.profile', ENTITY.ACCOUNT, id, { levels: b.levels, formats: b.formats, certificationExpires: b.certificationExpires });
    });
    return this.profile(id, user);
  }

  /** Active staff who work in one branch, for choosing a coach or guide. Names and roles only. */
  async list(query: unknown, user: AuthUser) {
    const q = parse(ListStaff, query);
    const branchId = branchFor(q.branchId, user);
    const rows = (
      await this.db.query(
        `SELECT a.id, a.full_name AS "fullName", a.role
           FROM accounts a JOIN account_branches ab ON ab.account_id = a.id
          WHERE ab.branch_id = $1 AND a.status = $2 AND a.role <> $5 AND ($3::account_role IS NULL OR a.role = $3)
          ORDER BY a.full_name LIMIT $4`,
        [branchId, ACCOUNT_STATUS.ACTIVE, q.role ?? null, LIMITS.accountsListMax, ROLE.CUSTOMER],
      )
    ).rows;
    return { staff: rows };
  }
}
