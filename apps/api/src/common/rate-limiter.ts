import { Inject, Injectable } from '@nestjs/common';
import { LIMITS } from '../config/constants.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';
import { DbService } from '../db/db.service.ts';

/**
 * Counts requests per key in the database, so the limit holds however many API servers run.
 * One atomic statement per call: it starts a new window when the old one has ended, and otherwise adds one.
 */
@Injectable()
export class RateLimiter {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Counts this request. Returns true when it is allowed, false when `max` requests were already made in the window. */
  async allow(key: string, max: number, windowMs: number): Promise<boolean> {
    const r = await this.db.query<{ hits: number }>(
      `INSERT INTO rate_limits AS r (key, hits, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2::double precision))
       ON CONFLICT (key) DO UPDATE
         SET hits = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.hits + 1 END,
             reset_at = CASE WHEN r.reset_at <= now() THEN now() + make_interval(secs => $2::double precision) ELSE r.reset_at END
       RETURNING hits`,
      [this.config.rateLimit.keyPrefix + key, windowMs / 1000],
    );
    if (Math.random() < LIMITS.rateLimitSweepChance) void this.sweep();
    return r.rows[0].hits <= max;
  }

  /** Removes windows that have ended, so the table does not grow without bound. A failure here is harmless. */
  private async sweep() {
    try {
      await this.db.query(`DELETE FROM rate_limits WHERE reset_at <= now()`);
    } catch {
      /* try again on a later call */
    }
  }
}
