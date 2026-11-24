import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthUser } from '../auth/decorators.ts';
import { OWNS_RIDER, writeAudit } from '../common/audit.ts';
import { parse } from '../common/validate.ts';
import { AUDIT, DOC_STATUS, ENTITY, RIDER_PROBLEM, RIDER_STATUS, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { IdParam, RejectDocument, SubmitDocument } from './riders.schemas.ts';

const COLS = `d.id, d.rider_id AS "riderId", d.kind, d.status, d.file_ref AS "fileRef", d.signed_at AS "signedAt", d.expires_at AS "expiresAt", d.created_at AS "createdAt"`;
const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });

@Injectable()
export class DocumentsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  private async rider(c: any, id: string, user: AuthUser) {
    const r = (
      await c.query(`SELECT r.id, r.branch_id AS "branchId", r.status FROM riders r WHERE r.id = $1 AND ($2::boolean = false OR ${OWNS_RIDER('r', '$3')}) FOR UPDATE OF r`, [id, user.role === ROLE.CUSTOMER, user.id])
    ).rows[0];
    if (!r) throw new NotFoundException('Rider not found.');
    return r;
  }

  async list(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      await this.rider(c, id, user);
      return { documents: (await c.query(`SELECT ${COLS} FROM rider_documents d WHERE d.rider_id = $1 ORDER BY d.created_at DESC`, [id])).rows };
    });
  }

  async submit(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(SubmitDocument, body);
    const now = Date.now();
    const signedAt = b.signedAt ? Date.parse(b.signedAt) : now;
    const expiresAt = b.expiresAt ? Date.parse(b.expiresAt) : null;
    if (signedAt > now + 5 * 60_000) throw new BadRequestException({ message: 'The request is not valid.', problems: [{ field: 'signedAt', message: 'cannot be in the future' }] });
    if (expiresAt !== null && expiresAt <= signedAt) throw new BadRequestException({ message: 'The request is not valid.', problems: [{ field: 'expiresAt', message: 'must be after it was signed' }] });

    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const r = await this.rider(c, id, user);
      if (r.status === RIDER_STATUS.ARCHIVED) throw new ConflictException('This rider has been archived.');
      // A newer submission replaces one still waiting for review, so staff never review a stale copy.
      await c.query(`UPDATE rider_documents SET status = $3 WHERE rider_id = $1 AND kind = $2 AND status = $4`, [id, b.kind, DOC_STATUS.SUPERSEDED, DOC_STATUS.SUBMITTED]);
      const doc = (
        await c.query(
          `INSERT INTO rider_documents (rider_id, kind, status, file_ref, signed_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [id, b.kind, DOC_STATUS.SUBMITTED, b.fileRef ?? null, new Date(signedAt).toISOString(), expiresAt === null ? null : new Date(expiresAt).toISOString()],
        )
      ).rows[0];
      await writeAudit(c, user, r.branchId, AUDIT.DOCUMENT_SUBMIT, ENTITY.DOCUMENT, doc.id, { riderId: id, kind: b.kind });
      return { id: doc.id as string, status: DOC_STATUS.SUBMITTED };
    });
  }

  /** Loads a submitted document and its rider's branch, locked, for a staff decision. */
  private async pending(c: any, rawId: string) {
    const { id } = parse(IdParam, { id: rawId });
    const d = (
      await c.query(
        `SELECT d.id, d.rider_id AS "riderId", d.kind, d.status, d.expires_at AS "expiresAt", r.branch_id AS "branchId"
           FROM rider_documents d JOIN riders r ON r.id = d.rider_id WHERE d.id = $1 FOR UPDATE OF d`,
        [id],
      )
    ).rows[0];
    if (!d) throw new NotFoundException('Document not found.');
    if (d.status !== DOC_STATUS.SUBMITTED) throw new ConflictException(problem('Only a submitted document can be reviewed.', RIDER_PROBLEM.DOCUMENT_NOT_PENDING));
    return d;
  }

  async verify(rawId: string, user: AuthUser) {
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const d = await this.pending(c, rawId);
      if (d.expiresAt && Date.parse(d.expiresAt) <= Date.now()) {
        throw new UnprocessableEntityException(problem('This document has already expired.', RIDER_PROBLEM.DOCUMENT_ALREADY_EXPIRED));
      }
      // Only one verified document of each kind at a time; the old one is kept for the record.
      await c.query(`UPDATE rider_documents SET status = $3 WHERE rider_id = $1 AND kind = $2 AND status = $4`, [d.riderId, d.kind, DOC_STATUS.SUPERSEDED, DOC_STATUS.VERIFIED]);
      await c.query(`UPDATE rider_documents SET status = $2 WHERE id = $1`, [d.id, DOC_STATUS.VERIFIED]);
      await writeAudit(c, user, d.branchId, AUDIT.DOCUMENT_VERIFY, ENTITY.DOCUMENT, d.id, { riderId: d.riderId, kind: d.kind });
      return { id: d.id as string, status: DOC_STATUS.VERIFIED };
    });
  }

  async reject(rawId: string, body: unknown, user: AuthUser) {
    const { reason } = parse(RejectDocument, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const d = await this.pending(c, rawId);
      await c.query(`UPDATE rider_documents SET status = $2 WHERE id = $1`, [d.id, DOC_STATUS.REJECTED]);
      await writeAudit(c, user, d.branchId, AUDIT.DOCUMENT_REJECT, ENTITY.DOCUMENT, d.id, { riderId: d.riderId, kind: d.kind, reason });
      return { id: d.id as string, status: DOC_STATUS.REJECTED };
    });
  }
}
