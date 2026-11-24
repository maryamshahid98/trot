import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { AttendanceService } from './attendance.service.ts';
import { BookingsService } from './bookings.service.ts';
import { WaitlistService } from './waitlist.service.ts';

const STAFF = [ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER] as const;
const FAMILY_AND_STAFF = [ROLE.CUSTOMER, ...STAFF] as const;
const RUNNERS = [ROLE.COACH, ...STAFF] as const; // people who run a class

@Controller('bookings')
export class BookingsController {
  constructor(
    @Inject(BookingsService) private readonly svc: BookingsService,
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
  ) {}

  @Post() @Roles(...FAMILY_AND_STAFF)
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.create(body, user); }

  @Post(':id/cancel') @Roles(...FAMILY_AND_STAFF)
  cancel(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.cancel(id, body, user); }

  @Post(':id/check-in') @Roles(...RUNNERS)
  checkIn(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.attendance.checkIn(id, user); }

  @Post(':id/no-show') @Roles(...RUNNERS)
  noShow(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.attendance.noShow(id, user); }

  /** Declared before any `:id` GET so "mine" is never read as an id. */
  @Get('mine') @Roles(ROLE.CUSTOMER)
  mine(@CurrentUser() user: AuthUser) { return this.svc.mine(user); }

  @Get() @Roles(...RUNNERS)
  roster(@Query() query: unknown, @CurrentUser() user: AuthUser) { return this.svc.roster(query, user); }
}

@Controller('waitlist')
export class WaitlistController {
  constructor(@Inject(WaitlistService) private readonly svc: WaitlistService) {}

  @Post(':id/accept') @Roles(...FAMILY_AND_STAFF)
  accept(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.accept(id, body, user); }

  @Post(':id/leave') @Roles(...FAMILY_AND_STAFF)
  leave(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.svc.leave(id, user); }
}

/** Class lifecycle. These routes live beside the schedule but are about running a class, so they sit with attendance. */
@Controller('schedule')
export class ClassLifecycleController {
  constructor(
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(WaitlistService) private readonly waitlist: WaitlistService,
  ) {}

  @Post(':id/complete') @Roles(...RUNNERS)
  complete(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.attendance.completeClass(id, body, user); }

  @Post(':id/cancel') @Roles(ROLE.MANAGER, ROLE.OWNER)
  cancel(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.attendance.cancelClass(id, body, user); }

  @Post('series/:seriesId/cancel') @Roles(ROLE.MANAGER, ROLE.OWNER)
  cancelSeries(@Param('seriesId') seriesId: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.attendance.cancelSeries(seriesId, body, user); }

  @Post(':id/waitlist/refresh') @Roles(...STAFF)
  refresh(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.waitlist.refresh(id, user); }
}
