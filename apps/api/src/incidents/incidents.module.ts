import { Module } from '@nestjs/common';
import { IncidentsController } from './incidents.controller.ts';
import { IncidentsService } from './incidents.service.ts';

@Module({ controllers: [IncidentsController], providers: [IncidentsService] })
export class IncidentsModule {}
