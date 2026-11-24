import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller.ts';
import { NotificationsModule } from '../notifications/notifications.controller.ts';
import { JobsService } from './jobs.service.ts';

@Module({ imports: [NotificationsModule], controllers: [JobsController], providers: [JobsService] })
export class JobsModule {}
