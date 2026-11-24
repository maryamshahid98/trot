import { Module } from '@nestjs/common';
import { AccountsController, ArenasController, BranchesController, LeaveController, StaffController } from './admin.controller.ts';
import { AccountsService } from './accounts.service.ts';
import { ArenasService } from './arenas.service.ts';
import { BranchesService } from './branches.service.ts';
import { StaffService } from './staff.service.ts';
import { LeaveService } from './leave.service.ts';

@Module({
  controllers: [AccountsController, BranchesController, ArenasController, LeaveController, StaffController],
  providers: [AccountsService, BranchesService, ArenasService, LeaveService, StaffService],
})
export class AdminModule {}
