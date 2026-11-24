import { Body, Controller, Get, HttpCode, Inject, Module, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { NotificationsService } from './notifications.service.ts';

const MANAGERS = [ROLE.MANAGER, ROLE.OWNER] as const;

@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly svc: NotificationsService) {}

  /** Who was told what, and whether it arrived. For managers and owners. */
  @Get() @Roles(...MANAGERS)
  list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.svc.list(q, u); }

  /** Sends what is waiting now, instead of waiting for the background job. */
  @Post('dispatch') @HttpCode(200) @Roles(...MANAGERS)
  dispatch(@CurrentUser() u: AuthUser) { return this.svc.dispatchFor(u); }

  /** My own choices for reminders. Any signed-in person. */
  @Get('preferences')
  preferences(@CurrentUser() u: AuthUser) { return this.svc.getPreferences(u); }

  @Put('preferences')
  setPreferences(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.svc.setPreferences(b, u); }

  @Post(':id/retry') @HttpCode(200) @Roles(...MANAGERS)
  retry(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.svc.retry(id, u); }
}

@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
