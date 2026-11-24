// Time-based codes, checked against the values published in RFC 6238 and RFC 4226, with no database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, codeAt, decryptSecret, encryptSecret, hashRecoveryCode, newRecoveryCodes, newSecret, otpauthUrl, stepAt, verifyCode } from '../src/auth/totp.ts';

// The standard's test key: the ASCII text "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890');

test('RFC 6238 test values: the 8-digit codes at the published times', () => {
  const vectors: [number, string][] = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [seconds, expected] of vectors) assert.equal(codeAt(RFC_SECRET, Math.floor(seconds / 30), 8), expected, `at ${seconds}s`);
});

test('RFC 4226 test values: the 6-digit codes for counters 0 to 9', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(codeAt(RFC_SECRET, counter), code, `counter ${counter}`));
});

test('base32 round trips, and the standard\'s own example text is encoded correctly', () => {
  assert.equal(base32Encode(RFC_SECRET), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), RFC_SECRET);
  assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq'), RFC_SECRET, 'case, spaces and dashes are ignored');
  for (let n = 1; n < 40; n++) {
    const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) % 256));
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
  assert.throws(() => base32Decode('not base 32!'), /valid base32/);
});

test('a new secret is 160 random bits as base32, and two are never the same', () => {
  const a = newSecret();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.notEqual(a, newSecret());
});

test('a code is accepted in its own step and the one on either side, and not further away', () => {
  const secret = base32Encode(RFC_SECRET);
  const t = 1_700_000_000_000;
  const step = stepAt(t);
  for (const delta of [-1, 0, 1]) assert.equal(verifyCode(secret, codeAt(RFC_SECRET, step + delta), t), step + delta, `step ${delta}`);
  for (const delta of [-2, 2, 10]) assert.equal(verifyCode(secret, codeAt(RFC_SECRET, step + delta), t), null, `step ${delta}`);
});

test('a code that was used cannot be used again, but a later one can', () => {
  const secret = base32Encode(RFC_SECRET);
  const t = 1_700_000_000_000;
  const step = stepAt(t);
  const used = verifyCode(secret, codeAt(RFC_SECRET, step), t) as number;
  assert.equal(verifyCode(secret, codeAt(RFC_SECRET, step), t, used), null, 'the same code again');
  assert.equal(verifyCode(secret, codeAt(RFC_SECRET, step - 1), t, used), null, 'an older code after a newer one was used');
  assert.equal(verifyCode(secret, codeAt(RFC_SECRET, step + 1), t, used), step + 1, 'the next code');
});

test('anything that is not six digits is refused without error', () => {
  const secret = base32Encode(RFC_SECRET);
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 345', '١٢٣٤٥٦', ' 123456']) assert.equal(verifyCode(secret, bad, 1_700_000_000_000), null, JSON.stringify(bad));
});

test('the address for an authenticator app names the issuer and the account, safely', () => {
  const url = otpauthUrl('ABCDEFGH', 'maha@example.test', 'Trot Club');
  assert.equal(url, 'otpauth://totp/Trot%20Club:maha%40example.test?secret=ABCDEFGH&issuer=Trot%20Club&algorithm=SHA1&digits=6&period=30');
});

test('the secret is stored encrypted: not readable without the key, not changeable, different every time', () => {
  const secret = newSecret();
  const key = 'k'.repeat(40);
  const stored = encryptSecret(secret, key);
  assert.ok(stored.startsWith('v1:'));
  assert.ok(!stored.includes(secret), 'the plain secret is nowhere in it');
  assert.equal(decryptSecret(stored, key), secret);
  assert.notEqual(encryptSecret(secret, key), stored, 'a fresh random value each time');
  assert.throws(() => decryptSecret(stored, 'another key entirely, also long enough'), /authenticate|auth/i, 'the wrong key');
  const parts = stored.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decryptSecret(parts.join(':'), key), 'a changed value is detected');
  assert.throws(() => decryptSecret('plain', key), /format/);
});

test('recovery codes look like K7M2P-9XQ4T, are all different, and compare in any case without the dash', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  const first = codes[0];
  assert.equal(hashRecoveryCode(first), hashRecoveryCode(first.toLowerCase().replace('-', ' ')));
  assert.notEqual(hashRecoveryCode(first), hashRecoveryCode(codes[1]));
});
