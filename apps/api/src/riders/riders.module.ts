import { Module } from '@nestjs/common';
import { DocumentsService, WaiversService } from './documents.service.ts';
import { fileStorageProvider } from './storage-provider.ts';
import { DocumentsController, RidersController, WaiversController } from './riders.controller.ts';
import { RidersService } from './riders.service.ts';

@Module({ controllers: [RidersController, DocumentsController, WaiversController], providers: [WaiversService, RidersService, DocumentsService, fileStorageProvider] })
export class RidersModule {}
