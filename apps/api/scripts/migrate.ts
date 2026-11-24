// Database scripts. They connect as the superuser (ADMIN_DATABASE_URL), never as the API's limited role.
//   npm run db:migrate      apply pending db/migrations/*.sql, once each, recorded in schema_migrations
//   npm run db:seed         load demo data from db/seed/*.sql and give the demo accounts SEED_PASSWORD (development only)
//   npm run db:test-setup   drop and rebuild the separate test database, then migrate and seed it, so every run starts clean
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashPassword } from '../src/auth/password.ts';
import { ConfigError, databaseName, loadAdminConfig } from '../src/config/env.ts';
import type { AdminConfig } from '../src/config/env.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../db/migrations');
const seedDir = path.resolve(here, '../../../db/seed');
const APP_ROLE = 'trot_app'; // created by 0002_app_role_and_scope.sql
const DEMO_EMAIL_DOMAIN = '@example.test'; // the seed's demo accounts all use this domain

const sqlFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

async function migrate(client: pg.Client, cfg: AdminConfig) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));

  let ran = 0;
  for (const f of sqlFiles(migrationsDir)) {
    if (applied.has(f)) continue;
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(path.join(migrationsDir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`FAILED   ${f}`);
      throw e;
    }
    console.log(`applied  ${f}`);
    ran++;
  }
  console.log(ran === 0 ? 'Nothing to apply. Database is up to date.' : `Done. ${ran} migration(s) applied.`);

  // The migration creates the API's role without a password. In development the password comes from .env.
  // In production leave APP_DB_PASSWORD unset and set the role's password yourself, from your secret store.
  if (cfg.appDbPassword) {
    const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (role.rowCount) {
      await client.query(`ALTER ROLE ${client.escapeIdentifier(APP_ROLE)} PASSWORD ${client.escapeLiteral(cfg.appDbPassword)}`);
      console.log(`password set for database role ${APP_ROLE} (from APP_DB_PASSWORD)`);
    }
  }
}

async function seed(client: pg.Client, cfg: AdminConfig) {
  if (cfg.isProduction) throw new ConfigError('Refusing to seed: NODE_ENV is production. The seed is demo data for development only.');
  if (!cfg.seedPassword) throw new ConfigError('Invalid script configuration:\n  - SEED_PASSWORD: is required to seed (the password given to the demo accounts, at least 10 characters)\nSet it in the .env file at the project root (see .env.example).');

  for (const f of sqlFiles(seedDir)) {
    await client.query('BEGIN');
    await client.query(readFileSync(path.join(seedDir, f), 'utf8'));
    await client.query('COMMIT');
    console.log(`seeded   ${f}`);
  }
  // Demo accounts get a known password so you can sign in while developing.
  const hash = await hashPassword(cfg.seedPassword);
  const r = await client.query(
    `UPDATE accounts SET password_hash = $1 WHERE password_hash IS NULL AND email LIKE $2 RETURNING email`,
    [hash, `%${DEMO_EMAIL_DOMAIN}`],
  );
  console.log(`demo password (SEED_PASSWORD) set on ${r.rowCount} account(s): ${r.rows.map((x) => x.email).join(', ') || 'none, they already had one'}`);
}

/** Connects to the database in `url` and runs fn. */
async function withClient(url: string, fn: (c: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

async function main() {
  const mode = process.argv[2] ?? 'migrate';
  if (!['migrate', 'seed', 'test-setup'].includes(mode)) throw new ConfigError(`Unknown command "${mode}". Use: migrate, seed or test-setup.`);
  const cfg = loadAdminConfig(mode === 'test-setup' ? 'test' : 'dev');

  if (mode === 'test-setup') {
    const name = databaseName(cfg.databaseUrl);
    // Tests leave data behind. Starting from an empty database each time keeps list pages, searches and counts predictable.
    // loadAdminConfig has already checked that this is not the development database and that its name ends in "_test".
    await withClient(cfg.serverUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(name)} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${c.escapeIdentifier(name)}`);
      console.log(`rebuilt database ${name}`);
    });
    await withClient(cfg.databaseUrl, async (c) => {
      await migrate(c, cfg);
      await seed(c, cfg);
    });
    return;
  }

  await withClient(cfg.databaseUrl, (c) => (mode === 'seed' ? seed(c, cfg) : migrate(c, cfg)));
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
