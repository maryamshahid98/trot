// The lists in src/config/constants.ts are copies of database enums. This test fails if they drift apart.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_STATUS, INCIDENT_SEVERITIES, INCIDENT_STATUSES, INCIDENT_TRANSITIONS, LEDGER_REASON, ASSIGNABLE_ROLES, LEAVE_STATUS, POLICY_BOUNDS, POLICY_FLAGS, ROLE_RANK, ADJUSTMENT_KINDS, PACKAGE_STATUS, PAYMENT_METHODS, WAITLIST_STATUS, BOOKING_SOURCE, BOOKING_STATUS, CANCEL_CAUSES, CREATABLE_OCCURRENCE_STATUSES, CLASS_FORMATS, DOC_KIND, DOC_STATUS, FORMATS, RIDE_FORMAT, HORSE_STATUS, LEVELS, OCCURRENCE_STATUS, PAY_WITH_VALUES, RIDER_STATUS, RIDER_STATUSES, ROLES,
} from '../src/config/constants.ts';
import { DEFAULT_POLICY } from '@trot/domain';
import { ctx, startApp, stopApp } from './helpers.ts';

before(startApp);
after(stopApp);

const enumValues = async (type: string): Promise<string[]> =>
  (await ctx.admin.query(`SELECT unnest(enum_range(NULL::${type}))::text AS v`)).rows.map((r: any) => r.v);

test('roles match the account_role enum', async () => {
  assert.deepEqual([...ROLES].sort(), (await enumValues('account_role')).sort());
});

test('class formats match the class_format enum', async () => {
  assert.deepEqual([...FORMATS].sort(), (await enumValues('class_format')).sort());
});

test('a ride is not a class: class formats plus the ride format are exactly the enum, and the two never overlap', async () => {
  assert.deepEqual([...CLASS_FORMATS, RIDE_FORMAT].sort(), (await enumValues('class_format')).sort());
  assert.ok(!(CLASS_FORMATS as readonly string[]).includes(RIDE_FORMAT));
});

test('levels match the level enum', async () => {
  assert.deepEqual([...LEVELS].sort(), (await enumValues('level')).sort());
});

test('every occurrence status the code uses exists in the occurrence_status enum', async () => {
  const inDb = await enumValues('occurrence_status');
  for (const s of Object.values(OCCURRENCE_STATUS)) assert.ok(inDb.includes(s), `${s} is not in the database enum`);
  for (const s of CREATABLE_OCCURRENCE_STATUSES) assert.ok(inDb.includes(s), `${s} is not in the database enum`);
});

test('booking statuses and payment methods match their enums', async () => {
  assert.deepEqual(Object.values(BOOKING_STATUS).sort(), (await enumValues('booking_status')).sort());
  assert.deepEqual([...PAY_WITH_VALUES].sort(), (await enumValues('pay_with')).sort());
});

test('the other fixed values the booking code uses exist in the database', async () => {
  assert.ok((await enumValues('rider_status')).includes(RIDER_STATUS.ACTIVE));
  const kinds = await enumValues('document_kind');
  for (const k of Object.values(DOC_KIND)) assert.ok(kinds.includes(k), `${k} is not a document_kind`);
  // These two are CHECK constraints, not enums, so read the constraint text.
  const defs = (await ctx.admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'bookings'::regclass AND contype = 'c'`)).rows.map((r: any) => r.d).join(' ');
  for (const c of CANCEL_CAUSES) assert.ok(defs.includes(`'${c}'`), `cancel cause ${c} is not allowed by the bookings table`);
  for (const s of Object.values(BOOKING_SOURCE)) assert.ok(defs.includes(`'${s}'`), `source ${s} is not allowed by the bookings table`);
});

test('rider statuses and document kinds match their enums', async () => {
  assert.deepEqual([...RIDER_STATUSES].sort(), (await enumValues('rider_status')).sort());
  assert.deepEqual(Object.values(DOC_KIND).sort(), (await enumValues('document_kind')).sort());
});

test('document statuses match the rider_documents check constraint', async () => {
  const defs = (await ctx.admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'rider_documents'::regclass AND contype = 'c'`)).rows.map((r: any) => r.d).join(' ');
  for (const s of Object.values(DOC_STATUS)) assert.ok(defs.includes(`'${s}'`), `document status ${s} is not allowed by the table`);
});

