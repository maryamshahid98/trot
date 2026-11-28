import { createHash, timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Inject, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Public } from '../auth/decorators.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';
import { JobsService } from './jobs.service.ts';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * The background job, started from outside, for hosting where nothing keeps running between requests (set JOBS_INTERVAL_SECONDS=0
 * there). No person signs in: the scheduler proves itself with CRON_SECRET.
 */
@Controller('internal')
export class CronController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Public() @Get('jobs')
  async run(@Headers('authorization') authorization: string | undefined) {
    const secret = this.config.jobs.cronSecret;
    if (!secret) throw new NotFoundException();
    // Compared as digests, so the time taken says nothing about the secret.
    if (!timingSafeEqual(digest(authorization ?? ''), digest(`Bearer ${secret}`))) throw new UnauthorizedException();
    const result = await this.jobs.runScheduled();
    return result ?? { skipped: 'already running' };
  }
}
