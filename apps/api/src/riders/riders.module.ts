import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service.ts';
import { DocumentsController, RidersController } from './riders.controller.ts';
import { RidersService } from './riders.service.ts';

@Module({ controllers: [RidersController, DocumentsController], providers: [RidersService, DocumentsService] })
export class RidersModule {}
