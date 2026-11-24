import { Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { JobsService } from './jobs.service.ts';

@Controller('jobs')
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  /** Runs the clean-up now, for the caller's own branches. The same work also runs on a timer (JOBS_INTERVAL_SECONDS). */
  @Post('expiry') @HttpCode(200) @Roles(ROLE.MANAGER, ROLE.OWNER)
  expiry(@CurrentUser() user: AuthUser) {
    return this.jobs.run(user.branchIds, Date.now());
  }
}
