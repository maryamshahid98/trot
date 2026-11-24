import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { InvoicesService } from './invoices.service.ts';

const STAFF = [ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER] as const;

@Controller('invoices')
export class InvoicesController {
  constructor(@Inject(InvoicesService) private readonly svc: InvoicesService) {}

  @Get() @Roles(...STAFF)
  list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.svc.list(q, u); }

  /** A customer's own invoices (declared before :id so "mine" is not read as an id). */
  @Get('mine') @Roles(ROLE.CUSTOMER)
  mine(@CurrentUser() u: AuthUser) { return this.svc.mine(u); }

  @Get(':id') @Roles(...STAFF, ROLE.CUSTOMER)
  get(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.svc.get(id, u); }
}

/** A rider's account: charges, payments, credits and the balance. For staff, and for the rider's own family. */
@Controller('riders')
export class RiderAccountController {
  constructor(@Inject(InvoicesService) private readonly svc: InvoicesService) {}

  @Get(':id/account') @Roles(...STAFF, ROLE.CUSTOMER)
  account(@Param('id') id: string, @Query() q: unknown, @CurrentUser() u: AuthUser) { return this.svc.account(id, q, u); }
}
