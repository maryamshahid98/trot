import { Module } from '@nestjs/common';
import { ScheduleController } from './schedule.controller.ts';
import { ScheduleService } from './schedule.service.ts';

// Exported so rides are put on the schedule by the very same code (same clash, closure, leave and override checks).
@Module({ controllers: [ScheduleController], providers: [ScheduleService], exports: [ScheduleService] })
export class ScheduleModule {}
