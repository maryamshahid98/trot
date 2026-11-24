import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { SCRYPT } from '../config/constants.ts';

// scrypt is built into Node and is a recommended password hash. Format: scrypt$N$r$p$salt$hash
// The cost parameters live in the hash itself, so SCRYPT can be raised later without breaking existing passwords.

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, len, { N: n, r, p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await derive(password, salt, SCRYPT.N, SCRYPT.R, SCRYPT.P, SCRYPT.keyLength);
  return `scrypt$${SCRYPT.N}$${SCRYPT.R}$${SCRYPT.P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/** A real hash of a throwaway password, checked when the account does not exist, so "no such account" takes as long as "wrong password". */
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(SCRYPT.saltBytes).toString('hex')));
