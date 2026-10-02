import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { LIMITS } from '@ludo/config';
import type { PublicUser } from '@ludo/shared-types';
import type { AppConfig } from '../config';
import { HttpError } from '../errors';
import { getDummyHash, hashPassword, verifyPassword } from './password';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './tokens';

export interface ClientMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresAt: Date;
}

export interface AuthResult {
  user: PublicUser;
  tokens: IssuedTokens;
}

type UserWithProfile = Prisma.UserGetPayload<{ include: { profile: true } }>;

export function toPublicUser(user: UserWithProfile): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.profile?.displayName ?? user.username,
    avatar: user.profile?.avatar ?? 'comet',
    isGuest: user.isGuest,
  };
}

function uniqueViolation(err: unknown): string | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = (err.meta?.target as string[] | string | undefined) ?? '';
    return Array.isArray(target) ? target.join(',') : target;
  }
  return null;
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
  ) {}

  async register(
    input: { username: string; email?: string | undefined; password: string; displayName?: string | undefined },
    currentUserId: string | null,
    meta: ClientMeta,
  ): Promise<AuthResult> {
    const username = input.username.toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const displayName = input.displayName ?? input.username;
    try {
      const current = currentUserId
        ? await this.prisma.user.findUnique({ where: { id: currentUserId } })
        : null;
      let user: UserWithProfile;
      if (current?.isGuest) {
        // Upgrade the guest account in place so its stats and history are kept.
        user = await this.prisma.user.update({
          where: { id: current.id },
          data: {
            username,
            email: input.email ?? null,
            passwordHash,
            isGuest: false,
            profile: { update: { displayName } },
          },
          include: { profile: true },
        });
        await this.prisma.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } else {
        user = await this.prisma.user.create({
          data: {
            username,
            email: input.email ?? null,
            passwordHash,
            profile: { create: { displayName, avatar: randomAvatar() } },
          },
          include: { profile: true },
        });
      }
      return { user: toPublicUser(user), tokens: await this.issueTokens(user, null, meta) };
    } catch (err) {
      const target = uniqueViolation(err);
      if (target?.includes('email')) throw new HttpError('EMAIL_TAKEN', undefined, { email: 'Already registered' });
      if (target !== null) throw new HttpError('USERNAME_TAKEN', undefined, { username: 'Already taken' });
      throw err;
    }
  }

  async login(input: { login: string; password: string }, meta: ClientMeta): Promise<AuthResult> {
    const login = input.login.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: login.includes('@') ? { email: login } : { username: login },
      include: { profile: true },
    });
    // Always run a hash comparison so response time does not reveal whether the user exists.
    const ok = await verifyPassword(input.password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !user.passwordHash || !ok) throw new HttpError('INVALID_CREDENTIALS');
    await this.prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    return { user: toPublicUser(user), tokens: await this.issueTokens(user, null, meta) };
  }

  async guest(input: { displayName?: string | undefined }, meta: ClientMeta): Promise<AuthResult> {
    const suffix = randomBytes(5).toString('hex');
    const displayName = input.displayName ?? `Guest ${suffix.slice(0, 4).toUpperCase()}`;
    const user = await this.prisma.user.create({
      data: {
        username: `guest_${suffix}`,
        isGuest: true,
        profile: { create: { displayName, avatar: randomAvatar() } },
      },
      include: { profile: true },
    });
    return { user: toPublicUser(user), tokens: await this.issueTokens(user, null, meta) };
  }

  /** Rotate a refresh token. Re-use of a rotated token revokes the whole family. */
  async refresh(rawToken: string, meta: ClientMeta): Promise<AuthResult> {
    const tokenHash = hashRefreshToken(rawToken, this.config.JWT_REFRESH_SECRET);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: { include: { profile: true } } },
    });
    if (!session) throw new HttpError('UNAUTHORIZED', 'Your session has expired. Please sign in again.');
    if (session.revokedAt) {
      await this.prisma.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new HttpError('UNAUTHORIZED', 'Your session has expired. Please sign in again.');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new HttpError('UNAUTHORIZED', 'Your session has expired. Please sign in again.');
    }
    const tokens = await this.issueTokens(session.user, session.familyId, meta);
    const replacement = await this.prisma.session.findUnique({
      where: { tokenHash: hashRefreshToken(tokens.refreshToken, this.config.JWT_REFRESH_SECRET) },
      select: { id: true },
    });
    // Conditional update makes concurrent refreshes with the same token safe: only one wins.
    const revoked = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: replacement?.id ?? null },
    });
    if (revoked.count === 0) {
      await this.prisma.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new HttpError('UNAUTHORIZED', 'Your session has expired. Please sign in again.');
    }
    await this.prisma.user.update({ where: { id: session.userId }, data: { lastSeenAt: new Date() } });
    return { user: toPublicUser(session.user), tokens };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const tokenHash = hashRefreshToken(rawToken, this.config.JWT_REFRESH_SECRET);
    await this.prisma.session.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async getUser(userId: string): Promise<PublicUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { profile: true } });
    return user ? toPublicUser(user) : null;
  }

  private async issueTokens(
    user: { id: string; isGuest: boolean },
    familyId: string | null,
    meta: ClientMeta,
  ): Promise<IssuedTokens> {
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken, this.config.JWT_REFRESH_SECRET),
        familyId: familyId ?? randomUUID(),
        expiresAt: refreshExpiresAt,
        ip: meta.ip?.slice(0, 64) ?? null,
        userAgent: meta.userAgent?.slice(0, 256) ?? null,
      },
    });
    const accessToken = signAccessToken(
      { sub: user.id, g: user.isGuest },
      this.config.JWT_SECRET,
      this.config.ACCESS_TOKEN_TTL_SECONDS,
    );
    return { accessToken, refreshToken, expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS, refreshExpiresAt };
  }
}

function randomAvatar(): string {
  return LIMITS.avatars[randomBytes(1)[0]! % LIMITS.avatars.length]!;
}
