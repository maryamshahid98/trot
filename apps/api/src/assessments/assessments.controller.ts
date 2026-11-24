import { Body, Controller, Get, HttpCode, Inject, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { AssessmentsService } from './assessments.service.ts';

const MANAGERS = [ROLE.MANAGER, ROLE.OWNER] as const;
const ASSESSORS = [ROLE.COACH, ROLE.MANAGER, ROLE.OWNER] as const;
const STAFF = [ROLE.COACH, ROLE.RECEPTION, ROLE.MANAGER, ROLE.OWNER] as const;

@Controller('skills')
export class SkillsController {
  constructor(@Inject(AssessmentsService) private readonly svc: AssessmentsService) {}

  @Get() @Roles(...STAFF)
  list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.svc.listSkills(q, u); }

  @Post() @Roles(...MANAGERS)
  create(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.svc.createSkill(b, u); }

  @Patch(':id') @Roles(...MANAGERS)
  update(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.svc.updateSkill(id, b, u); }
}

@Controller('assessments')
export class AssessmentsController {
  constructor(@Inject(AssessmentsService) private readonly svc: AssessmentsService) {}

  @Get() @Roles(...STAFF)
  list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.svc.list(q, u); }

  @Post() @Roles(...ASSESSORS)
  create(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.svc.create(b, u); }

  @Get(':id') @Roles(...STAFF)
  get(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.svc.get(id, u); }

  @Put(':id') @Roles(...ASSESSORS)
  update(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.svc.update(id, b, u); }

  @Post(':id/submit') @HttpCode(200) @Roles(...ASSESSORS)
  submit(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.svc.submit(id, u); }

  @Post(':id/decision') @HttpCode(200) @Roles(...MANAGERS)
  decide(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.svc.decide(id, b, u); }
}

/** A rider's level, level history and approved assessments: for staff, and for the rider's own family. */
@Controller('riders')
export class RiderProgressController {
  constructor(@Inject(AssessmentsService) private readonly svc: AssessmentsService) {}

  @Get(':id/progress') @Roles(...STAFF, ROLE.CUSTOMER)
  progress(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.svc.progress(id, u); }
}

@Module({ controllers: [SkillsController, AssessmentsController, RiderProgressController], providers: [AssessmentsService], exports: [AssessmentsService] })
export class AssessmentsModule {}
