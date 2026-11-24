import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { LIMITS } from '../config/constants.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';

/**
 * Per-address limit for the open sign-in routes. The number and the window come from AUTH_RATE_LIMIT and
 * RATE_LIMIT_WINDOW_SECONDS. Kept in memory, so it is per server process. When there is more than one server, move it to Redis.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private static hits = new Map<string, { n: number; resetAt: number }>();
  static reset() {
    RateLimitGuard.hits.clear();
  }

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const { authMax, windowMs } = this.config.rateLimit;
    const now = Date.now();
    const key = `${req.ip}|${req.path}`;
    const hits = RateLimitGuard.hits;
    if (hits.size > LIMITS.rateLimitCleanupThreshold) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    let e = hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { n: 0, resetAt: now + windowMs };
      hits.set(key, e);
    }
    e.n++;
    if (e.n > authMax) throw new HttpException({ message: 'Too many requests. Please wait and try again.' }, 429);
    return true;
  }
}
