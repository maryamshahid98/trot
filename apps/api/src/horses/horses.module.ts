import { Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service.ts';
import { ClassHorsesController, HorsesController } from './horses.controller.ts';
import { HorsesService } from './horses.service.ts';

@Module({ controllers: [HorsesController, ClassHorsesController], providers: [HorsesService, AssignmentsService] })
export class HorsesModule {}
