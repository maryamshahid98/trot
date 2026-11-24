import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ACCOUNT_STATUS, BEARER_PREFIX } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { IS_PUBLIC, ROLES_KEY } from './decorators.ts';
import type { AuthUser } from './decorators.ts';
import { TokenService } from './tokens.ts';

/**
 * Runs on every route. Checks the token, then re-reads the account from the database, so a locked or
 * removed account stops working at once and role or branch changes apply on the next request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: unknown = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) throw new UnauthorizedException('Sign in first.');

    let accountId: string;
    try {
      accountId = await this.tokens.verifyAccess(header.slice(BEARER_PREFIX.length).trim());
    } catch {
      throw new UnauthorizedException('Your session is not valid. Please sign in again.');
    }

    const r = await this.db.query(
      `SELECT a.id, a.role, a.full_name, a.status,
              COALESCE(array_agg(ab.branch_id::text) FILTER (WHERE ab.branch_id IS NOT NULL), '{}') AS branch_ids
         FROM accounts a LEFT JOIN account_branches ab ON ab.account_id = a.id
        WHERE a.id = $1 GROUP BY a.id`,
      [accountId],
    );
    const a = r.rows[0];
    if (!a || a.status !== ACCOUNT_STATUS.ACTIVE) throw new UnauthorizedException('Your session is not valid. Please sign in again.');

    const user: AuthUser = { id: a.id, role: a.role, fullName: a.full_name, branchIds: a.branch_ids };
    req.user = user;

    const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(user.role)) throw new ForbiddenException('Your role cannot do this.');
    return true;
  }
}
