import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { TableReportsService } from './table-reports.service.ts';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { ReportsService } from './reports.service.ts';

const MANAGERS = [ROLE.MANAGER, ROLE.OWNER] as const;

@Controller()
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService, @Inject(TableReportsService) private readonly tables: TableReportsService) {}
  @Get('reports/revenue') @Roles(...MANAGERS) revenue(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.revenue(q, u); }
  @Get('reports/attendance') @Roles(...MANAGERS) attendance(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.attendance(q, u); }
  @Get('reports/utilisation') @Roles(...MANAGERS) utilisation(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.utilisation(q, u); }
  @Get('reports/rides') @Roles(...MANAGERS) rides(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.rides(q, u); }
  @Get('reports/unpaid') @Roles(...MANAGERS) unpaid(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.unpaid(q, u); }
  /** The daily sheet is for everyone who runs the day; the other reports are for managers (the service decides). */
  @Get('reports/table/:name') @Roles(ROLE.COACH, ROLE.STABLE_HAND, ROLE.RECEPTION, ...MANAGERS) table(@Param('name') n: string, @Query() q: unknown, @CurrentUser() u: AuthUser) { return this.tables.run(n, q, u); }
  @Get('audit-log') @Roles(...MANAGERS) audit(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.audit(q, u); }
}