test('waitlist statuses match the waitlist_entries check constraint', async () => {
  const defs = (await ctx.admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'waitlist_entries'::regclass AND contype = 'c'`)).rows.map((r: any) => r.d).join(' ');
  for (const s of Object.values(WAITLIST_STATUS)) assert.ok(defs.includes(`'${s}'`), `waitlist status ${s} is not allowed by the table`);
});

test('the occurrence statuses the code names are exactly the database ones', async () => {
  assert.deepEqual(Object.values(OCCURRENCE_STATUS).sort(), (await enumValues('occurrence_status')).sort());
});

test('payment methods, adjustment kinds and package statuses match their check constraints', async () => {
  const defs = async (table: string) =>
    (await ctx.admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [table])).rows.map((r: any) => r.d).join(' ');
  const receipts = await defs('receipts');
  for (const m of PAYMENT_METHODS) assert.ok(receipts.includes(`'${m}'`), `payment method ${m} is not allowed by receipts`);
  const adjustments = await defs('financial_adjustments');
  for (const k of ADJUSTMENT_KINDS) assert.ok(adjustments.includes(`'${k}'`), `adjustment kind ${k} is not allowed by financial_adjustments`);
  const packages = await defs('rider_packages');
  for (const s of Object.values(PACKAGE_STATUS)) assert.ok(packages.includes(`'${s}'`), `package status ${s} is not allowed by rider_packages`);
});

test('the receipt number sequence exists', async () => {
  assert.equal((await ctx.admin.query(`SELECT 1 FROM pg_class WHERE relname = 'receipt_number_seq' AND relkind = 'S'`)).rowCount, 1);
});

test('horse statuses match the horse_status enum', async () => {
  assert.deepEqual(Object.values(HORSE_STATUS).sort(), (await enumValues('horse_status')).sort());
});

test('account and leave statuses are allowed by their check constraints', async () => {
  const defs = async (table: string) => (await ctx.admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [table])).rows.map((r: any) => r.d).join(' ');
  const accounts = await defs('accounts');
  for (const s of Object.values(ACCOUNT_STATUS)) assert.ok(accounts.includes(`'${s}'`), `account status ${s} is not allowed by accounts`);
  const leave = await defs('staff_unavailability');
  for (const s of Object.values(LEAVE_STATUS)) assert.ok(leave.includes(`'${s}'`), `leave status ${s} is not allowed by staff_unavailability`);
});

test('every role has a rank, and every role we can assign exists', async () => {
  assert.deepEqual(Object.keys(ROLE_RANK).sort(), [...ROLES].sort());
  for (const r of ASSIGNABLE_ROLES) assert.ok(ROLES.includes(r));
});

test('every club rule in the domain package can be set per branch, and nothing else', () => {
  const settable = [...Object.keys(POLICY_BOUNDS), ...POLICY_FLAGS, 'horseSelection'].sort();
  assert.deepEqual(settable, Object.keys(DEFAULT_POLICY).sort());
});

test('incident severities and statuses match the incidents check constraints', async () => {
  const defs = (await ctx.admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'incidents'::regclass AND contype = 'c'`)).rows.map((r: any) => r.d).join(' ');
  for (const s of INCIDENT_SEVERITIES) assert.ok(defs.includes(`'${s}'`), `severity ${s} is not allowed by incidents`);
  for (const s of INCIDENT_STATUSES) assert.ok(defs.includes(`'${s}'`), `status ${s} is not allowed by incidents`);
});

test('every incident status has a next step list, and each step is a real status', () => {
  assert.deepEqual(Object.keys(INCIDENT_TRANSITIONS).sort(), [...INCIDENT_STATUSES].sort());
  for (const [from, to] of Object.entries(INCIDENT_TRANSITIONS)) for (const t of to) assert.ok(INCIDENT_STATUSES.includes(t as any), `${from} -> ${t}`);
});

test('ledger reasons match the package_ledger check constraint', async () => {
  const defs = (await ctx.admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'package_ledger'::regclass AND contype = 'c'`)).rows.map((r: any) => r.d).join(' ');
  for (const r of Object.values(LEDGER_REASON)) assert.ok(defs.includes(`'${r}'`), `ledger reason ${r} is not allowed by package_ledger`);
});
