import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { AuthGuard } from './auth/auth.guard.ts';
import { AuthModule } from './auth/auth.module.ts';
import { BookingsModule } from './bookings/bookings.module.ts';
import { AdminModule } from './admin/admin.module.ts';
import { IncidentsModule } from './incidents/incidents.module.ts';
import { AssessmentsModule } from './assessments/assessments.controller.ts';
import { JobsModule } from './jobs/jobs.module.ts';
import { NotificationsModule } from './notifications/notifications.controller.ts';
import { ReportsModule } from './reports/reports.module.ts';
import { RidesModule } from './rides/rides.module.ts';
import { HorsesModule } from './horses/horses.module.ts';
import { PaymentsModule } from './payments/payments.module.ts';
import { RidersModule } from './riders/riders.module.ts';
import { AllExceptionsFilter } from './common/all-exceptions.filter.ts';
import { CommonModule } from './common/common.module.ts';
import { GeneralRateLimitGuard } from './common/general-rate-limit.guard.ts';
import { ConfigModule } from './config/config.module.ts';
import { DbModule } from './db/db.module.ts';
import { HealthController } from './health/health.controller.ts';
import { ScheduleModule } from './schedule/schedule.module.ts';
import type { ApiRequest, ApiResponse } from './common/http.ts';

@Module({
  imports: [ConfigModule, DbModule, CommonModule, AuthModule, ScheduleModule, BookingsModule, RidersModule, PaymentsModule, HorsesModule, AdminModule, JobsModule, ReportsModule, IncidentsModule, RidesModule, NotificationsModule, AssessmentsModule],
  controllers: [HealthController],
  providers: [
    // Guards run in this order: first the per-address ceiling, then the sign-in check.
    { provide: APP_GUARD, useClass: GeneralRateLimitGuard },
    // Every route needs a signed-in user unless it is marked @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: ApiRequest, res: ApiResponse, next: () => void) => {
        req.id = randomUUID();
        res.setHeader('X-Request-Id', req.id);
        next();
      })
      .forRoutes('*');
  }
}
