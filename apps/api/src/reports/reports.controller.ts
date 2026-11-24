import { Controller, Get, Inject, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { ReportsService } from './reports.service.ts';

const MANAGERS = [ROLE.MANAGER, ROLE.OWNER] as const;

@Controller()
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}
  @Get('reports/revenue') @Roles(...MANAGERS) revenue(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.revenue(q, u); }
  @Get('reports/attendance') @Roles(...MANAGERS) attendance(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.attendance(q, u); }
  @Get('reports/utilisation') @Roles(...MANAGERS) utilisation(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.utilisation(q, u); }
  @Get('reports/rides') @Roles(...MANAGERS) rides(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.rides(q, u); }
  @Get('reports/unpaid') @Roles(...MANAGERS) unpaid(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.unpaid(q, u); }
  @Get('audit-log') @Roles(...MANAGERS) audit(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.reports.audit(q, u); }
}
