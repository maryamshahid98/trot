import { Module } from '@nestjs/common';
import { DocumentsService, WaiversService } from './documents.service.ts';
import { FILE_STORAGE, LocalFileStorage } from './file-storage.ts';
import { DocumentsController, RidersController, WaiversController } from './riders.controller.ts';
import { RidersService } from './riders.service.ts';

@Module({ controllers: [RidersController, DocumentsController, WaiversController], providers: [WaiversService, RidersService, DocumentsService, { provide: FILE_STORAGE, useClass: LocalFileStorage }] })
export class RidersModule {}
