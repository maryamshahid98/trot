import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { checkHorse, MS } from '@trot/domain';
import type { Horse, Occurrence, Reason } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { lockOccurrence, LIVE, toOccurrence } from '../bookings/core.ts';
import type { Tx } from '../bookings/core.ts';
import { loadPolicy } from '../common/policy.ts';
import { writeAudit } from '../common/audit.ts';
import { dayKeyFor, epochMs } from '../common/sql.ts';
import { parse } from '../common/validate.ts';
import { AUDIT, ENTITY, HORSE_PROBLEM, HORSE_STATUS, LIMITS, OCCURRENCE_STATUS, OVERRIDABLE_HORSE_CODES, PG_ERROR, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { AssignHorse, AssignmentParams, IdParam, SuggestQuery } from './horses.schemas.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const iso = (ms: number) => new Date(ms).toISOString();
const isManager = (u: AuthUser) => u.role === ROLE.MANAGER || u.role === ROLE.OWNER;
const WINDOW = 8 * MS.day; // enough to see the same club week and the neighbouring days

@Injectable()
export class AssignmentsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** The class, locked. A coach finds only their own classes; a closed class can no longer be changed. */
  private async openClass(c: Tx, rawId: string, user: AuthUser, now: number) {
    const { id } = parse(IdParam, { id: rawId });
    const row = await lockOccurrence(c, id);
    if (!row || (user.role === ROLE.COACH && row.coachId !== user.id)) throw new NotFoundException('Class not found.');
    const occ = toOccurrence(row) as Occurrence & { branchId: string };
    occ.branchId = row.branchId;
    const open = (occ.status === OCCURRENCE_STATUS.PUBLISHED || occ.status === OCCURRENCE_STATUS.IN_PROGRESS) && now < occ.endsAt;
    return { occ, open };
  }

  private async horseFor(c: Tx, horseId: string, lock: boolean): Promise<Horse | undefined> {
    const h = (
      await c.query(
        `SELECT h.id, h.status, h.suitable_levels::text[] AS "suitableLevels", coalesce(array(SELECT ha.arena_id FROM horse_arenas ha WHERE ha.horse_id = h.id), '{}') AS "suitableArenaIds"
           FROM horses h WHERE h.id = $1${lock ? ' FOR UPDATE OF h' : ''}`,
        [horseId],
      )
    ).rows[0];
    return h as Horse | undefined;
  }

  /** Every workload and suitability rule for one horse and one class, returned together. */
  private async reasonsFor(c: Tx, occ: Occurrence & { branchId: string }, horse: Horse, riderLevels: string[], now: number): Promise<Reason[]> {
    const rows = (
      await c.query(
        `SELECT ha.occurrence_id AS "occurrenceId", ha.horse_id AS "horseId", ${epochMs('lower(ha.during)')} AS "startsAt", ${epochMs('upper(ha.during)')} AS "endsAt"
           FROM horse_assignments ha JOIN occurrences o ON o.id = ha.occurrence_id
          WHERE ha.horse_id = $1 AND o.status <> $4 AND ha.during && tstzrange($2::timestamptz, $3::timestamptz)`,
        [horse.id, iso(occ.startsAt - WINDOW), iso(occ.endsAt + WINDOW), OCCURRENCE_STATUS.CANCELLED],
      )
    ).rows;
    const tz = (await c.query(`SELECT time_zone FROM branches WHERE id = $1`, [occ.branchId])).rows[0]?.time_zone as string;
    void now;
    return checkHorse({
      horse, occurrence: occ, riderLevels: riderLevels as any, policy: await loadPolicy(c, occ.branchId), dayKeyOf: dayKeyFor(tz),
      assignments: rows.map((a: any) => ({ ...a, startsAt: Number(a.startsAt), endsAt: Number(a.endsAt) })),
    }).reasons;
  }

  async list(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const occ = (await c.query(`SELECT id, coach_id AS "coachId" FROM occurrences WHERE id = $1`, [id])).rows[0];
      if (!occ || (user.role === ROLE.COACH && occ.coachId !== user.id)) throw new NotFoundException('Class not found.');
      const rows = (
        await c.query(
          `SELECT ha.id, ha.horse_id AS "horseId", h.name AS "horseName", h.status AS "horseStatus", ha.rider_id AS "riderId", r.full_name AS "riderName"
             FROM horse_assignments ha JOIN horses h ON h.id = ha.horse_id LEFT JOIN riders r ON r.id = ha.rider_id WHERE ha.occurrence_id = $1 ORDER BY h.name`,
          [id],
        )
      ).rows;
      return { assignments: rows };
    });
  }

  async assign(rawId: string, body: unknown, user: AuthUser) {
    const b = parse(AssignHorse, body);
    const now = Date.now();
    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const { occ, open } = await this.openClass(c, rawId, user, now);
        if (!open) throw new ConflictException(problem('This class is closed, so its horses can no longer be changed.', HORSE_PROBLEM.CLASS_CLOSED));

        // The rider must be in the class, and rides one horse at a time.
        let riderLevels: string[];
        if (b.riderId) {
          const r = (
            await c.query(
              `SELECT r.level FROM riders r WHERE r.id = $1 AND EXISTS (SELECT 1 FROM bookings bk WHERE bk.rider_id = r.id AND bk.occurrence_id = $2 AND bk.status = ANY($3::booking_status[]))`,
              [b.riderId, occ.id, LIVE],
            )
          ).rows[0];
          if (!r) throw new UnprocessableEntityException(problem('That rider is not booked into this class.', HORSE_PROBLEM.RIDER_NOT_IN_CLASS));
          if ((await c.query(`SELECT 1 FROM horse_assignments WHERE occurrence_id = $1 AND rider_id = $2`, [occ.id, b.riderId])).rowCount) {
            throw new ConflictException(problem('That rider already has a horse for this class. Remove it first to change.', HORSE_PROBLEM.RIDER_HAS_HORSE));
          }
          riderLevels = [r.level];
        } else {
          riderLevels = (
            await c.query(`SELECT DISTINCT r.level FROM bookings bk JOIN riders r ON r.id = bk.rider_id WHERE bk.occurrence_id = $1 AND bk.status = ANY($2::booking_status[])`, [occ.id, LIVE])
          ).rows.map((x: any) => x.level);
        }

        // Lock the horse so two people planning its week at the same moment count its sessions one after the other.
        const horse = await this.horseFor(c, b.horseId, true);
        if (!horse) throw new NotFoundException(problem('Horse not found.', HORSE_PROBLEM.HORSE_NOT_FOUND));

        const reasons = await this.reasonsFor(c, occ, horse, riderLevels, now);
        let overridden = false;
        if (reasons.length > 0) {
          if (!b.override) throw new UnprocessableEntityException({ message: 'This horse cannot be used for this class.', problems: reasons });
          if (!isManager(user)) throw new ForbiddenException('Only a manager can knowingly go past a horse workload limit.');
          const hard = reasons.filter((r) => !(OVERRIDABLE_HORSE_CODES as readonly string[]).includes(r.code));
          if (hard.length > 0) throw new UnprocessableEntityException({ message: 'Safety rules cannot be overridden.', problems: hard.map((r) => ({ ...r, notOverridable: true })) });
          overridden = true;
        }

        const ins = (
          await c.query(`INSERT INTO horse_assignments (occurrence_id, horse_id, rider_id, during) SELECT id, $2, $3, during FROM occurrences WHERE id = $1 RETURNING id`, [occ.id, b.horseId, b.riderId ?? null])
        ).rows[0];
        await writeAudit(c, user, occ.branchId, overridden ? AUDIT.HORSE_ASSIGN_OVERRIDE : AUDIT.HORSE_ASSIGN, ENTITY.ASSIGNMENT, ins.id, {
          occurrenceId: occ.id, horseId: b.horseId, riderId: b.riderId ?? null, ...(overridden ? { overridden: reasons.map((r) => r.code), reason: b.override!.reason } : {}),
        });
        return { id: ins.id as string, overridden, problems: overridden ? reasons : [] };
      });
    } catch (e: any) {
      // The database is the last line of defence if two people give the same horse to two classes at the same moment.
      if (e?.code === PG_ERROR.EXCLUSION_VIOLATION) throw new ConflictException(problem('That horse was just given to another class at this time.', HORSE_PROBLEM.HORSE_BUSY));
      if (e?.code === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException(problem('That rider already has a horse for this class.', HORSE_PROBLEM.RIDER_HAS_HORSE));
      throw e;
    }
  }

  async unassign(rawId: string, rawAssignmentId: string, user: AuthUser) {
    const { assignmentId } = parse(AssignmentParams, { id: rawId, assignmentId: rawAssignmentId });
    const now = Date.now();
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const { occ, open } = await this.openClass(c, rawId, user, now);
      const a = (await c.query(`SELECT id, horse_id AS "horseId", rider_id AS "riderId" FROM horse_assignments WHERE id = $1 AND occurrence_id = $2 FOR UPDATE`, [assignmentId, occ.id])).rows[0];
      if (!a) throw new NotFoundException(problem('That assignment was not found.', HORSE_PROBLEM.ASSIGNMENT_NOT_FOUND));
      if (!open) throw new ConflictException(problem('This class is closed, so its horses can no longer be changed.', HORSE_PROBLEM.CLASS_CLOSED));
      await c.query(`DELETE FROM horse_assignments WHERE id = $1`, [assignmentId]);
      await writeAudit(c, user, occ.branchId, AUDIT.HORSE_UNASSIGN, ENTITY.ASSIGNMENT, assignmentId, { occurrenceId: occ.id, horseId: a.horseId, riderId: a.riderId });
      return { id: assignmentId, removed: true };
    });
  }

  /** Which horses could take this class (and for a given rider), and why the others cannot. Staff use it to pick. */
  async suggestions(rawId: string, query: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const q = parse(SuggestQuery, query);
    const now = Date.now();
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const { occ } = await this.openClass(c, id, user, now);
      let riderLevels: string[];
      if (q.riderId) {
        const r = (await c.query(`SELECT r.level FROM riders r WHERE r.id = $1 AND EXISTS (SELECT 1 FROM bookings bk WHERE bk.rider_id = r.id AND bk.occurrence_id = $2 AND bk.status = ANY($3::booking_status[]))`, [q.riderId, occ.id, LIVE])).rows[0];
        if (!r) throw new UnprocessableEntityException(problem('That rider is not booked into this class.', HORSE_PROBLEM.RIDER_NOT_IN_CLASS));
        riderLevels = [r.level];
      } else {
        riderLevels = (await c.query(`SELECT DISTINCT r.level FROM bookings bk JOIN riders r ON r.id = bk.rider_id WHERE bk.occurrence_id = $1 AND bk.status = ANY($2::booking_status[])`, [occ.id, LIVE])).rows.map((x: any) => x.level);
      }
      const horses = (await c.query(`SELECT h.id, h.name FROM horses h WHERE h.branch_id = $1 AND h.status <> $2 ORDER BY h.name LIMIT $3`, [occ.branchId, HORSE_STATUS.RETIRED, LIMITS.horseSuggestionsMax])).rows;
      const suitable: { id: string; name: string }[] = [];
      const unsuitable: { id: string; name: string; problems: Reason[] }[] = [];
      for (const h of horses) {
        const horse = (await this.horseFor(c, h.id, false))!;
        const reasons = await this.reasonsFor(c, occ, horse, riderLevels, now);
        if (reasons.length === 0) suitable.push({ id: h.id, name: h.name });
        else unsuitable.push({ id: h.id, name: h.name, problems: reasons });
      }
      return { suitable, unsuitable };
    });
  }
}
