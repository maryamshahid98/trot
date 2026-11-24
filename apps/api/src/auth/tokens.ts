import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { UUID_RE } from '../config/constants.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.key = new TextEncoder().encode(config.auth.jwtSecret); // already checked: at least 32 characters
  }

  /** Short-lived access token. It carries only the account id; role and branches are read from the database on every request. */
  signAccess(accountId: string): Promise<string> {
    const { issuer, audience, accessTtlSeconds } = this.config.auth;
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(accountId)
      .setIssuer(issuer)
      .setAudience(audience)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${accessTtlSeconds}s`)
      .sign(this.key);
  }

  /** Returns the account id, or throws. The algorithm is pinned, so "alg: none" and other tricks fail. */
  async verifyAccess(token: string): Promise<string> {
    const { issuer, audience } = this.config.auth;
    const { payload } = await jwtVerify(token, this.key, { issuer, audience, algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub)) throw new Error('bad subject');
    return payload.sub;
  }

  /** Long-lived, random, single-use. Only its hash is stored. */
  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashToken(token) };
  }
}
