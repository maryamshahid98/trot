// Builders for the booking tests. They write straight to the database as the superuser, so a test's setup never depends on the API under test.
import { BRANCH, ctx, makeAccount } from './helpers.ts';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Documents and packages here last until this date. randomDay() reaches into 2048, so a shorter life made tests fail at random. */
export const LONG_LIVED_UNTIL = '2060-01-01';

export async function makeRider(o: { branchId?: string; accountId?: string | null; dob?: string; status?: string; level?: string; name?: string } = {}): Promise<string> {
  return (
    await ctx.admin.query(
      `INSERT INTO riders (branch_id, account_id, full_name, date_of_birth, level, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [o.branchId ?? BRANCH, o.accountId ?? null, o.name ?? 'Test Rider', o.dob ?? '1990-01-01', o.level ?? 'beginner', o.status ?? 'active'],
    )
  ).rows[0].id;
}

/** A medical form and a waiver that a staff member has verified. Pass `only` to give just one of them, or `expired` for an old form. */
export async function verifyDocs(riderId: string, o: { medical?: boolean; waiver?: boolean; medicalExpiresAt?: string | null; status?: string } = {}) {
  const status = o.status ?? 'verified';
  if (o.medical !== false) {
    await ctx.admin.query(`INSERT INTO rider_documents (rider_id, kind, status, signed_at, expires_at) VALUES ($1,'medical_form',$2,now(),$3)`, [
      riderId, status, o.medicalExpiresAt === undefined ? LONG_LIVED_UNTIL : o.medicalExpiresAt,
    ]);
  }
  if (o.waiver !== false) await ctx.admin.query(`INSERT INTO rider_documents (rider_id, kind, status, signed_at) VALUES ($1,'waiver',$2,now())`, [riderId, status]);
}

export async function guard(guardianAccountId: string, riderId: string) {
  await ctx.admin.query(`INSERT INTO guardian_riders (guardian_account_id, rider_id) VALUES ($1,$2)`, [guardianAccountId, riderId]);
}

/** A rider who may book: active, adult, with verified documents. */
export async function readyRider(o: { accountId?: string | null; branchId?: string; level?: string } = {}) {
  const id = await makeRider({ accountId: o.accountId, branchId: o.branchId, level: o.level });
  await verifyDocs(id);
  return id;
}

let coachId: string | undefined;
export async function theCoach(): Promise<string> {
  coachId ??= (await makeAccount({ role: 'coach' })).id;
  return coachId;
}

export async function makeClass(o: { branchId?: string; startsAt: number; hours?: number; capacity?: number; status?: string; format?: string; minLevel?: string; coachId?: string; arenaId?: string }): Promise<string> {
  const branchId = o.branchId ?? BRANCH;
  const arena = o.arenaId ?? (await ctx.admin.query(`INSERT INTO arenas (branch_id, name, max_capacity) VALUES ($1,'Test arena',20) RETURNING id`, [branchId])).rows[0].id;
  const iso = (ms: number) => new Date(ms).toISOString();
  return (
    await ctx.admin.query(
      `INSERT INTO occurrences (branch_id, title, format, min_level, arena_id, coach_id, during, capacity, status, allow_overlap)
       VALUES ($1,'Test class',$2,$3,$4,$5,tstzrange($6::timestamptz,$7::timestamptz),$8,$9,true) RETURNING id`,
      [branchId, o.format ?? 'group', o.minLevel ?? 'beginner', arena, o.coachId ?? (await theCoach()), iso(o.startsAt), iso(o.startsAt + (o.hours ?? 1) * HOUR), o.capacity ?? 6, o.status ?? 'published'],
    )
  ).rows[0].id;
}

/** A package with `balance` classes left. */
export async function makePackage(riderId: string, o: { balance?: number; status?: string; validUntil?: string; formats?: string[]; branchId?: string } = {}): Promise<string> {
  const type = (
    await ctx.admin.query(`INSERT INTO package_types (branch_id, name, classes, price_minor, valid_days, class_formats) VALUES ($1,'Test pack',10,0,365,$2::class_format[]) RETURNING id`, [
      o.branchId ?? BRANCH, o.formats ?? ['group'],
    ])
  ).rows[0].id;
  const id: string = (
    await ctx.admin.query(`INSERT INTO rider_packages (rider_id, package_type_id, status, valid_until) VALUES ($1,$2,$3,$4) RETURNING id`, [
      riderId, type, o.status ?? 'active', o.validUntil ?? LONG_LIVED_UNTIL,
    ])
  ).rows[0].id;
  const balance = o.balance ?? 5;
  if (balance > 0) await ctx.admin.query(`INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key) VALUES ($1,$2,'purchase',$3)`, [id, balance, `purchase:${id}`]);
  return id;
}

export const balanceOf = async (packageId: string): Promise<number> =>
  Number((await ctx.admin.query(`SELECT coalesce(sum(delta),0)::int AS n FROM package_ledger WHERE rider_package_id = $1`, [packageId])).rows[0].n);

export const liveBookings = async (occurrenceId: string): Promise<number> =>
  Number((await ctx.admin.query(`SELECT count(*)::int AS n FROM bookings WHERE occurrence_id = $1 AND status IN ('pending_office_payment','confirmed','checked_in','completed')`, [occurrenceId])).rows[0].n);

export const codes = (res: { body: any }): string[] => (res.body?.problems ?? []).map((p: any) => p.code);
