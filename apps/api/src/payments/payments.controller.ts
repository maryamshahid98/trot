import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { PackagesService } from './packages.service.ts';
import { PaymentsService } from './payments.service.ts';

const STAFF = [ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER] as const;
const FAMILY_AND_STAFF = [ROLE.CUSTOMER, ...STAFF] as const;
const MANAGERS = [ROLE.MANAGER, ROLE.OWNER] as const;

@Controller()
export class PaymentsController {
  constructor(
    @Inject(PackagesService) private readonly packages: PackagesService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  // ----- package types (the price list) -----
  @Get('package-types') @Roles(...FAMILY_AND_STAFF)
  listTypes(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.packages.listTypes(q, u); }

  @Post('package-types') @Roles(...MANAGERS)
  createType(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.packages.createType(b, u); }

  @Patch('package-types/:id') @Roles(...MANAGERS)
  updateType(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.packages.updateType(id, b, u); }

  // ----- a rider's packages -----
  @Get('riders/:id/packages') @Roles(...FAMILY_AND_STAFF)
  riderPackages(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.packages.listForRider(id, u); }

  @Post('riders/:id/packages') @Roles(...STAFF)
  sell(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.packages.sell(id, b, u); }

  @Get('packages/:id/ledger') @Roles(...FAMILY_AND_STAFF)
  ledger(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.packages.ledger(id, u); }

  @Post('packages/:id/adjust') @Roles(...MANAGERS)
  adjust(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.packages.adjust(id, b, u); }

  @Post('packages/:id/status') @Roles(...MANAGERS)
  setStatus(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.packages.setStatus(id, b, u); }

  // ----- paying for a booking at the desk -----
  @Post('bookings/:id/payment') @Roles(...STAFF)
  pay(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.payments.recordPayment(id, b, u); }

  @Post('bookings/:id/confirm-unpaid') @Roles(...STAFF)
  confirmUnpaid(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.payments.confirmUnpaid(id, b, u); }

  // ----- receipts and adjustments -----
  /** Declared before ':id' so "mine" is never read as an id. */
  @Get('receipts/mine') @Roles(ROLE.CUSTOMER)
  myReceipts(@CurrentUser() u: AuthUser) { return this.payments.mine(u); }

  @Get('receipts') @Roles(...STAFF)
  receipts(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.payments.listReceipts(q, u); }

  @Get('receipts/:id') @Roles(...FAMILY_AND_STAFF)
  receipt(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.payments.getReceipt(id, u); }

  @Post('receipts/:id/adjustments') @Roles(...STAFF)
  adjustReceipt(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.payments.adjust(id, b, u); }
}
