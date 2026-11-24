import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service.ts';
import { FILE_STORAGE, LocalFileStorage } from './file-storage.ts';
import { DocumentsController, RidersController } from './riders.controller.ts';
import { RidersService } from './riders.service.ts';

@Module({ controllers: [RidersController, DocumentsController], providers: [RidersService, DocumentsService, { provide: FILE_STORAGE, useClass: LocalFileStorage }] })
export class RidersModule {}
