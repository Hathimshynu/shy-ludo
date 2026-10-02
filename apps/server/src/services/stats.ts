import type { PrismaClient } from '@prisma/client';
import type { GameState, PlayerState } from '@ludo/shared-types';

export interface AchievementDef {
  key: string;
  name: string;
  description: string;
  /** Evaluated against the profile *after* the game's stats were applied. */
  test: (p: ProfileSnapshot, ctx: { player: PlayerState; state: GameState }) => boolean;
}

export interface ProfileSnapshot {
  gamesPlayed: number;
  gamesWon: number;
  captures: number;
  tokensFinished: number;
  rating: number;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { key: 'first-game', name: 'First Roll', description: 'Finish your first ranked game.', test: (p) => p.gamesPlayed >= 1 },
  { key: 'first-win', name: 'Nova Born', description: 'Win a ranked game.', test: (p) => p.gamesWon >= 1 },
  { key: 'wins-10', name: 'Rising Star', description: 'Win 10 ranked games.', test: (p) => p.gamesWon >= 10 },
  { key: 'wins-50', name: 'Supernova', description: 'Win 50 ranked games.', test: (p) => p.gamesWon >= 50 },
  { key: 'games-25', name: 'Regular', description: 'Play 25 ranked games.', test: (p) => p.gamesPlayed >= 25 },
  { key: 'captures-10', name: 'Hunter', description: 'Capture 10 tokens.', test: (p) => p.captures >= 10 },
  { key: 'captures-100', name: 'Black Hole', description: 'Capture 100 tokens.', test: (p) => p.captures >= 100 },
  { key: 'tokens-50', name: 'Homecoming', description: 'Bring 50 tokens home.', test: (p) => p.tokensFinished >= 50 },
  {
    key: 'big-table',
    name: 'Galactic Champion',
    description: 'Win a ranked game with 6 or more players.',
    test: (_p, { player, state }) => player.rank === 1 && state.players.length >= 6,
  },
  {
    key: 'triple-capture',
    name: 'Rampage',
    description: 'Capture 3 or more tokens in a single game.',
    test: (_p, { player }) => player.stats.captures >= 3,
  },
  { key: 'rating-1400', name: 'Constellation', description: 'Reach a rating of 1400.', test: (p) => p.rating >= 1400 },
];

export async function seedAchievements(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(
    ACHIEVEMENTS.map((a, i) =>
      prisma.achievement.upsert({
        where: { key: a.key },
        create: { key: a.key, name: a.name, description: a.description, sortOrder: i },
        update: { name: a.name, description: a.description, sortOrder: i },
      }),
    ),
  );
}

/**
 * Multi-player Elo: every pair of human players is treated as a duel decided by rank.
 */
export function computeRatingDeltas(players: Array<{ id: string; rank: number; rating: number }>): Map<string, number> {
  const deltas = new Map<string, number>(players.map((p) => [p.id, 0]));
  if (players.length < 2) return deltas;
  const k = 32 / (players.length - 1);
  for (const a of players) {
    let delta = 0;
    for (const b of players) {
      if (a.id === b.id) continue;
      const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const score = a.rank < b.rank ? 1 : a.rank > b.rank ? 0 : 0.5;
      delta += k * (score - expected);
    }
    deltas.set(a.id, Math.round(delta));
  }
  return deltas;
}

/**
 * Record final results. Only games with at least two human players are *ranked*
 * (affect profile stats, rating, achievements) — this stops stat farming against bots.
 * Every human still gets a GameResult row for their history.
 */
export async function recordGameResults(
  prisma: PrismaClient,
  state: GameState,
  humanUserIds: ReadonlySet<string>,
): Promise<{ ranked: boolean; unlocked: Record<string, string[]> }> {
  const humans = state.players.filter((p) => p.kind === 'human' && humanUserIds.has(p.id));
  const ranked = humans.length >= 2;
  const unlocked: Record<string, string[]> = {};

  const profiles = await prisma.profile.findMany({ where: { userId: { in: humans.map((h) => h.id) } } });
  const ratingOf = new Map(profiles.map((p) => [p.userId, p.rating]));
  const deltas = ranked
    ? computeRatingDeltas(humans.map((h) => ({ id: h.id, rank: h.rank ?? state.players.length, rating: ratingOf.get(h.id) ?? 1200 })))
    : new Map<string, number>();

  await prisma.$transaction(async (tx) => {
    for (const player of state.players) {
      const isHuman = humans.includes(player);
      const before = ratingOf.get(player.id);
      const delta = deltas.get(player.id) ?? 0;
      await tx.gameResult.upsert({
        where: { gameId_playerId: { gameId: state.id, playerId: player.id } },
        create: {
          gameId: state.id,
          playerId: player.id,
          userId: isHuman ? player.id : null,
          rank: player.rank ?? state.players.length,
          captures: player.stats.captures,
          tokensFinished: player.stats.tokensFinished,
          forfeited: player.status === 'forfeited',
          ratingBefore: isHuman && ranked ? (before ?? 1200) : null,
          ratingAfter: isHuman && ranked ? (before ?? 1200) + delta : null,
        },
        update: {},
      });
      if (!isHuman || !ranked) continue;
      const won = player.rank === 1;
      const profile = await tx.profile.update({
        where: { userId: player.id },
        data: {
          gamesPlayed: { increment: 1 },
          gamesWon: { increment: won ? 1 : 0 },
          captures: { increment: player.stats.captures },
          timesCaptured: { increment: player.stats.timesCaptured },
          tokensFinished: { increment: player.stats.tokensFinished },
          sixesRolled: { increment: player.stats.sixes },
          rating: { increment: delta },
        },
      });
      if (player.rank !== null && (profile.bestRank === null || player.rank < profile.bestRank)) {
        await tx.profile.update({ where: { userId: player.id }, data: { bestRank: player.rank } });
      }
      const earned = ACHIEVEMENTS.filter((a) => a.test(profile, { player, state })).map((a) => a.key);
      if (earned.length > 0) {
        const existing = await tx.userAchievement.findMany({
          where: { userId: player.id, achievementKey: { in: earned } },
          select: { achievementKey: true },
        });
        const have = new Set(existing.map((e) => e.achievementKey));
        const fresh = earned.filter((k) => !have.has(k));
        if (fresh.length > 0) {
          await tx.userAchievement.createMany({
            data: fresh.map((achievementKey) => ({ userId: player.id, achievementKey })),
            skipDuplicates: true,
          });
          unlocked[player.id] = fresh;
        }
      }
    }
  });
  return { ranked, unlocked };
}
