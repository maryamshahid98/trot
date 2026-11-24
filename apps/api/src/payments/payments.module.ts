import { Module } from '@nestjs/common';
import { PackagesService } from './packages.service.ts';
import { PaymentsController } from './payments.controller.ts';
import { PaymentsService } from './payments.service.ts';

@Module({ controllers: [PaymentsController], providers: [PackagesService, PaymentsService] })
export class PaymentsModule {}
