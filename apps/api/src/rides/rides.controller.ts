import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Delete } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { ClassTypesService } from './class-types.service.ts';
import { RidesService } from './rides.service.ts';

const MANAGERS = [ROLE.MANAGER, ROLE.OWNER] as const;
const SCHEDULERS = [ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER] as const;
/** Everyone signed in may read the ride list. Customers only see rides that are on sale. */
const READERS = [ROLE.CUSTOMER, ROLE.COACH, ROLE.STABLE_HAND, ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER] as const;

@Controller()
export class RidesController {
  constructor(@Inject(RidesService) private readonly svc: RidesService, @Inject(ClassTypesService) private readonly catalogue: ClassTypesService) {}

  // ----- the ride catalogue -----
  @Get('ride-types') @Roles(...READERS)
  list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.svc.list(q, u); }

  @Post('ride-types') @Roles(...MANAGERS)
  create(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.svc.create(b, u); }

  @Get('ride-types/:id') @Roles(...READERS)
  get(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.svc.get(id, u); }

  @Patch('ride-types/:id') @Roles(...MANAGERS)
  update(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.svc.update(id, b, u); }

  // ----- putting a ride on the schedule. Booking, paying, check-in and cancelling use the normal booking and schedule endpoints. -----
  @Post('ride-types/:id/rates') @Roles(...MANAGERS)
  addRate(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.svc.addRate(id, body, user); }

  @Delete('ride-types/:id/rates/:rateId') @Roles(...MANAGERS)
  removeRate(@Param('id') id: string, @Param('rateId') rateId: string, @CurrentUser() user: AuthUser) { return this.svc.removeRate(id, rateId, user); }

  // ----- the class catalogue -----
  @Get('class-types') @Roles(...READERS)
  classTypes(@Query() query: unknown, @CurrentUser() user: AuthUser) { return this.catalogue.list(query, user); }

  @Post('class-types') @Roles(...MANAGERS)
  addClassType(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.catalogue.create(body, user); }

  @Patch('class-types/:id') @Roles(...MANAGERS)
  changeClassType(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) { return this.catalogue.update(id, body, user); }

  @Post('rides') @Roles(...SCHEDULERS)
  schedule(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.svc.schedule(b, u); }
}
