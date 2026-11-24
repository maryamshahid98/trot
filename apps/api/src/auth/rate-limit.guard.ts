import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { RateLimiter } from '../common/rate-limiter.ts';
import type { ApiRequest } from '../common/http.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';

/**
 * Per-address limit for the open sign-in routes. The number and the window come from AUTH_RATE_LIMIT and
 * RATE_LIMIT_WINDOW_SECONDS. The counts live in the database, so the limit is shared by every API server.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ApiRequest>();
    const { authMax, windowMs } = this.config.rateLimit;
    if (!(await this.limiter.allow(`auth|${req.ip}|${req.path}`, authMax, windowMs))) {
      throw new HttpException({ message: 'Too many requests. Please wait and try again.' }, 429);
    }
    return true;
  }
}
