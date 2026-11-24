import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '../config/constants.ts';

export const IS_PUBLIC = 'trot:isPublic';
export const ALLOW_WITHOUT_MFA = 'trot:allowWithoutMfa';
export const ROLES_KEY = 'trot:roles';

export interface AuthUser {
  id: string;
  role: Role;
  fullName: string | null;
  /** Branches this person works in (or, for a customer, belongs to). Loaded fresh from the database on every request. */
  branchIds: string[];
  /** Two-step sign-in is switched on for this account. */
  mfaEnabled: boolean;
  /** The club requires it for this role and it is not set up yet: until it is, only setting it up works. */
  mfaEnrollmentRequired: boolean;
}

/** Marks a route as open to people who are not signed in. Everything else requires a valid token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** A route a person who still has to set up two-step sign-in may use (setting it up, who am I, sign out). */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA, true);
/** Limits a route to these roles. A route with no @Roles is open to every signed-in user. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
