import { Module } from '@nestjs/common';
import { CronController } from './cron.controller.ts';
import { JobsController } from './jobs.controller.ts';
import { NotificationsModule } from '../notifications/notifications.controller.ts';
import { JobsService } from './jobs.service.ts';

@Module({ imports: [NotificationsModule], controllers: [JobsController, CronController], providers: [JobsService] })
export class JobsModule {}
