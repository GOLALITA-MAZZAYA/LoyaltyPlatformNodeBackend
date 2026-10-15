import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Role } from '@prisma/client';
import { unauthorized } from './errors.js';

export interface AccessClaims {
  /** Staff id */
  sub: string;
  /** Merchant id */
  mid: string;
  role: Role;
  /** Refresh-token family id, so logout can revoke the whole login */
  fid: string;
}

const ISSUER = 'golalita-loyalty';
const AUDIENCE = 'merchant-app';

export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly accessTtlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  get accessTokenTtl() {
    return this.accessTtlSeconds;
  }

  async signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ mid: claims.mid, role: claims.role, fid: claims.fid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.key);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE });
      const { sub, mid, role, fid } = payload as Partial<AccessClaims>;
      if (!sub || typeof mid !== 'string' || (role !== 'owner' && role !== 'cashier') || typeof fid !== 'string') {
        throw unauthorized();
      }
      return { sub, mid, role, fid };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw unauthorized('token_expired', 'Access token expired');
      throw unauthorized();
    }
  }
}

/** Opaque random token with a readable prefix, e.g. `rt_…`. Only its hash is stored. */
export function newOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
