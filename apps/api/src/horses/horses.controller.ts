import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators.ts';
import type { AuthUser } from '../auth/decorators.ts';
import { ROLE } from '../config/constants.ts';
import { AssignmentsService } from './assignments.service.ts';
import { HorsesService } from './horses.service.ts';

const MANAGERS = [ROLE.MANAGER, ROLE.OWNER] as const;
const STABLE_TEAM = [ROLE.STABLE_HAND, ...MANAGERS] as const;
const HORSE_READERS = [ROLE.COACH, ROLE.STABLE_HAND, ROLE.RECEPTION, ...MANAGERS] as const;
const PLANNERS = [ROLE.COACH, ROLE.RECEPTION, ...MANAGERS] as const; // people who plan which horse rides in which class

@Controller('horses')
export class HorsesController {
  constructor(@Inject(HorsesService) private readonly horses: HorsesService) {}

  @Get() @Roles(...HORSE_READERS)
  list(@Query() q: unknown, @CurrentUser() u: AuthUser) { return this.horses.list(q, u); }

  @Post() @Roles(...MANAGERS)
  create(@Body() b: unknown, @CurrentUser() u: AuthUser) { return this.horses.create(b, u); }

  @Get(':id') @Roles(...HORSE_READERS)
  get(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.horses.get(id, u); }

  @Patch(':id') @Roles(...MANAGERS)
  update(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.horses.update(id, b, u); }

  @Post(':id/status') @Roles(...STABLE_TEAM)
  status(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.horses.setStatus(id, b, u); }

  @Get(':id/workload') @Roles(...HORSE_READERS)
  workload(@Param('id') id: string, @Query() q: unknown, @CurrentUser() u: AuthUser) { return this.horses.workload(id, q, u); }
}

/** Which horse rides in which class. These routes sit under the class they belong to. */
@Controller('schedule')
export class ClassHorsesController {
  constructor(@Inject(AssignmentsService) private readonly assignments: AssignmentsService) {}

  @Get(':id/horses') @Roles(...HORSE_READERS)
  list(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.assignments.list(id, u); }

  /** Declared before the ':assignmentId' route so "suggestions" is never read as an id. */
  @Get(':id/horses/suggestions') @Roles(...PLANNERS)
  suggestions(@Param('id') id: string, @Query() q: unknown, @CurrentUser() u: AuthUser) { return this.assignments.suggestions(id, q, u); }

  @Post(':id/horses') @Roles(...PLANNERS)
  assign(@Param('id') id: string, @Body() b: unknown, @CurrentUser() u: AuthUser) { return this.assignments.assign(id, b, u); }

  @Delete(':id/horses/:assignmentId') @Roles(...PLANNERS)
  unassign(@Param('id') id: string, @Param('assignmentId') assignmentId: string, @CurrentUser() u: AuthUser) { return this.assignments.unassign(id, assignmentId, u); }
}
