import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { IncidentsService } from './incidents.service.ts';

const MANAGERS = [ROLE.MANAGER, ROLE.OWNER] as const;
const STAFF = [ROLE.COACH, ROLE.STABLE_HAND, ROLE.RECEPTION, ...MANAGERS] as const;

@Controller('incidents')
export class IncidentsController {
  constructor(@Inject(IncidentsService) private readonly incidents: IncidentsService) {}
  @Post() @Roles(...STAFF) create(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.incidents.create(b, u); }
  @Get() @Roles(...STAFF) list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.incidents.list(q, u); }
  @Get(':id') @Roles(...STAFF) get(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.incidents.get(id, u); }
  @Get(':id/history') @Roles(...STAFF) history(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.incidents.history(id, u); }
  @Post(':id/status') @Roles(...MANAGERS) status(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.incidents.setStatus(id, b, u); }
}
