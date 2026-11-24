import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators.ts';
import { SkipRateLimit } from '../common/general-rate-limit.guard.ts';
import { DbService } from '../db/db.service.ts';

@Controller('health')
export class HealthController {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  @Get()
  @Public()
  @SkipRateLimit()
  async check() {
    try {
      await this.db.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    }
    try {
      const r = await this.db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1');
      return { status: 'ok', database: 'up', schemaVersion: r.rows[0]?.name ?? null };
    } catch {
      return { status: 'ok', database: 'up', schemaVersion: null, warning: 'Run npm run db:migrate' };
    }
  }
}
