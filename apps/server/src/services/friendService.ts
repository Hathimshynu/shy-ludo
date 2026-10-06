import type { PrismaClient } from '@prisma/client';
import type { FriendEntry, FriendRequestResult, FriendsResponse } from '@ludo/shared-types';
import { toPublicUser } from '../auth/authService';
import { HttpError } from '../errors';

/** Anti-spam limits: pending requests a player may have outstanding, and friends in total. */
export const MAX_PENDING_OUTGOING = 30;
export const MAX_FRIENDS = 200;

/**
 * Friendships between registered players (guests cannot add or be added: a friendship
 * needs a persistent account). Every operation is authorised from the authenticated
 * user id; only public profile fields are ever returned.
 */
export class FriendService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<FriendsResponse> {
    const rows = await this.prisma.friend.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }], status: { in: ['ACCEPTED', 'PENDING'] } },
      include: { requester: { include: { profile: true } }, addressee: { include: { profile: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const friends: FriendEntry[] = [];
    const incoming: FriendEntry[] = [];
    const outgoing: FriendEntry[] = [];
    for (const r of rows) {
      const mine = r.requesterId === userId;
      const other = mine ? r.addressee : r.requester;
      const entry = { user: toPublicUser(other), since: r.createdAt.toISOString() };
      if (r.status === 'ACCEPTED') friends.push(entry);
      else if (mine) outgoing.push(entry);
      else incoming.push(entry);
    }
    friends.sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
    return { friends, incoming, outgoing };
  }

  /** Send a request by username. If they already asked me, this accepts it. */
  async request(userId: string, isGuest: boolean, username: string): Promise<FriendRequestResult> {
    if (isGuest) throw new HttpError('FORBIDDEN', 'Create an account to add friends.');
    const target = await this.prisma.user.findUnique({ where: { username: username.trim().toLowerCase() }, include: { profile: true } });
    // Guests are not discoverable; never reveal whether a guest handle exists.
    if (!target || target.isGuest) throw new HttpError('NOT_FOUND', 'No player with that username.');
    if (target.id === userId) throw new HttpError('BAD_REQUEST', 'You cannot add yourself.');

    const existing = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { requesterId: userId, addresseeId: target.id },
          { requesterId: target.id, addresseeId: userId },
        ],
      },
    });
    if (existing?.status === 'BLOCKED') throw new HttpError('NOT_FOUND', 'No player with that username.');
    if (existing?.status === 'ACCEPTED') throw new HttpError('CONFLICT', 'You are already friends.');
    if (existing && existing.requesterId === userId) throw new HttpError('CONFLICT', 'Friend request already sent.');
    if (existing) {
      // They asked first: accept instead of creating a second, crossed request.
      await this.prisma.friend.update({ where: { id: existing.id }, data: { status: 'ACCEPTED' } });
      return { status: 'accepted', user: toPublicUser(target) };
    }

    const [pending, total] = await Promise.all([
      this.prisma.friend.count({ where: { requesterId: userId, status: 'PENDING' } }),
      this.prisma.friend.count({ where: { OR: [{ requesterId: userId }, { addresseeId: userId }], status: 'ACCEPTED' } }),
    ]);
    if (pending >= MAX_PENDING_OUTGOING) throw new HttpError('RATE_LIMITED', 'Too many pending friend requests. Wait for some to be answered.');
    if (total >= MAX_FRIENDS) throw new HttpError('CONFLICT', 'Your friends list is full.');

    try {
      await this.prisma.friend.create({ data: { requesterId: userId, addresseeId: target.id } });
    } catch {
      // A concurrent identical request won the unique constraint.
      throw new HttpError('CONFLICT', 'Friend request already sent.');
    }
    return { status: 'pending', user: toPublicUser(target) };
  }

  /** Accept a request someone sent me. */
  async accept(userId: string, requesterId: string): Promise<void> {
    const r = await this.prisma.friend.updateMany({
      where: { requesterId, addresseeId: userId, status: 'PENDING' },
      data: { status: 'ACCEPTED' },
    });
    if (r.count === 0) throw new HttpError('NOT_FOUND', 'That friend request no longer exists.');
  }

  /** Decline a request someone sent me. */
  async reject(userId: string, requesterId: string): Promise<void> {
    const r = await this.prisma.friend.deleteMany({ where: { requesterId, addresseeId: userId, status: 'PENDING' } });
    if (r.count === 0) throw new HttpError('NOT_FOUND', 'That friend request no longer exists.');
  }

  /** Remove a friend, or cancel a request I sent. */
  async remove(userId: string, otherId: string): Promise<void> {
    const r = await this.prisma.friend.deleteMany({
      where: {
        OR: [
          { requesterId: userId, addresseeId: otherId, status: { in: ['ACCEPTED', 'PENDING'] } },
          { requesterId: otherId, addresseeId: userId, status: 'ACCEPTED' },
        ],
      },
    });
    if (r.count === 0) throw new HttpError('NOT_FOUND', 'Not on your friends list.');
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    const row = await this.prisma.friend.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: a, addresseeId: b },
          { requesterId: b, addresseeId: a },
        ],
      },
      select: { id: true },
    });
    return !!row;
  }
}
