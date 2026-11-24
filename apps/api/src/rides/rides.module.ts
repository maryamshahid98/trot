import { Module } from '@nestjs/common';
import { ScheduleModule } from '../schedule/schedule.module.ts';
import { RidesController } from './rides.controller.ts';
import { RidesService } from './rides.service.ts';

@Module({ imports: [ScheduleModule], controllers: [RidesController], providers: [RidesService] })
export class RidesModule {}
