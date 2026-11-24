// Document files: only real PDF/JPEG/PNG, the right people only, every viewing logged, and nothing the client says decides where a file lives.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { api, ctx, makeBranch, startApp, stopApp } from './helpers.ts';
import type { Json } from './helpers.ts';
import { auditActions, customer, staff } from './flow-helpers.ts';

before(startApp);
after(stopApp);

// Real file signatures, so the tests do not depend on any file on disk.
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj <<>> endobj\n'.repeat(5)), Buffer.from('%%EOF')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 9)]);

const upload = async (docId: string, token: string | undefined, bytes: Buffer | string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${ctx.base}/documents/${docId}/file`, {
    method: 'PUT',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/pdf', ...headers },
    body: bytes as BodyInit,
  });
  const text = await res.text();
  let body: Json = {};
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text };
};
const download = async (docId: string, token: string | undefined) => {
  const res = await fetch(`${ctx.base}/documents/${docId}/file`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, res, bytes: Buffer.from(await res.arrayBuffer()) };
};
const newDoc = async (token: string, riderId: string, kind = 'medical_form'): Promise<string> => {
  const r = await api('POST', `/riders/${riderId}/documents`, { token, body: { kind, expiresAt: '2045-01-01T00:00:00.000Z' } });
  assert.equal(r.status, 201, r.text);
  return r.body.id;
};
const fileKeyOf = async (docId: string): Promise<string | null> => (await ctx.admin.query(`SELECT file_key FROM rider_documents WHERE id = $1`, [docId])).rows[0].file_key;
const uploadDir = () => path.resolve(process.env.UPLOAD_DIR as string);

describe('attaching a file', () => {
  test('a family member attaches a PDF, a JPEG and a PNG; staff download exactly the same bytes', async () => {
    const fam = await customer();
    const reception = await staff('reception');
    for (const [bytes, type, ext] of [[PDF, 'application/pdf', 'pdf'], [JPEG, 'image/jpeg', 'jpg'], [PNG, 'image/png', 'png']] as const) {
      const doc = await newDoc(fam.token, fam.riderId);
      const up = await upload(doc, fam.token, bytes, { 'content-type': type, 'x-file-name': `scan.${ext}` });
      assert.equal(up.status, 200, up.text);
      assert.equal(up.body.fileType, type);
      assert.equal(up.body.fileSize, bytes.length);
      const got = await download(doc, reception.token);
      assert.equal(got.status, 200);
      assert.ok(got.bytes.equals(bytes), 'the bytes come back unchanged');
      assert.equal(got.res.headers.get('content-type'), type);
      assert.match(got.res.headers.get('content-disposition') ?? '', /^attachment;/, 'a download, never shown inline in the site');
      assert.equal(got.res.headers.get('x-content-type-options'), 'nosniff');
    }
  });

  test('the document list says which documents have a file, and never shows where it is stored', async () => {
    const fam = await customer();
    const withFile = await newDoc(fam.token, fam.riderId, 'medical_form');
    const without = await newDoc(fam.token, fam.riderId, 'waiver');
    await upload(withFile, fam.token, PDF);
    const list = (await api('GET', `/riders/${fam.riderId}/documents`, { token: fam.token })).body.documents as Json[];
    assert.equal(list.find((d) => d.id === withFile).hasFile, true);
    assert.equal(list.find((d) => d.id === without).hasFile, false);
    assert.equal(list.find((d) => d.id === withFile).fileType, 'application/pdf');
    assert.ok(!JSON.stringify(list).includes(String(await fileKeyOf(withFile))), 'the storage key is not exposed');
  });

  test('attaching and viewing are both written to the audit log, with who looked', async () => {
    const fam = await customer();
    const reception = await staff('reception');
    const doc = await newDoc(fam.token, fam.riderId);
    await upload(doc, fam.token, PDF);
    await download(doc, reception.token);
    await download(doc, fam.token);
    const actions = await auditActions(doc);
    assert.ok(actions.includes('document.file_attach'));
    assert.equal(actions.filter((a) => a === 'document.file_view').length, 2);
    const viewers = (await ctx.admin.query(`SELECT actor_account_id FROM audit_log WHERE entity_id = $1 AND action = 'document.file_view'`, [doc])).rows.map((r) => r.actor_account_id);
    assert.deepEqual(viewers.sort(), [reception.id, fam.id].sort());
  });

  test('a document can hold only one file; a second attempt is a conflict and changes nothing', async () => {
    const fam = await customer();
    const doc = await newDoc(fam.token, fam.riderId);
    assert.equal((await upload(doc, fam.token, PDF)).status, 200);
    const key = await fileKeyOf(doc);
    const again = await upload(doc, fam.token, PDF);
    assert.equal(again.status, 409, again.text);
    assert.equal(await fileKeyOf(doc), key);
  });
});

describe('what is accepted', () => {
  test('only what really is a PDF, JPEG or PNG, whatever the sender claims', async () => {
    const fam = await customer();
    const doc = await newDoc(fam.token, fam.riderId);
    assert.equal((await upload(doc, fam.token, Buffer.from('just some text, not a PDF'))).status, 415, 'text claiming to be a PDF');
    assert.equal((await upload(doc, fam.token, Buffer.from('<html><script>alert(1)</script></html>'))).status, 415, 'html');
    assert.equal((await upload(doc, fam.token, JPEG, { 'content-type': 'application/pdf' })).status, 415, 'a JPEG that says it is a PDF');
    assert.equal((await upload(doc, fam.token, Buffer.alloc(0))).status, 400, 'empty');
    assert.equal(await fileKeyOf(doc), null, 'nothing was attached by any of those');
  });

  test('a body that is not a file at all is refused', async () => {
    const fam = await customer();
    const doc = await newDoc(fam.token, fam.riderId);
    const json = await upload(doc, fam.token, JSON.stringify({ file: 'x' }), { 'content-type': 'application/json' });
    assert.equal(json.status, 415);
    const text = await upload(doc, fam.token, 'hello', { 'content-type': 'text/plain' });
    assert.equal(text.status, 415);
  });

  test('a file over the size limit is refused with 413', async () => {
    const fam = await customer();
    const doc = await newDoc(fam.token, fam.riderId);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(Number(process.env.UPLOAD_MAX_BYTES) + 5_000, 1)]);
    const r = await upload(doc, fam.token, big);
    assert.equal(r.status, 413, r.text);
    assert.equal(await fileKeyOf(doc), null);
  });

  test('the file name is cleaned: no folders, no odd characters, the right extension', async () => {
    const fam = await customer();
    const cases: [string, RegExp][] = [
      ['../../etc/passwd', /^etc passwd\.pdf$/],
      ['my "form".pdf', /^my form\.pdf$/],
      ['', /^medical_form\.pdf$/],
      [encodeURIComponent('نموذج طبي.pdf'), /^نموذج طبي\.pdf$/u],
      ['a'.repeat(400), /^a{116}\.pdf$/],
    ];
    for (const [given, expected] of cases) {
      const doc = await newDoc(fam.token, fam.riderId);
      const r = await upload(doc, fam.token, PDF, { 'x-file-name': given });
      assert.equal(r.status, 200, r.text);
      assert.match(r.body.fileName, expected, `${given.slice(0, 30)} -> ${r.body.fileName}`);
      assert.ok(!/[\\/]/.test(r.body.fileName));
    }
  });
});

describe('who can reach a file', () => {
  test('nobody signed in, a coach or a stable hand, another family, and another branch cannot', async () => {
    const fam = await customer();
    const doc = await newDoc(fam.token, fam.riderId);
    await upload(doc, fam.token, PDF);
    const other = await customer();
    const otherBranch = await staff('manager', [await makeBranch()]);
    for (const [who, token, want] of [
      ['nobody', undefined, 401], ['coach', (await staff('coach')).token, 403], ['stable hand', (await staff('stable_hand')).token, 403],
      ['another family', other.token, 404], ['another branch', otherBranch.token, 404],
    ] as const) {
      assert.equal((await download(doc, token)).status, want, `${who} downloads`);
      assert.equal((await upload(doc, token, PDF)).status, want === 404 || want === 403 || want === 401 ? want : 0, `${who} uploads`);
    }
    assert.equal((await download(doc, (await staff('owner')).token)).status, 200, 'an owner can');
    assert.equal((await download(doc, (await staff('manager')).token)).status, 200, 'a manager can');
  });

  test('a document with no file, and an unknown or malformed id', async () => {
    const fam = await customer();
    const doc = await newDoc(fam.token, fam.riderId);
    assert.equal((await download(doc, fam.token)).status, 404);
    assert.equal((await download('00000000-0000-0000-0000-00000000dead', fam.token)).status, 404);
    assert.equal((await download('not-an-id', fam.token)).status, 400);
  });
});

describe('the file is only ever found through the server\'s own key', () => {
  test('a client-supplied fileRef never points at a stored file', async () => {
    const victim = await customer();
    const attacker = await customer();
    const secret = await newDoc(victim.token, victim.riderId);
    await upload(secret, victim.token, PDF);
    const key = String(await fileKeyOf(secret));
    // The attacker records a document whose free-text fileRef is the victim's storage key.
    const mine = await api('POST', `/riders/${attacker.riderId}/documents`, { token: attacker.token, body: { kind: 'waiver', fileRef: key } });
    assert.equal(mine.status, 201, mine.text);
    assert.equal((await download(mine.body.id, attacker.token)).status, 404, 'a document without a real file has nothing to download');
    assert.equal((await download(secret, attacker.token)).status, 404, 'and the victim\'s file is still theirs alone');
  });

  test('the stored file is checked against its fingerprint: a changed file is not sent, and is not logged as viewed', async () => {
    const fam = await customer();
    const doc = await newDoc(fam.token, fam.riderId);
    await upload(doc, fam.token, PDF);
    const key = String(await fileKeyOf(doc));
    const file = path.join(uploadDir(), key.slice(0, 2), key);
    assert.ok(existsSync(file), 'the file is where the key says');
    assert.ok((await readFile(file)).equals(PDF));
    await writeFile(file, Buffer.concat([PDF, Buffer.from('tampered')]));
    const r = await download(doc, fam.token);
    assert.equal(r.status, 409);
    assert.ok(!(await auditActions(doc)).includes('document.file_view'));
  });

  test('a file that went missing from storage is a clear 404, not a crash', async () => {
    const fam = await customer();
    const doc = await newDoc(fam.token, fam.riderId);
    await upload(doc, fam.token, PDF);
    const key = String(await fileKeyOf(doc));
    await (await import('node:fs/promises')).rm(path.join(uploadDir(), key.slice(0, 2), key));
    assert.equal((await download(doc, fam.token)).status, 404);
  });
});

test('a staff member recording a paper form with no file still works as before', async () => {
  const reception = await staff('reception');
  const fam = await customer();
  const doc = await api('POST', `/riders/${fam.riderId}/documents`, { token: reception.token, body: { kind: 'photo_permission' } });
  assert.equal(doc.status, 201);
  assert.equal((await api('POST', `/documents/${doc.body.id}/verify`, { token: reception.token, body: {} })).status, 201);
});
