import { randomInt, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { type GameRules, type GameState, type NewPlayerInput, appError, settingsToRules } from '@ludo/shared-types';
import { createDiceEngine, createGame, DEFAULT_RULES, type DiceEngine, seededRandom } from '@ludo/game-engine';
import type { AppConfig } from '../config';
import { GameError } from '../errors';
import type { Logger } from '../logger';
import type { Room } from '../rooms/RoomManager';
import { type Broadcaster, channels } from '../socket/broadcaster';
import type { GameRepository, StoredRoomInfo } from '../services/gameRepository';
import { recordGameResults } from '../services/stats';
import { type ClientActionRequest, GameSession } from './GameSession';

export interface GameSessionManagerDeps {
  config: AppConfig;
  prisma: PrismaClient;
  repo: GameRepository;
  broadcaster: Broadcaster;
  logger: Logger;
  isOnline: (userId: string) => boolean;
  onGameEnded: (session: GameSession) => void;
  onPlayerReleased: (userId: string) => void;
}

/** Cryptographically secure dice for production; seeded dice only in tests. */
export function createServerDice(config: AppConfig): DiceEngine {
  if (config.DICE_SEED !== undefined && !config.isProduction) {
    return createDiceEngine({ random: seededRandom(config.DICE_SEED) });
  }
  return { roll: () => randomInt(1, 7) };
}

export class GameSessionManager {
  private readonly sessions = new Map<string, GameSession>();
  private readonly userGame = new Map<string, string>();
  private readonly dice: DiceEngine;

  constructor(private readonly deps: GameSessionManagerDeps) {
    this.dice = createServerDice(deps.config);
  }

  get(gameId: string): GameSession | undefined {
    return this.sessions.get(gameId);
  }

  /** The live game the user is seated in (active or not yet released), if any. */
  forUser(userId: string): GameSession | undefined {
    const id = this.userGame.get(userId);
    return id ? this.sessions.get(id) : undefined;
  }

  /** True when the user still has an active (not forfeited/finished) seat in a running game. */
  isPlaying(userId: string): boolean {
    const session = this.forUser(userId);
    return !!session && session.activeHumanIds().includes(userId);
  }

  count(): number {
    return this.sessions.size;
  }

  async startFromRoom(room: Room): Promise<string> {
    const players: NewPlayerInput[] = room.seats.map((s) => ({
      id: s.id,
      name: s.name,
      avatar: s.avatar,
      kind: s.kind,
      botLevel: s.botLevel,
    }));
    const rules: GameRules = settingsToRules(room.settings, DEFAULT_RULES);
    if (this.deps.config.TEST_TURN_SECONDS && !this.deps.config.isProduction) {
      rules.turnTimeSeconds = this.deps.config.TEST_TURN_SECONDS;
    }
    rules.maxPlayers = Math.max(rules.maxPlayers, players.length);
    const state = createGame({
      id: `game_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      players,
      rules,
      now: Date.now(),
      firstSeat: randomInt(players.length),
    });
    await this.deps.repo.createGame(state, room.id);

    const session = this.createSession(state, room.id);
    for (const id of session.humanIds()) {
      this.userGame.set(id, state.id);
      this.deps.broadcaster.join(id, channels.game(state.id));
    }
    this.deps.logger.info(
      { gameId: state.id, roomId: room.id, players: players.length, arms: state.armCount },
      'Game started',
    );
    this.deps.broadcaster.emit(channels.game(state.id), 'game:start', session.snapshot());
    session.start();
    return state.id;
  }

  /** Reload every ACTIVE game from the database after a restart. */
  async recover(restoreRoom: (stored: StoredRoomInfo, state: GameState) => void): Promise<number> {
    const games = await this.deps.repo.loadActiveGames();
    for (const { state, room } of games) {
      if (state.status !== 'playing') continue;
      const roomId = room?.id ?? `room_recovered_${state.id}`;
      if (room) restoreRoom(room, state);
      const session = this.createSession(state, roomId);
      for (const p of state.players) {
        if (p.kind === 'human' && p.status === 'active') this.userGame.set(p.id, state.id);
      }
      session.start();
    }
    if (games.length > 0) this.deps.logger.info({ count: games.length }, 'Recovered active games');
    return games.length;
  }

  handleAction(userId: string, gameId: string, req: ClientActionRequest) {
    const session = this.sessions.get(gameId);
    if (!session) return { ok: false as const, error: appError('GAME_NOT_FOUND') };
    return session.handleClientAction(userId, req);
  }

  sync(userId: string, gameId: string) {
    const session = this.sessions.get(gameId);
    if (!session) throw new GameError(appError('GAME_NOT_FOUND'));
    if (!session.isParticipant(userId)) throw new GameError(appError('NOT_IN_GAME'));
    this.deps.broadcaster.join(userId, channels.game(gameId));
    return session.snapshot();
  }

  leave(userId: string, gameId?: string): void {
    const session = gameId ? this.sessions.get(gameId) : this.forUser(userId);
    if (!session) return;
    session.leave(userId);
    if (this.userGame.get(userId) === session.id) this.userGame.delete(userId);
    this.deps.onPlayerReleased(userId);
  }

  emote(userId: string, gameId: string, emote: string) {
    const session = this.sessions.get(gameId);
    if (!session) return { ok: false as const, error: appError('GAME_NOT_FOUND') };
    return session.emote(userId, emote);
  }

  userConnected(userId: string): void {
    this.forUser(userId)?.userConnected(userId);
  }

  userDisconnected(userId: string): void {
    this.forUser(userId)?.userDisconnected(userId);
  }

  async shutdown(): Promise<void> {
    for (const s of this.sessions.values()) s.dispose();
    await Promise.all([...this.sessions.values()].map((s) => s.idle()));
  }

  private createSession(state: GameState, roomId: string): GameSession {
    const session = new GameSession(state, roomId, {
      repo: this.deps.repo,
      broadcaster: this.deps.broadcaster,
      logger: this.deps.logger,
      dice: this.dice,
      botDelayMs: this.deps.config.BOT_DELAY_MS,
      disconnectGraceSeconds: this.deps.config.DISCONNECT_GRACE_SECONDS,
      isOnline: this.deps.isOnline,
      onEnded: async (s, outcome) => {
        try {
          if (outcome === 'finished') {
            const humans = new Set(s.humanIds());
            const { ranked, unlocked } = await recordGameResults(this.deps.prisma, s.state, humans);
            this.deps.logger.info({ gameId: s.id, ranked, unlocked }, 'Game results recorded');
          }
        } catch (err) {
          this.deps.logger.error({ err, gameId: s.id }, 'Failed to record game results');
        } finally {
          this.sessions.delete(s.id);
          for (const id of s.humanIds()) {
            if (this.userGame.get(id) === s.id) this.userGame.delete(id);
          }
          this.deps.onGameEnded(s);
        }
      },
    });
    this.sessions.set(state.id, session);
    return session;
  }
}
