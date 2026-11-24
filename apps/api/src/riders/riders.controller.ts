import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { DocumentsService } from './documents.service.ts';
import { RidersService } from './riders.service.ts';

const STAFF = [ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER] as const;
const FAMILY_AND_STAFF = [ROLE.CUSTOMER, ...STAFF] as const;

@Controller('riders')
export class RidersController {
  constructor(
    @Inject(RidersService) private readonly riders: RidersService,
    @Inject(DocumentsService) private readonly docs: DocumentsService,
  ) {}

  @Post() @Roles(...FAMILY_AND_STAFF)
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.riders.create(body, user); }

  /** Declared before ':id' so "mine" is never read as an id. */
  @Get('mine') @Roles(ROLE.CUSTOMER)
  mine(@CurrentUser() user: AuthUser) { return this.riders.mine(user); }

  @Get() @Roles(...STAFF)
  list(@Query() query: unknown, @CurrentUser() user: AuthUser) { return this.riders.list(query, user); }

  @Get(':id') @Roles(...FAMILY_AND_STAFF)
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.riders.get(id, user); }

  @Patch(':id') @Roles(...FAMILY_AND_STAFF)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.riders.update(id, body, user); }

  @Post(':id/level') @Roles(ROLE.COACH, ROLE.MANAGER, ROLE.OWNER)
  level(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.riders.setLevel(id, body, user); }

  @Post(':id/status') @Roles(...STAFF)
  status(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.riders.setStatus(id, body, user); }

  @Get(':id/guardians') @Roles(...STAFF)
  guardians(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.riders.guardians(id, user); }

  @Post(':id/guardians') @Roles(...STAFF)
  addGuardian(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.riders.addGuardian(id, body, user); }

  @Delete(':id/guardians/:accountId') @Roles(...STAFF)
  removeGuardian(@Param('id') id: string, @Param('accountId') accountId: string, @CurrentUser() user: AuthUser) { return this.riders.removeGuardian(id, accountId, user); }

  @Get(':id/documents') @Roles(...FAMILY_AND_STAFF)
  documents(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.docs.list(id, user); }

  @Post(':id/documents') @Roles(...FAMILY_AND_STAFF)
  submit(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.docs.submit(id, body, user); }
}

@Controller('documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly docs: DocumentsService) {}

  @Post(':id/verify') @Roles(...STAFF)
  verify(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.docs.verify(id, user); }

  @Post(':id/reject') @Roles(...STAFF)
  reject(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.docs.reject(id, body, user); }
}
