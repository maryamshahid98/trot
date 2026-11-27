import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { AccountsService } from './accounts.service.ts';
import { ArenasService } from './arenas.service.ts';
import { BranchesService } from './branches.service.ts';
import { LeaveService } from './leave.service.ts';
import { StaffService } from './staff.service.ts';

const MANAGERS = [ROLE.MANAGER, ROLE.OWNER] as const;
const STAFF = [ROLE.COACH, ROLE.STABLE_HAND, ROLE.RECEPTION, ...MANAGERS] as const;

@Controller('accounts')
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}
  @Get() @Roles(...MANAGERS) list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.accounts.list(q, u); }
  @Post() @Roles(...MANAGERS) create(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.accounts.create(b, u); }
  /** Declared before ':id' so "customers" is never read as an id. */
  @Get('customers') @Roles(ROLE.RECEPTION, ...MANAGERS) customers(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.accounts.searchCustomers(q, u); }
  @Post('customers') @Roles(ROLE.RECEPTION, ...MANAGERS) createCustomer(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.accounts.createCustomer(b, u); }
  @Get(':id') @Roles(...MANAGERS) get(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.accounts.get(id, u); }
  @Patch(':id') @Roles(...MANAGERS) update(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.accounts.update(id, b, u); }
  @Post(':id/role') @Roles(...MANAGERS) role(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.accounts.setRole(id, b, u); }
  @Post(':id/status') @Roles(...MANAGERS) status(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.accounts.setStatus(id, b, u); }
  @Post(':id/unlock') @Roles(...MANAGERS) unlock(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.accounts.unlock(id, u); }
  @Post(':id/mfa/reset') @Roles(...MANAGERS) resetMfa(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.accounts.resetMfa(id, u); }
  @Post(':id/reset-password') @Roles(...MANAGERS) reset(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.accounts.resetPassword(id, b, u); }
  @Put(':id/branches') @Roles(...MANAGERS) branches(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.accounts.setBranches(id, b, u); }
}

@Controller('organisation')
export class OrganisationController {
  constructor(@Inject(BranchesService) private readonly branches: BranchesService) {}
  @Get() @Roles(...STAFF) get(@CurrentUser() u: AuthUser) { return this.branches.organisation(u); }
  @Patch() @Roles(ROLE.OWNER) update(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.branches.updateOrganisation(b, u); }
}

@Controller('branches')
export class BranchesController {
  constructor(@Inject(BranchesService) private readonly branches: BranchesService) {}
  @Get() list(@CurrentUser() u: AuthUser) { return this.branches.list(u); }
  @Post() @Roles(ROLE.OWNER) create(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.branches.create(b, u); }
  @Get(':id') get(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.branches.get(id, u); }
  @Patch(':id') @Roles(...MANAGERS) update(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.branches.update(id, b, u); }
  @Get(':id/policy') @Roles(...STAFF) policy(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.branches.getPolicy(id, u); }
  @Patch(':id/policy') @Roles(...MANAGERS) setPolicy(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.branches.updatePolicy(id, b, u); }
}

@Controller('arenas')
export class ArenasController {
  constructor(@Inject(ArenasService) private readonly arenas: ArenasService) {}
  @Get() @Roles(...STAFF) list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.arenas.list(q, u); }
  @Post() @Roles(...MANAGERS) create(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.arenas.create(b, u); }
  @Patch(':id') @Roles(...MANAGERS) update(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.arenas.update(id, b, u); }
  @Get(':id/closures') @Roles(...STAFF) closures(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.arenas.listClosures(id, u); }
  @Post(':id/closures') @Roles(...MANAGERS) closure(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.arenas.createClosure(id, b, u); }
  @Delete(':id/closures/:closureId') @Roles(...MANAGERS) removeClosure(@Param('id') id: string, @Param('closureId') closureId: string, @CurrentUser() u: AuthUser) { return this.arenas.deleteClosure(id, closureId, u); }
}

@Controller('staff-leave')
export class LeaveController {
  constructor(@Inject(LeaveService) private readonly leave: LeaveService) {}
  @Get() @Roles(...STAFF) list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.leave.list(q, u); }
  @Post() @Roles(...STAFF) create(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.leave.create(b, u); }
  @Post(':id/decision') @Roles(...MANAGERS) decide(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.leave.decide(id, b, u); }
  @Delete(':id') @Roles(...STAFF) cancel(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.leave.cancel(id, u); }
}

@Controller('staff')
export class StaffController {
  constructor(@Inject(StaffService) private readonly staff: StaffService) {}
  @Get() @Roles(ROLE.RECEPTION, ...MANAGERS) list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.staff.list(q, u); }
  @Get(':id/profile') @Roles(...STAFF) profile(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.staff.profile(id, u); }
  @Put(':id/profile') @Roles(...MANAGERS) saveProfile(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.staff.saveProfile(id, b, u); }
}
