import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../auth/decorators.ts';

/** The branch a request acts on: the one asked for if the user works there, or their only branch. Never taken on trust. */
export function branchFor(requested: string | undefined, user: AuthUser): string {
  if (requested) {
    if (!user.branchIds.includes(requested)) throw new ForbiddenException('You do not work in that branch.');
    return requested;
  }
  if (user.branchIds.length === 1) return user.branchIds[0];
  if (user.branchIds.length === 0) throw new ForbiddenException('Your account is not linked to a branch.');
  throw new BadRequestException({ message: 'branchId is required.', problems: [{ field: 'branchId', message: 'is required for people who work in more than one branch' }] });
}
