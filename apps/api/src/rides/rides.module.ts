import { Module } from '@nestjs/common';
import { ScheduleModule } from '../schedule/schedule.module.ts';
import { RidesController } from './rides.controller.ts';
import { ClassTypesService } from './class-types.service.ts';
import { RidesService } from './rides.service.ts';

@Module({ imports: [ScheduleModule], controllers: [RidesController], providers: [ClassTypesService, RidesService] })
export class RidesModule {}
