import { Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/decorators.ts';
import { branchFor } from '../common/branch.ts';
import { parse } from '../common/validate.ts';
import { ACCOUNT_STATUS, LIMITS, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { ListStaff } from './accounts.schemas.ts';

@Injectable()
export class StaffService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

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
