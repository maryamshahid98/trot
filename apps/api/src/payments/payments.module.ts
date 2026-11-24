import { Module } from '@nestjs/common';
import { InvoicesController, RiderAccountController } from './invoices.controller.ts';
import { InvoicesService } from './invoices.service.ts';
import { PackagesService } from './packages.service.ts';
import { PaymentsController } from './payments.controller.ts';
import { PaymentsService } from './payments.service.ts';

@Module({ controllers: [PaymentsController, InvoicesController, RiderAccountController], providers: [PackagesService, PaymentsService, InvoicesService] })
export class PaymentsModule {}
