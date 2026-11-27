import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.ts';
import { ReportsService } from './reports.service.ts';
import { TableReportsService } from './table-reports.service.ts';

@Module({ controllers: [ReportsController], providers: [TableReportsService, ReportsService] })
export class ReportsModule {}
