import type { PrismaClient } from '@prisma/client';
import type {
  GameHistoryEntry,
  LeaderboardCategory,
  LeaderboardEntry,
  LeaderboardResponse,
  PlayerColor,
  ProfileView,
} from '@ludo/shared-types';
import { toPublicUser } from '../auth/authService';
import { HttpError } from '../errors';

const CATEGORY_FIELD = {
  wins: 'gamesWon',
  games: 'gamesPlayed',
  captures: 'captures',
  rating: 'rating',
} as const satisfies Record<LeaderboardCategory, string>;

export class ProfileService {
  constructor(private readonly prisma: PrismaClient) {}

  async getProfile(userId: string): Promise<ProfileView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true, achievements: true },
    });
    if (!user?.profile) throw new HttpError('NOT_FOUND', 'Player not found.');
    const all = await this.prisma.achievement.findMany({ orderBy: { sortOrder: 'asc' } });
    const unlocked = new Map(user.achievements.map((a) => [a.achievementKey, a.unlockedAt]));
    const p = user.profile;
    return {
      user: toPublicUser(user),
      memberSince: user.createdAt.toISOString(),
      stats: {
        gamesPlayed: p.gamesPlayed,
        gamesWon: p.gamesWon,
        winRate: p.gamesPlayed > 0 ? Math.round((p.gamesWon / p.gamesPlayed) * 1000) / 10 : 0,
        captures: p.captures,
        timesCaptured: p.timesCaptured,
        tokensFinished: p.tokensFinished,
        sixesRolled: p.sixesRolled,
        rating: p.rating,
        bestRank: p.bestRank,
      },
      achievements: all.map((a) => ({
        key: a.key,
        name: a.name,
        description: a.description,
        unlockedAt: unlocked.get(a.key)?.toISOString() ?? null,
      })),
    };
  }

  /** Only cosmetic fields are writable; statistics are never accepted from clients. */
  async updateProfile(userId: string, input: { displayName?: string | undefined; avatar?: string | undefined }) {
    await this.prisma.profile.update({
      where: { userId },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
      },
    });
    return this.getProfile(userId);
  }

  async leaderboard(category: LeaderboardCategory, limit: number, meId: string | null): Promise<LeaderboardResponse> {
    const field = CATEGORY_FIELD[category];
    const where = { gamesPlayed: { gt: 0 }, user: { isGuest: false } };
    const rows = await this.prisma.profile.findMany({
      where,
      orderBy: [{ [field]: 'desc' }, { gamesPlayed: 'desc' }, { userId: 'asc' }],
      take: limit,
      include: { user: { include: { profile: true } } },
    });
    const entries: LeaderboardEntry[] = rows.map((r, i) => ({
      rank: i + 1,
      user: toPublicUser(r.user),
      value: r[field],
      gamesPlayed: r.gamesPlayed,
    }));
    let me: LeaderboardEntry | null = entries.find((e) => e.user.id === meId) ?? null;
    if (!me && meId) {
      const mine = await this.prisma.profile.findUnique({
        where: { userId: meId },
        include: { user: { include: { profile: true } } },
      });
      if (mine && !mine.user.isGuest && mine.gamesPlayed > 0) {
        const ahead = await this.prisma.profile.count({ where: { ...where, [field]: { gt: mine[field] } } });
        me = { rank: ahead + 1, user: toPublicUser(mine.user), value: mine[field], gamesPlayed: mine.gamesPlayed };
      }
    }
    return { category, entries, me };
  }

  async history(userId: string, limit = 20): Promise<GameHistoryEntry[]> {
    const results = await this.prisma.gameResult.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { game: { select: { finishedAt: true, playerCount: true, players: true } } },
    });
    return results.map((r) => ({
      gameId: r.gameId,
      finishedAt: r.game.finishedAt?.toISOString() ?? null,
      playerCount: r.game.playerCount,
      rank: r.rank,
      color: (r.game.players.find((p) => p.playerId === r.playerId)?.color ?? 'red') as PlayerColor,
      captures: r.captures,
      ratingDelta: r.ratingAfter !== null && r.ratingBefore !== null ? r.ratingAfter - r.ratingBefore : 0,
    }));
  }
}
