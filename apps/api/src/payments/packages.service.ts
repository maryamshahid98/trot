import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthUser } from '../auth/decorators.ts';
import { OWNS_RIDER, writeAudit } from '../common/audit.ts';
import { branchFor } from '../common/branch.ts';
import { parse } from '../common/validate.ts';
import {
  AUDIT, ENTITY, LEDGER_REASON, PACKAGE_STATUS, PAYMENT_PROBLEM, PG_ERROR, RIDER_STATUS, ROLE,
} from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import type { Tx } from '../bookings/core.ts';
import { AdjustPackage, CreatePackageType, IdParam, ListPackageTypes, SellPackage, SetPackageStatus, UpdatePackageType } from './payments.schemas.ts';
import { issueReceipt } from './receipts.ts';
import { pgErrorCode } from '../common/errors.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const TYPE_COLS = `pt.id, pt.name, pt.classes, pt.price_minor AS "priceMinor", pt.valid_days AS "validDays", pt.class_formats::text[] AS "classFormats", pt.active`;
const MS_DAY = 86_400_000;

@Injectable()
export class PackagesService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async listTypes(query: unknown, user: AuthUser) {
    const q = parse(ListPackageTypes, query);
    const branchId = branchFor(q.branchId, user);
    // Only staff see retired types. A customer sees what can be bought today.
    const all = q.includeInactive === 'true' && user.role !== ROLE.CUSTOMER;
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => ({
      packageTypes: (await c.query(`SELECT ${TYPE_COLS} FROM package_types pt WHERE pt.branch_id = $1 AND ($2::boolean OR pt.active) ORDER BY pt.price_minor, pt.name`, [branchId, all])).rows,
    }));
  }

  async createType(body: unknown, user: AuthUser) {
    const b = parse(CreatePackageType, body);
    const branchId = branchFor(b.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const id: string = (
        await c.query(`INSERT INTO package_types (branch_id, name, classes, price_minor, valid_days, class_formats) VALUES ($1,$2,$3,$4,$5,$6::class_format[]) RETURNING id`, [
          branchId, b.name, b.classes, b.priceMinor, b.validDays, b.classFormats,
        ])
      ).rows[0].id;
      await writeAudit(c, user, branchId, AUDIT.PACKAGE_TYPE_CREATE, ENTITY.PACKAGE_TYPE, id, { name: b.name, classes: b.classes, priceMinor: b.priceMinor });
      return { id };
    });
  }

  /** Changes apply to future sales only. Packages already sold keep what the rider paid for. */
  async updateType(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b: Record<string, unknown> = parse(UpdatePackageType, body);
    const COLUMNS: Record<string, string> = { name: 'name', classes: 'classes', priceMinor: 'price_minor', validDays: 'valid_days', classFormats: 'class_formats', active: 'active' };
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const t = (await c.query(`SELECT id, branch_id AS "branchId" FROM package_types WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!t) throw new NotFoundException('Package type not found.');
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [key, col] of Object.entries(COLUMNS)) {
        if (!(key in b)) continue;
        params.push(b[key]);
        sets.push(`${col} = $${params.length}${key === 'classFormats' ? '::class_format[]' : ''}`);
      }
      await c.query(`UPDATE package_types SET ${sets.join(', ')} WHERE id = $1`, params);
      await writeAudit(c, user, t.branchId, AUDIT.PACKAGE_TYPE_UPDATE, ENTITY.PACKAGE_TYPE, id, b);
      return (await c.query(`SELECT ${TYPE_COLS} FROM package_types pt WHERE pt.id = $1`, [id])).rows[0];
    });
  }

  /** A rider's packages with what is left in each. Customers see their own and their wards'. */
  async listForRider(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      await this.rider(c, id, user, false);
      const rows = (
        await c.query(
          `SELECT rp.id, rp.status, rp.purchased_at AS "purchasedAt", rp.valid_until AS "validUntil", pt.name, pt.class_formats::text[] AS "classFormats",
                  coalesce((SELECT sum(l.delta) FROM package_ledger l WHERE l.rider_package_id = rp.id), 0)::int AS balance
             FROM rider_packages rp JOIN package_types pt ON pt.id = rp.package_type_id WHERE rp.rider_id = $1 ORDER BY rp.purchased_at DESC`,
          [id],
        )
      ).rows;
      return { packages: rows };
    });
  }

  async ledger(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const pk = (
        await c.query(`SELECT rp.id FROM rider_packages rp JOIN riders r ON r.id = rp.rider_id WHERE rp.id = $1 AND ($2::boolean = false OR ${OWNS_RIDER('r', '$3')})`, [id, user.role === ROLE.CUSTOMER, user.id])
      ).rows[0];
      if (!pk) throw new NotFoundException('Package not found.');
      const entries = (await c.query(`SELECT id, delta, reason, note, booking_id AS "bookingId", at FROM package_ledger WHERE rider_package_id = $1 ORDER BY at, id`, [id])).rows;
      return { entries, balance: entries.reduce((s: number, e) => s + e.delta, 0) };
    });
  }

  private async rider(c: Tx, id: string, user: AuthUser, lock: boolean) {
    const r = (
      await c.query(
        `SELECT r.id, r.branch_id AS "branchId", r.status FROM riders r WHERE r.id = $1 AND ($2::boolean = false OR ${OWNS_RIDER('r', '$3')})${lock ? ' FOR UPDATE OF r' : ''}`,
        [id, user.role === ROLE.CUSTOMER, user.id],
      )
    ).rows[0];
    if (!r) throw new NotFoundException('Rider not found.');
    return r;
  }

  /** The desk sells a package: the package, its first ledger entry and the receipt are created together or not at all. */
  async sell(rawId: string, body: unknown, user: AuthUser) {
    const { id: riderId } = parse(IdParam, { id: rawId });
    const b = parse(SellPackage, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const rider = await this.rider(c, riderId, user, true);
      if (rider.status !== RIDER_STATUS.ACTIVE) throw new UnprocessableEntityException(problem('Only an approved rider can buy a package.', PAYMENT_PROBLEM.RIDER_NOT_ACTIVE));
      const type = (await c.query(`SELECT id, branch_id AS "branchId", classes, price_minor AS "priceMinor", valid_days AS "validDays", active FROM package_types WHERE id = $1`, [b.packageTypeId])).rows[0];
      if (!type || !type.active || type.branchId !== rider.branchId) throw new UnprocessableEntityException(problem('That package is not on sale for this rider\'s branch.', PAYMENT_PROBLEM.PACKAGE_TYPE_UNAVAILABLE));
      // The desk types the amount it collected; it must match the price so a typo cannot create a wrong receipt.
      if (b.amountMinor !== undefined && b.amountMinor !== type.priceMinor) {
        throw new UnprocessableEntityException(problem(`The price is ${type.priceMinor} halalas.`, PAYMENT_PROBLEM.AMOUNT_MISMATCH));
      }
      const validUntil = new Date(Date.now() + type.validDays * MS_DAY).toISOString();
      const pk = (await c.query(`INSERT INTO rider_packages (rider_id, package_type_id, status, valid_until) VALUES ($1,$2,$3,$4) RETURNING id`, [riderId, type.id, PACKAGE_STATUS.ACTIVE, validUntil])).rows[0];
      await c.query(`INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key, by_account) VALUES ($1,$2,$3,$4,$5)`, [pk.id, type.classes, LEDGER_REASON.PURCHASE, `purchase:${pk.id}`, user.id]);
      // A free package has nothing to receipt.
      const receipt = type.priceMinor > 0 ? await issueReceipt(c, { branchId: rider.branchId, riderId, amountMinor: type.priceMinor, method: b.method, packageId: pk.id, userId: user.id }) : null;
      await writeAudit(c, user, rider.branchId, AUDIT.PACKAGE_SELL, ENTITY.PACKAGE, pk.id, { riderId, packageTypeId: type.id, receipt: receipt?.number ?? null });
      return { id: pk.id as string, classes: type.classes as number, validUntil, receipt };
    });
  }

  async adjust(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(AdjustPackage, body);
    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const pk = (await c.query(`SELECT rp.id, r.branch_id AS "branchId" FROM rider_packages rp JOIN riders r ON r.id = rp.rider_id WHERE rp.id = $1 FOR UPDATE OF rp`, [id])).rows[0];
        if (!pk) throw new NotFoundException('Package not found.');
        // A fresh key each time: two deliberate adjustments are two adjustments. The ledger itself is the record.
        const ins = (
          await c.query(`INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key, note, by_account) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
            id, b.delta, LEDGER_REASON.ADJUSTMENT, `adj:${crypto.randomUUID()}`, b.reason, user.id,
          ])
        ).rows[0];
        await writeAudit(c, user, pk.branchId, AUDIT.PACKAGE_ADJUST, ENTITY.PACKAGE, id, { delta: b.delta, reason: b.reason, ledgerId: ins.id });
        const balance = (await c.query(`SELECT coalesce(sum(delta),0)::int AS n FROM package_ledger WHERE rider_package_id = $1`, [id])).rows[0].n;
        return { id, balance: balance as number };
      });
    } catch (e: unknown) {
      if (pgErrorCode(e) === PG_ERROR.CHECK_VIOLATION) throw new UnprocessableEntityException(problem('The balance cannot go below zero.', PAYMENT_PROBLEM.INSUFFICIENT_BALANCE));
      throw e;
    }
  }

  async setStatus(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(SetPackageStatus, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const pk = (await c.query(`SELECT rp.id, rp.status, r.branch_id AS "branchId" FROM rider_packages rp JOIN riders r ON r.id = rp.rider_id WHERE rp.id = $1 FOR UPDATE OF rp`, [id])).rows[0];
      if (!pk) throw new NotFoundException('Package not found.');
      if (pk.status === b.status) throw new ConflictException(problem(`The package is already ${b.status}.`, PAYMENT_PROBLEM.SAME_STATUS));
      // Only a package that is in use can be frozen or cancelled, and a cancelled one stays cancelled (refund the balance with an adjustment).
      const movable = pk.status === PACKAGE_STATUS.ACTIVE || pk.status === PACKAGE_STATUS.FROZEN;
      if (!movable) throw new ConflictException(problem(`A ${pk.status} package cannot be changed.`, PAYMENT_PROBLEM.PACKAGE_STATUS_LOCKED));
      await c.query(`UPDATE rider_packages SET status = $2 WHERE id = $1`, [id, b.status]);
      await writeAudit(c, user, pk.branchId, AUDIT.PACKAGE_STATUS, ENTITY.PACKAGE, id, { from: pk.status, to: b.status, reason: b.reason });
      return { id, status: b.status };
    });
  }
}
