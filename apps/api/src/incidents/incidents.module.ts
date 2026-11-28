import { Module } from '@nestjs/common';
import { fileStorageProvider } from '../riders/storage-provider.ts';
import { IncidentsController } from './incidents.controller.ts';
import { IncidentsService } from './incidents.service.ts';

@Module({ controllers: [IncidentsController], providers: [IncidentsService, fileStorageProvider] })
export class IncidentsModule {}
