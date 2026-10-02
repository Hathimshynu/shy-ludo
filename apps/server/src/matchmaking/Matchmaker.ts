import { type MatchmakingStatus, type RoomSettings, appError } from '@ludo/shared-types';
import { DEFAULT_VARIANTS, quickMatchRules } from '@ludo/game-engine';
import { GameError } from '../errors';
import type { Logger } from '../logger';
import type { RoomManager, SocketUser } from '../rooms/RoomManager';
import type { GameSessionManager } from '../game/GameSessionManager';
import { type Broadcaster, channels } from '../socket/broadcaster';
import type { MatchQueue } from '../services/coordination';
import type { GameRepository } from '../services/gameRepository';

interface QueueEntry {
  user: SocketUser;
  size: number;
  since: number;
  auditId: string | null;
}

export function quickMatchSettings(size: number): RoomSettings {
  const rules = quickMatchRules(size);
  return {
    maxPlayers: size,
    turnTimeSeconds: rules.turnTimeSeconds,
    tokensPerPlayer: rules.tokensPerPlayer,
    variants: { ...DEFAULT_VARIANTS, continueAfterWinner: rules.continueAfterWinner },
  };
}

/**
 * Quick-match queues for 2/4/6/8 players. Matches are formed by atomically popping
 * exactly `size` users from the queue, so duplicate matches cannot be created.
 * A per-size promise chain additionally serialises matching on this instance.
 */
export class Matchmaker {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly locks = new Map<number, Promise<void>>();

  constructor(
    private readonly deps: {
      queue: MatchQueue;
      rooms: RoomManager;
      sessions: GameSessionManager;
      broadcaster: Broadcaster;
      repo: GameRepository;
      logger: Logger;
    },
  ) {}

  status(userId: string, waiting = 0): MatchmakingStatus {
    const e = this.entries.get(userId);
    return e
      ? { state: 'searching', playerCount: e.size, waiting, since: e.since }
      : { state: 'idle', playerCount: null, waiting: 0, since: null };
  }

  isQueued(userId: string): boolean {
    return this.entries.has(userId);
  }

  async join(user: SocketUser, size: number): Promise<MatchmakingStatus> {
    if (this.deps.sessions.isPlaying(user.id)) throw new GameError(appError('ALREADY_IN_GAME'));
    const existing = this.entries.get(user.id);
    if (existing) {
      if (existing.size === size) return this.status(user.id, await this.deps.queue.length(size));
      throw new GameError(appError('ALREADY_QUEUED'));
    }
    const room = this.deps.rooms.roomOf(user.id);
    if (room?.status === 'playing') throw new GameError(appError('ALREADY_IN_GAME'));
    if (room) this.deps.rooms.leave(user.id);

    const entry: QueueEntry = { user, size, since: Date.now(), auditId: null };
    this.entries.set(user.id, entry);
    await this.deps.queue.add(size, user.id);
    entry.auditId = await this.deps.repo.recordQueueEntry(user.id, size).catch(() => null);
    this.deps.logger.info({ userId: user.id, size }, 'Joined matchmaking');
    await this.tryMatch(size);
    return this.status(user.id, await this.deps.queue.length(size));
  }

  async leave(userId: string): Promise<void> {
    const entry = this.entries.get(userId);
    if (!entry) return;
    this.entries.delete(userId);
    await this.deps.queue.remove(entry.size, userId);
    if (entry.auditId) void this.deps.repo.resolveQueueEntry(entry.auditId, 'left', null).catch(() => undefined);
    this.deps.broadcaster.emit(channels.user(userId), 'matchmaking:status', this.status(userId));
    await this.broadcastWaiting(entry.size);
  }

  private async tryMatch(size: number): Promise<void> {
    const previous = this.locks.get(size) ?? Promise.resolve();
    const run = previous.then(() => this.matchOnce(size));
    this.locks.set(
      size,
      run.catch(() => undefined),
    );
    await run;
  }

  private async matchOnce(size: number): Promise<void> {
    const ids = await this.deps.queue.popIfAtLeast(size, size);
    if (!ids) {
      await this.broadcastWaiting(size);
      return;
    }
    const matched = ids.map((id) => this.entries.get(id)).filter((e): e is QueueEntry => !!e);
    if (matched.length !== size) {
      // Someone left between enqueue and pop on another instance — put the rest back in order.
      for (const e of matched) await this.deps.queue.add(size, e.user.id);
      return;
    }
    for (const e of matched) this.entries.delete(e.user.id);
    try {
      const { room, gameId } = await this.deps.rooms.createMatchRoom(
        matched.map((e) => e.user),
        quickMatchSettings(size),
      );
      this.deps.logger.info({ size, roomId: room.id, gameId }, 'Match created');
      for (const e of matched) {
        if (e.auditId) void this.deps.repo.resolveQueueEntry(e.auditId, 'matched', room.id).catch(() => undefined);
        this.deps.broadcaster.emit(channels.user(e.user.id), 'matchmaking:status', {
          state: 'matched',
          playerCount: size,
          waiting: 0,
          since: e.since,
        });
      }
    } catch (err) {
      this.deps.logger.error({ err, size }, 'Failed to create match; re-queueing players');
      for (const e of matched) {
        this.entries.set(e.user.id, e);
        await this.deps.queue.add(size, e.user.id);
      }
    }
  }

  private async broadcastWaiting(size: number): Promise<void> {
    const waiting = await this.deps.queue.length(size);
    for (const [userId, e] of this.entries) {
      if (e.size === size) {
        this.deps.broadcaster.emit(channels.user(userId), 'matchmaking:status', this.status(userId, waiting));
      }
    }
  }
}
