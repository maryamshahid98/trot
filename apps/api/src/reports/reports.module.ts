import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.ts';
import { ReportsService } from './reports.service.ts';

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
