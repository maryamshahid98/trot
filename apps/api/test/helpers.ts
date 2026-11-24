import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { AppModule } from '../src/app.module.ts';
import { hashPassword } from '../src/auth/password.ts';
import { configureApp } from '../src/bootstrap.ts';
import { APP_CONFIG } from '../src/config/env.ts';
import type { AppConfig } from '../src/config/env.ts';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';

// The tests run on their own database (created by `npm run db:test-setup`), never on the development data.
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set in .env to run the tests (see .env.example)`);
  return v;
}
if (need('TEST_DATABASE_URL') === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must be a different database than DATABASE_URL');
process.env.DATABASE_URL = need('TEST_DATABASE_URL');
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.JOBS_INTERVAL_SECONDS = '0'; // the tests run the background job by hand, never on a timer
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `trot-test-uploads-${process.pid}`); // uploaded files go to a throwaway folder
process.env.UPLOAD_MAX_BYTES = '100000'; // small, so the size-limit test does not have to send megabytes
process.env.RATE_LIMIT_KEY_PREFIX = `test-${process.pid}|`; // test files run side by side on one database: each keeps its own counters
process.env.GENERAL_RATE_LIMIT = '10000000'; // the general-limit test lowers this for itself
process.env.AUTH_RATE_LIMIT = '100000'; // the rate-limit test lowers this for itself
process.env.CORS_ORIGINS = 'http://localhost:5173'; // the CORS test checks one listed and one unlisted site

export const BRANCH = '00000000-0000-0000-0000-0000000000b1';
const ORG = '00000000-0000-0000-0000-000000000001';
export const PASSWORD = 'Correct-horse-9';

/**
 * What the API sends back is untyped JSON, and the point of a test is to assert on its shape. So tests read responses as `Json`.
 * This is the one place the project says so; everything else, including all of apps/api/src, is fully typed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const ctx = { app: undefined as Json, base: '', admin: undefined as unknown as pg.Pool };

/** Settings are read once when the app starts, so a test that needs a different value changes the running app's config. */
export const appConfig = () => ctx.app.get(APP_CONFIG) as AppConfig;

/** Clears this test process's rate-limit counters (and only those, other test files are running at the same time). */
export const resetRateLimits = () => ctx.admin.query('DELETE FROM rate_limits WHERE key LIKE $1', [`${process.env.RATE_LIMIT_KEY_PREFIX}%`]);

export async function startApp() {
  ctx.admin = new pg.Pool({ connectionString: need('TEST_ADMIN_DATABASE_URL') });
  ctx.app = await NestFactory.create(AppModule, { logger: false });
  configureApp(ctx.app);
  await ctx.app.listen(0);
  ctx.base = `http://127.0.0.1:${ctx.app.getHttpServer().address().port}`;
}
export async function stopApp() {
  await ctx.app?.close();
  await rm(process.env.UPLOAD_DIR as string, { recursive: true, force: true });
  await ctx.admin?.end();
}

let seq = 0;
const uniq = () => `${Date.now()}${process.pid}${seq++}`;

/** Creates an account directly in the database (as the superuser) with a known password. */
export async function makeAccount(opts: { role: string; branchIds?: string[]; password?: string | null; status?: string; phone?: string }) {
  const email = `t${uniq()}@trot-test.invalid`;
  const hash = opts.password === null ? null : await hashPassword(opts.password ?? PASSWORD);
  const id: string = (
    await ctx.admin.query(
      `INSERT INTO accounts (role, full_name, email, phone, password_hash, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [opts.role, `Test ${opts.role}`, email, opts.phone ?? null, hash, opts.status ?? 'active'],
    )
  ).rows[0].id;
  for (const b of opts.branchIds ?? [BRANCH]) {
    await ctx.admin.query(`INSERT INTO account_branches (account_id, branch_id) VALUES ($1,$2)`, [id, b]);
  }
  return { id, email };
}
export async function makeBranch(): Promise<string> {
  return (await ctx.admin.query(`INSERT INTO branches (organisation_id, name) VALUES ($1,$2) RETURNING id`, [ORG, `Test branch ${uniq()}`])).rows[0].id;
}
export async function makeArena(branchId = BRANCH): Promise<string> {
  return (await ctx.admin.query(`INSERT INTO arenas (branch_id, name, max_capacity) VALUES ($1,$2,8) RETURNING id`, [branchId, `Test arena ${uniq()}`])).rows[0].id;
}

const BODYLESS_METHODS = ['GET', 'HEAD'];

export async function api(method: string, path: string, opts: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  // A GET or HEAD request cannot carry a body, and fetch throws if you try. Tests may pass `body: {}` to every method in a loop.
  const body = BODYLESS_METHODS.includes(method) ? undefined : (opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined));
  if (body !== undefined) headers['content-type'] ??= 'application/json';
  const res = await fetch(ctx.base + path, { method, headers, body });
  const text = await res.text();
  let json: Json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, body: json, text, headers: res.headers };
}
export const login = (identifier: string, password = PASSWORD) => api('POST', '/auth/login', { body: { identifier, password } });
export async function tokenFor(account: { email: string }, password = PASSWORD): Promise<string> {
  const r = await login(account.email, password);
  if (r.status !== 200) throw new Error(`login failed in test setup: ${r.status} ${r.text}`);
  return r.body.accessToken;
}

/** A random day far in the future, so nothing else in the dev data is ever in the way. */
export const randomDay = () => Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 3000) * 86_400_000;
export const at = (day: number, hours: number) => new Date(day + hours * 3_600_000).toISOString();
