// Time-based one-time codes (RFC 6238), the kind an authenticator app shows: 6 digits that change every 30 seconds.
// Built on Node's own crypto, with no extra dependency. The pieces are separate small functions so they can be checked against
// the standard's published test values.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** A code is accepted for the current 30-second step and the one on either side, to allow for a slightly wrong clock. */
export const TOTP_WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Not a valid base32 string.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (160 bits), as base32 text for the authenticator app. */
export const newSecret = (): string => base32Encode(randomBytes(20));

/** The code for one time-step (HOTP, RFC 4226). */
export function codeAt(secret: Buffer, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(counter).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The time-step a code belongs to, or null if it is wrong. Steps at or before `lastUsedStep` are refused, so a code that has been used
 * cannot be used again (someone who saw it over a shoulder gets nothing).
 */
export function verifyCode(secretBase32: string, code: string, nowMs: number, lastUsedStep = 0): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = stepAt(nowMs);
  let found: number | null = null;
  // Check every step in the window (not stopping at the first match), so the time taken does not reveal which one matched.
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    if (same(codeAt(secret, s), code) && s > lastUsedStep && (found === null || s > found)) found = s;
  }
  return found;
}

/** The address an authenticator app scans (as a QR code) to add the account. */
export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ---------- keeping the secret safe in the database ----------
// The secret is what lets anyone produce valid codes, so it is stored encrypted (AES-256-GCM), never as plain text. The key comes from
// the server's own settings, not from the database, so a stolen copy of the database alone is not enough to produce a code.

const keyFor = (keyMaterial: string): Buffer => Buffer.from(hkdfSync('sha256', Buffer.from(keyMaterial), Buffer.alloc(0), 'trot-mfa-secret-v1', 32));

export function encryptSecret(secretBase32: string, keyMaterial: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(keyMaterial), iv);
  const ct = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(stored: string, keyMaterial: string): string {
  const [version, iv, tag, ct] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unknown secret format.');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(keyMaterial), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

// ---------- recovery codes (for a lost phone) ----------

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, which are easy to misread

/** Ten one-use codes like "K7M2P-9XQ4T". */
export function newRecoveryCodes(count = 10): string[] {
  const pick = (n: number) => Array.from(randomBytes(n), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
  return Array.from({ length: count }, () => `${pick(5)}-${pick(5)}`);
}

/** Codes are compared as hashes, in a normal form (upper case, no dashes or spaces), so only the hash is stored. */
export const hashRecoveryCode = (code: string): string => createHash('sha256').update(code.toUpperCase().replace(/[\s-]/g, '')).digest('hex');
