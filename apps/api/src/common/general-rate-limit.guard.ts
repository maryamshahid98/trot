import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';
import type { ApiRequest } from './http.ts';
import { RateLimiter } from './rate-limiter.ts';

export const SKIP_RATE_LIMIT = 'trot:skipRateLimit';
/** Leaves a route out of the general limit, for example the health check that a load balancer calls constantly. */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);

/**
 * A ceiling on every route, per address, so one client cannot flood the API.
 * Much higher than the sign-in limit (see RateLimitGuard), which stays in force on the sign-in routes as well.
 */
@Injectable()
export class GeneralRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<ApiRequest>();
    const { generalMax, windowMs } = this.config.rateLimit;
    if (!(await this.limiter.allow(`api|${req.ip}`, generalMax, windowMs))) {
      throw new HttpException({ message: 'Too many requests. Please wait and try again.' }, 429);
    }
    return true;
  }
}
