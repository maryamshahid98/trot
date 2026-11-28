// S3 storage against a small stand-in server, so it runs anywhere without an Amazon account. No database needed.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, ConfigError } from '../src/config/env.ts';
import { copyFiles } from '../src/riders/copy-files.ts';
import { LocalFileStorage, sha256 } from '../src/riders/file-storage.ts';
import type { FileStorage } from '../src/riders/file-storage.ts';
import { S3FileStorage } from '../src/riders/s3-storage.ts';
import { createFileStorage } from '../src/riders/storage-provider.ts';

const objects = new Map<string, Buffer>();
const requests: { method: string; path: string; headers: Record<string, unknown> }[] = [];
const xml = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;
const server = createServer((req, res) => {
  const path = new URL(req.url!, 'http://x').pathname;
  requests.push({ method: req.method!, path, headers: req.headers });
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const fail = (status: number, code: string) => res.writeHead(status, { 'content-type': 'application/xml' }).end(xml(code));
    if (!path.startsWith('/files/')) return fail(404, 'NoSuchBucket');
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] === '*' && objects.has(path)) return fail(412, 'PreconditionFailed');
      objects.set(path, Buffer.concat(chunks));
      return res.writeHead(200).end();
    }
    if (req.method === 'GET') {
      const data = objects.get(path);
      return data ? res.writeHead(200, { 'content-length': data.length }).end(data) : fail(404, 'NoSuchKey');
    }
    objects.delete(path);
    return res.writeHead(204).end();
  });
});

let endpoint = '';
before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

const settings = (extra: object = {}) => ({ bucket: 'files', region: 'ap-south-1', endpoint, forcePathStyle: true, prefix: '', accessKeyId: 'test', secretAccessKey: 'test-secret', ...extra });
const base = { DATABASE_URL: 'postgres://app:pw@db.example.invalid:5432/trot', JWT_SECRET: 'x'.repeat(40) };
const env = (extra: Record<string, string>) => ({ ...base, ...extra }) as NodeJS.ProcessEnv;

test('a file is written, read back byte for byte and removed', async () => {
  const store = new S3FileStorage(settings({ prefix: 'staging/' }));
  const key = randomUUID();
  const data = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 255, 13, 10]);
  await store.save(key, data);
  assert.deepEqual(await store.read(key), data);
  assert.ok(objects.has(`/files/staging/${key.slice(0, 2)}/${key}`), 'the same layout as the local folder, under the prefix');
  await store.remove(key);
  assert.equal(await store.read(key), null);
});

test('a stored file is never overwritten', async () => {
  const store = new S3FileStorage(settings());
  const key = randomUUID();
  await store.save(key, Buffer.from('first'));
  await assert.rejects(() => store.save(key, Buffer.from('second')));
  assert.equal((await store.read(key))!.toString(), 'first');
});

test('requests are signed, and nothing makes an object public', async () => {
  requests.length = 0;
  await new S3FileStorage(settings()).save(randomUUID(), Buffer.from('x'));
  assert.match(String(requests[0].headers.authorization), /^AWS4-HMAC-SHA256/);
  assert.equal(requests[0].headers['x-amz-acl'], undefined);
});

test('a missing bucket is a fault, not a missing file', async () => {
  await assert.rejects(() => new S3FileStorage(settings({ bucket: 'nowhere' })).read(randomUUID()), (e: Error) => e.name === 'NoSuchBucket');
});

test('a name that is not one the server made is refused before anything is sent', async () => {
  requests.length = 0;
  const store = new S3FileStorage(settings());
  for (const key of ['../secret', 'a/b', '', 'ABC']) await assert.rejects(() => store.read(key), /Invalid file key/);
  assert.equal(requests.length, 0);
});

test('copying checks every file against its fingerprint, keeps the source and can be run again', async () => {
  const kept = new Map<string, Buffer>();
  const source: FileStorage = { save: async () => {}, read: async (k) => kept.get(k) ?? null, remove: async () => assert.fail('the source must not be touched') };
  const store = new S3FileStorage(settings());
  const [good, damaged, lost, taken] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  kept.set(good, Buffer.from('good'));
  kept.set(damaged, Buffer.from('changed on disk'));
  kept.set(taken, Buffer.from('mine'));
  await store.save(taken, Buffer.from('somebody else'));
  const list = [{ key: good, sha: sha256(Buffer.from('good')) }, { key: damaged, sha: sha256(Buffer.from('original')) }, { key: lost, sha: sha256(Buffer.from('lost')) }, { key: taken, sha: sha256(Buffer.from('mine')) }];
  const first = await copyFiles(list, source, store, sha256);
  assert.equal(first.copied, 1);
  assert.deepEqual(first.problems.map((p) => p.key), [damaged, lost, taken]);
  assert.equal(await store.read(damaged), null);
  assert.equal((await store.read(taken))!.toString(), 'somebody else');
  const second = await copyFiles(list, source, store, sha256);
  assert.deepEqual([second.copied, second.already], [0, 1]);
});

test('files stay in the local folder unless S3 is chosen', () => {
  assert.ok(createFileStorage(loadConfig(env({}))) instanceof LocalFileStorage);
  assert.ok(createFileStorage(loadConfig(env({ STORAGE_DRIVER: 's3', S3_BUCKET: 'files', S3_REGION: 'ap-south-1' }))) instanceof S3FileStorage);
  assert.equal(loadConfig(env({ S3_BUCKET: 'files' })).uploads.s3, null);
});

test('S3 settings that cannot work stop the start', () => {
  const refused = (extra: Record<string, string>, naming: RegExp) =>
    assert.throws(() => loadConfig(env({ STORAGE_DRIVER: 's3', S3_BUCKET: 'files', S3_REGION: 'ap-south-1', ...extra })), (e: Error) => e instanceof ConfigError && naming.test(e.message));
  refused({ S3_BUCKET: '' }, /S3_BUCKET/);
  refused({ S3_REGION: '' }, /S3_REGION/);
  refused({ S3_ACCESS_KEY_ID: 'only-the-id' }, /S3_SECRET_ACCESS_KEY/);
  refused({ S3_ENDPOINT: 'not-an-address' }, /S3_ENDPOINT/);
  refused({ NODE_ENV: 'production', S3_ENDPOINT: 'http://files.example.invalid' }, /https/);
  assert.throws(() => loadConfig(env({ STORAGE_DRIVER: 'ftp' })), ConfigError);
});
