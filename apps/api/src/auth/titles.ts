// The roles that are a limited version of another one (BRD section 4). Every existing permission check keeps working with the base
// role; this file says which requests a title may make at all, and as which base role.
import { ROLE } from '../config/constants.ts';
import type { Role } from '../config/constants.ts';

type Rule = [methods: string, path: RegExp, as?: Role];
const any = (names: string) => new RegExp(`^/(${names})(/|$)`);
// What a title may never read. The server matches addresses without regard to capitals, so these must too.
/** A rider's medical form, waiver and permissions (BR-027, IAM-004). */
const RIDER_DOCUMENTS = /^\/riders\/[^/]+\/documents(\/|$)/i;
/** A rider's money and packages, for people without finance work (BR-016, IAM-004). */
const RIDER_MONEY = /^\/riders\/[^/]+\/(account|packages)(\/|$)/i;
const either = (...rules: RegExp[]) => new RegExp(rules.map((r) => r.source).join('|'), 'i');

/** Open to every signed-in person, whatever the title. */
const COMMON: Rule[] = [['GET POST PUT', any('auth')], ['GET PUT', /^\/notifications\/preferences$/], ['GET', any('organisation|branches')]];

const RULES: Partial<Record<Role, { base: Role; allow: Rule[]; deny?: RegExp }>> = {
  // A director does what a manager does, across the branches they are assigned to.
  [ROLE.DIRECTOR]: { base: ROLE.MANAGER, allow: [['GET POST PUT PATCH DELETE', /./]] },
  // An auditor sees what a manager sees and changes nothing. Medical documents and evidence are not part of the audit view.
  [ROLE.AUDITOR]: { base: ROLE.MANAGER, allow: [['GET', /./]], deny: either(/\/(file|files)(\/|$)/, RIDER_DOCUMENTS) },
  // A scheduler plans lessons and rides and the resources they use.
  [ROLE.SCHEDULER]: {
    base: ROLE.RECEPTION,
    deny: either(RIDER_DOCUMENTS, RIDER_MONEY),
    allow: [
      ['GET', any('schedule|bookings|arenas|horses|staff|staff-leave|ride-types|class-types|riders|skills|incidents')],
      ['POST PATCH DELETE', any('schedule')], ['POST', any('rides|staff-leave|incidents')], ['DELETE', any('staff-leave')],
    ],
  },
  // Finance handles invoices, payments, refunds, reconciliation and exports.
  [ROLE.FINANCE]: {
    base: ROLE.RECEPTION,
    deny: RIDER_DOCUMENTS,
    allow: [
      ['GET', any('reports|audit-log'), ROLE.MANAGER],
      ['GET', any('riders|receipts|invoices|package-types|ride-types|class-types|schedule|bookings|packages|staff|staff-leave')],
      ['POST', /^\/bookings\/[^/]+\/payment$/], ['POST', /^\/riders\/[^/]+\/packages$/], ['POST', /^\/receipts\/[^/]+\/adjustments$/, ROLE.MANAGER],
      ['POST', /^\/adjustments\/[^/]+\/approve$/, ROLE.MANAGER], ['POST PATCH', any('package-types'), ROLE.MANAGER], ['POST', any('staff-leave')],
    ],
  },
};

/** The base role this request runs as, or null when the title may not make it. Ordinary roles pass through unchanged. */
export function actingRole(title: Role, method: string, path: string): Role | null {
  const rules = RULES[title];
  if (!rules) return title;
  const hit = [...COMMON, ...rules.allow].find(([methods, re]) => methods.split(' ').includes(method) && re.test(path));
  if (!hit || rules.deny?.test(path)) return null;
  return hit[2] ?? rules.base;
}

/** Titles that work with riders without needing their medical details (IAM-004). */
export const NO_MEDICAL: readonly Role[] = [ROLE.FINANCE, ROLE.SCHEDULER, ROLE.AUDITOR];
