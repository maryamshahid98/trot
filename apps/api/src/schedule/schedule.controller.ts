import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { ScheduleService } from './schedule.service.ts';

@Controller('schedule')
export class ScheduleController {
  constructor(@Inject(ScheduleService) private readonly svc: ScheduleService) {}

  /** GET /schedule?from=...&to=...&branchId=...   Any signed-in user. Customers see published classes only. */
  @Get()
  list(@Query() query: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.list(query, user);
  }

  @Post()
  @Roles(ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER)
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.create(body, user);
  }

  /** Move, re-staff or edit a session that has not started. Everything is checked again and booked riders are told. */
  @Patch(':id')
  @Roles(ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.change(id, body, user);
  }

  /** Makes a draft bookable, after the same checks. */
  @Post(':id/publish')
  @Roles(ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER)
  publish(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.change(id, body, user, true);
  }

  /** A class that repeats every 1 to 4 weeks. See ScheduleService.createSeries for the all-or-nothing, skip and check-only options. */
  @Post('series')
  @Roles(ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER)
  createSeries(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.svc.createSeries(body, user);
  }
}
