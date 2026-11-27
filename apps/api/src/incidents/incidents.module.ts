import { Module } from '@nestjs/common';
import { FILE_STORAGE, LocalFileStorage } from '../riders/file-storage.ts';
import { IncidentsController } from './incidents.controller.ts';
import { IncidentsService } from './incidents.service.ts';

@Module({ controllers: [IncidentsController], providers: [IncidentsService, { provide: FILE_STORAGE, useClass: LocalFileStorage }] })
export class IncidentsModule {}
