import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { AuthGuard } from './auth/auth.guard.ts';
import { AuthModule } from './auth/auth.module.ts';
import { BookingsModule } from './bookings/bookings.module.ts';
import { AdminModule } from './admin/admin.module.ts';
import { IncidentsModule } from './incidents/incidents.module.ts';
import { JobsModule } from './jobs/jobs.module.ts';
import { ReportsModule } from './reports/reports.module.ts';
import { RidesModule } from './rides/rides.module.ts';
import { HorsesModule } from './horses/horses.module.ts';
import { PaymentsModule } from './payments/payments.module.ts';
import { RidersModule } from './riders/riders.module.ts';
import { AllExceptionsFilter } from './common/all-exceptions.filter.ts';
import { ConfigModule } from './config/config.module.ts';
import { DbModule } from './db/db.module.ts';
import { HealthController } from './health/health.controller.ts';
import { ScheduleModule } from './schedule/schedule.module.ts';

@Module({
  imports: [ConfigModule, DbModule, AuthModule, ScheduleModule, BookingsModule, RidersModule, PaymentsModule, HorsesModule, AdminModule, JobsModule, ReportsModule, IncidentsModule, RidesModule],
  controllers: [HealthController],
  providers: [
    // Every route needs a signed-in user unless it is marked @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: any, res: any, next: () => void) => {
        req.id = randomUUID();
        res.setHeader('X-Request-Id', req.id);
        next();
      })
      .forRoutes('*');
  }
}
