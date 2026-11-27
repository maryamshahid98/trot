import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { ApiRequest } from '../common/http.ts';
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
  @Get(':id/detail') @Roles(...STAFF) detail(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.incidents.detail(id, u); }
  @Patch(':id') @Roles(ROLE.RECEPTION, ...MANAGERS) update(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.incidents.update(id, b, u); }
  @Post(':id/actions') @Roles(...MANAGERS) addAction(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.incidents.addAction(id, b, u); }
  @Post(':id/actions/:actionId/done') @Roles(...MANAGERS) done(@Param('id') id: string, @Param('actionId') a: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.incidents.completeAction(id, a, b, u); }
  @Put(':id/file') @Roles(...STAFF) attach(@Param('id') id: string, @Req() req: ApiRequest, @CurrentUser() u: AuthUser) { return this.incidents.attach(id, req.body, req.headers['x-file-name'] as string | undefined, u); }
  @Get(':id/files/:fileId') @Roles(...STAFF) file(@Param('id') id: string, @Param('fileId') f: string, @CurrentUser() u: AuthUser) { return this.incidents.file(id, f, u); }
  @Get(':id/history') @Roles(...STAFF) history(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.incidents.history(id, u); }
  @Post(':id/status') @Roles(...MANAGERS) status(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.incidents.setStatus(id, b, u); }
}
