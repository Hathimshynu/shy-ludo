import { createHmac, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

export interface AccessClaims {
  sub: string;
  g: boolean;
}

const ISSUER = 'ludo-server';
const AUDIENCE = 'ludo-web';

export function signAccessToken(claims: AccessClaims, secret: string, ttlSeconds: number): string {
  return jwt.sign({ g: claims.g }, secret, {
    subject: claims.sub,
    expiresIn: ttlSeconds,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string, secret: string): AccessClaims | null {
  try {
    const payload = jwt.verify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null;
    return { sub: payload.sub, g: Boolean((payload as { g?: unknown }).g) };
  } catch {
    return null;
  }
}

/** Opaque refresh token (sent only as an httpOnly cookie). */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Keyed hash so a database leak does not expose usable refresh tokens. */
export function hashRefreshToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('base64url');
}
