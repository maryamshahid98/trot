// File storage in S3. Reads the same .env as the API.
//   npm run storage:check          write, read back and delete a small test file in the bucket
//   npm run storage:create-bucket  make the bucket on a local development service (never on Amazon: create it there by hand, see docs)
//   npm run storage:copy-to-s3     copy files from the local folder into the bucket; the originals are kept
import { randomUUID } from 'node:crypto';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import pg from 'pg';
import { ConfigError, loadAdminConfig, loadConfig } from '../src/config/env.ts';
import { LocalFileStorage, sha256 } from '../src/riders/file-storage.ts';
import { s3Client, S3FileStorage } from '../src/riders/s3-storage.ts';
import { copyFiles } from '../src/riders/copy-files.ts';

async function main() {
  const command = process.argv[2];
  const config = loadConfig();
  const s3 = config.uploads.s3;
  if (!s3) throw new ConfigError('Set STORAGE_DRIVER=s3 and the S3 settings in .env first (see .env.example).');
  const store = new S3FileStorage(s3);

  if (command === 'create-bucket') {
    if (!s3.endpoint) throw new ConfigError('create-bucket is only for a local service (S3_ENDPOINT). On Amazon create the bucket in the console, with public access blocked (docs/deployment.md).');
    try {
      await s3Client(s3).send(new CreateBucketCommand({ Bucket: s3.bucket }));
      console.log(`created bucket ${s3.bucket}`);
    } catch (e: unknown) {
      if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes((e as { name?: string }).name ?? '')) throw e;
      console.log(`bucket ${s3.bucket} already exists`);
    }
    return;
  }

  if (command === 'check') {
    const key = randomUUID();
    const data = Buffer.from(`storage check ${new Date().toISOString()}`);
    await store.save(key, data);
    try {
      const back = await store.read(key);
      if (!back || !back.equals(data)) throw new Error('the file read back is not the file that was written');
    } finally {
      await store.remove(key);
    }
    if ((await store.read(key)) !== null) throw new Error('the test file is still there after deleting it');
    console.log(`bucket ${s3.bucket}: write, read and delete all work`);
    return;
  }

  if (command === 'copy-to-s3') {
    const client = new pg.Client({ connectionString: loadAdminConfig('dev').databaseUrl });
    await client.connect();
    try {
      const files = (
        await client.query(
          `SELECT file_key AS key, file_sha256 AS sha FROM rider_documents WHERE file_key IS NOT NULL
           UNION ALL SELECT file_key, file_sha256 FROM incident_files ORDER BY 1`,
        )
      ).rows as { key: string; sha: string }[];
      const r = await copyFiles(files, new LocalFileStorage(config), store, sha256);
      console.log(`${files.length} file(s) in the database: ${r.copied} copied, ${r.already} already there, ${r.problems.length} problem(s). The local files were not changed.`);
      for (const p of r.problems) console.log(`  ${p.key}: ${p.message}`);
      if (r.problems.length) process.exitCode = 1;
    } finally {
      await client.end();
    }
    return;
  }

  throw new ConfigError('Use one of: check, create-bucket, copy-to-s3.');
}

main().catch((e: unknown) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
