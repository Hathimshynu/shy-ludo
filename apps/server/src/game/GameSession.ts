import {
  type AckResult,
  type AppError,
  type GameAction,
  type GameEvent,
  type GameSnapshotMessage,
  type GameState,
  appError,
} from '@ludo/shared-types';
import {
  applyAction,
  chooseMove,
  computeFinalRankings,
  type DiceEngine,
  deadlineFor,
  findPlayer,
} from '@ludo/game-engine';
import type { Logger } from '../logger';
import { type Broadcaster, channels } from '../socket/broadcaster';
import type { GameRepository } from '../services/gameRepository';

export interface GameSessionDeps {
  repo: GameRepository;
  broadcaster: Broadcaster;
  logger: Logger;
  dice: DiceEngine;
  botDelayMs: number;
  disconnectGraceSeconds: number;
  isOnline: (userId: string) => boolean;
  /** Called once when the game finishes or is abandoned (after persistence). */
  onEnded: (session: GameSession, outcome: 'finished' | 'abandoned') => Promise<void> | void;
  now?: () => number;
}

export interface ClientActionRequest {
  kind: 'roll' | 'move';
  actionId: string;
  expectedSeq: number;
  tokenIndex?: number;
}

const SEEN_ACTION_LIMIT = 256;

/**
 * One live, server-authoritative game. All state changes go through `applyAction`
 * from the engine. Events are persisted, then broadcast, strictly in order.
 */
export class GameSession {
  private current: GameState;
  private readonly connected = new Set<string>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly seenActions = new Set<string>();
  private readonly seenOrder: string[] = [];
  private turnTimer: NodeJS.Timeout | null = null;
  private botTimer: NodeJS.Timeout | null = null;
  private pipeline: Promise<void> = Promise.resolve();
  private readonly lastEmote = new Map<string, number>();
  private paused = false;
  private ended = false;
  private readonly now: () => number;

  constructor(
    state: GameState,
    readonly roomId: string,
    private readonly deps: GameSessionDeps,
  ) {
    this.current = state;
    this.now = deps.now ?? Date.now;
  }

  get id(): string {
    return this.current.id;
  }

  get state(): GameState {
    return this.current;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Resolves once every queued persistence/broadcast step has completed. */
  idle(): Promise<void> {
    return this.pipeline;
  }

  humanIds(): string[] {
    return this.current.players.filter((p) => p.kind === 'human').map((p) => p.id);
  }

  /** Humans still playing (not finished/forfeited). */
  activeHumanIds(): string[] {
    return this.current.players.filter((p) => p.kind === 'human' && p.status === 'active').map((p) => p.id);
  }

  isParticipant(userId: string): boolean {
    return this.current.players.some((p) => p.id === userId && p.kind === 'human');
  }

  snapshot(): GameSnapshotMessage {
    const connected: Record<string, boolean> = {};
    for (const p of this.current.players) connected[p.id] = p.kind === 'bot' || this.connected.has(p.id);
    return {
      gameId: this.id,
      roomId: this.roomId,
      state: this.current,
      connected,
      paused: this.paused,
      serverTime: this.now(),
    };
  }

  /** Start timers. Humans that are online now count as connected. */
  start(): void {
    for (const id of this.humanIds()) {
      if (this.deps.isOnline(id)) this.connected.add(id);
      else this.startGrace(id);
    }
    this.evaluatePause();
    this.schedule();
  }

  // -------------------------------------------------------------------------
  // Client actions
  // -------------------------------------------------------------------------

  handleClientAction(userId: string, req: ClientActionRequest): AckResult<{ seq: number }> {
    if (this.ended || this.current.status !== 'playing') return { ok: false, error: appError('GAME_OVER') };
    const player = findPlayer(this.current, userId);
    if (!player || player.kind !== 'human') return { ok: false, error: appError('NOT_IN_GAME') };
    if (this.seenActions.has(req.actionId)) return { ok: false, error: appError('DUPLICATE_ACTION') };
    this.rememberAction(req.actionId);
    if (req.expectedSeq !== this.current.seq) return { ok: false, error: appError('STALE_STATE') };
    if (this.paused) return { ok: false, error: appError('GAME_PAUSED') };

    const action: GameAction =
      req.kind === 'roll'
        ? { type: 'ROLL', playerId: userId }
        : { type: 'MOVE', playerId: userId, tokenIndex: req.tokenIndex ?? -1 };
    const error = this.apply(action);
    if (error) return { ok: false, error };
    return { ok: true, seq: this.current.seq };
  }

  leave(userId: string): AckResult {
    const player = findPlayer(this.current, userId);
    if (!player || player.kind !== 'human') return { ok: false, error: appError('NOT_IN_GAME') };
    if (player.status === 'active' && !this.ended) this.apply({ type: 'FORFEIT', playerId: userId, reason: 'left' });
    this.clearGrace(userId);
    this.connected.delete(userId);
    this.deps.broadcaster.leave(userId, channels.game(this.id));
    return { ok: true };
  }

  emote(userId: string, emote: string): AckResult {
    if (!this.isParticipant(userId)) return { ok: false, error: appError('NOT_IN_GAME') };
    const last = this.lastEmote.get(userId) ?? 0;
    if (this.now() - last < 1500) return { ok: false, error: appError('RATE_LIMITED') };
    this.lastEmote.set(userId, this.now());
    this.deps.broadcaster.emit(channels.game(this.id), 'game:emote', { gameId: this.id, playerId: userId, emote });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  userConnected(userId: string): void {
    if (!this.isParticipant(userId) || this.ended) return;
    const wasConnected = this.connected.has(userId);
    this.connected.add(userId);
    this.clearGrace(userId);
    if (!wasConnected) {
      this.deps.broadcaster.emit(channels.game(this.id), 'player:reconnect', { gameId: this.id, playerId: userId });
    }
    this.evaluatePause();
  }

  userDisconnected(userId: string): void {
    if (!this.isParticipant(userId) || this.ended) return;
    this.connected.delete(userId);
    const player = findPlayer(this.current, userId);
    if (player?.status === 'active') {
      this.deps.broadcaster.emit(channels.game(this.id), 'player:disconnect', {
        gameId: this.id,
        playerId: userId,
        graceSeconds: this.deps.disconnectGraceSeconds,
      });
      this.startGrace(userId);
    }
    this.evaluatePause();
  }

  private startGrace(userId: string): void {
    this.clearGrace(userId);
    const timer = setTimeout(() => {
      this.graceTimers.delete(userId);
      if (this.ended || this.connected.has(userId)) return;
      this.deps.logger.info({ gameId: this.id, userId }, 'Player forfeited after disconnect grace period');
      this.apply({ type: 'FORFEIT', playerId: userId, reason: 'disconnect' });
    }, this.deps.disconnectGraceSeconds * 1000);
    timer.unref?.();
    this.graceTimers.set(userId, timer);
  }

  private clearGrace(userId: string): void {
    const t = this.graceTimers.get(userId);
    if (t) clearTimeout(t);
    this.graceTimers.delete(userId);
  }

  /** Pause when no active human is connected; resume (with a fresh deadline) when one returns. */
  private evaluatePause(): void {
    if (this.ended || this.current.status !== 'playing') return;
    const anyone = this.activeHumanIds().some((id) => this.connected.has(id));
    if (!anyone && !this.paused) {
      this.paused = true;
      this.clearTimers();
      this.deps.broadcaster.emit(channels.game(this.id), 'game:pause', {
        gameId: this.id,
        reason: 'All players are disconnected',
      });
    } else if (anyone && this.paused) {
      this.paused = false;
      const next = structuredClone(this.current);
      next.turn.deadline = deadlineFor(next.rules, this.now());
      this.current = next;
      this.enqueue(async () => {
        await this.deps.repo.saveSnapshot(next);
      });
      this.deps.broadcaster.emit(channels.game(this.id), 'game:resume', {
        gameId: this.id,
        deadline: next.turn.deadline,
      });
      this.schedule();
    }
  }

  // -------------------------------------------------------------------------
  // Core
  // -------------------------------------------------------------------------

  private apply(action: GameAction): AppError | null {
    if (this.ended) return appError('GAME_OVER');
    const result = applyAction(this.current, action, { now: this.now(), dice: this.deps.dice });
    if (!result.ok) return result.error;
    this.commit(result.state, result.events);
    return null;
  }

  private commit(state: GameState, events: GameEvent[]): void {
    this.current = state;
    if (events.length > 0) {
      this.enqueue(async () => {
        try {
          await this.deps.repo.appendEvents(state, events);
        } catch (err) {
          // The game continues from memory; the snapshot will be retried with the next batch.
          this.deps.logger.error({ err, gameId: this.id }, 'Failed to persist game events');
        }
        this.deps.broadcaster.emit(channels.game(this.id), 'game:events', {
          gameId: this.id,
          events,
          serverTime: this.now(),
        });
      });
    }

    if (state.status === 'finished') {
      this.end('finished');
      return;
    }
    if (this.activeHumanIds().length === 0) {
      this.end('abandoned');
      return;
    }
    this.evaluatePause();
    this.schedule();
  }

  private enqueue(step: () => Promise<void>): void {
    this.pipeline = this.pipeline.then(step).catch((err: unknown) => {
      this.deps.logger.error({ err, gameId: this.id }, 'Game pipeline step failed');
    });
  }

  private schedule(): void {
    this.clearTimers();
    if (this.ended || this.paused || this.current.status !== 'playing') return;
    const turn = this.current.turn;
    const player = findPlayer(this.current, turn.playerId);
    if (player?.kind === 'bot') {
      this.botTimer = setTimeout(() => this.botAct(turn.turnNumber, turn.phase), this.deps.botDelayMs);
    }
    if (turn.deadline !== null) {
      const delay = Math.max(0, turn.deadline - this.now());
      this.turnTimer = setTimeout(() => this.onDeadline(turn.turnNumber, turn.phase), delay);
    }
  }

  private clearTimers(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.botTimer) clearTimeout(this.botTimer);
    this.turnTimer = null;
    this.botTimer = null;
  }

  private stillCurrent(turnNumber: number, phase: string): boolean {
    const t = this.current.turn;
    return !this.ended && !this.paused && this.current.status === 'playing' && t.turnNumber === turnNumber && t.phase === phase;
  }

  private onDeadline(turnNumber: number, phase: string): void {
    if (!this.stillCurrent(turnNumber, phase)) return;
    const error = this.apply({ type: 'TIMEOUT' });
    if (error) this.deps.logger.warn({ gameId: this.id, error }, 'Timeout action rejected');
  }

  private botAct(turnNumber: number, phase: string): void {
    if (!this.stillCurrent(turnNumber, phase)) return;
    const bot = findPlayer(this.current, this.current.turn.playerId);
    if (!bot || bot.kind !== 'bot') return;
    let error: AppError | null;
    if (this.current.turn.phase === 'roll') {
      error = this.apply({ type: 'ROLL', playerId: bot.id });
    } else {
      const move = chooseMove(this.current, bot.id, bot.botLevel ?? 'medium');
      error = move ? this.apply({ type: 'MOVE', playerId: bot.id, tokenIndex: move.tokenIndex }) : null;
    }
    if (error) this.deps.logger.warn({ gameId: this.id, error }, 'Bot action rejected');
  }

  private end(outcome: 'finished' | 'abandoned'): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    for (const id of [...this.graceTimers.keys()]) this.clearGrace(id);
    const state = this.current;
    const rankings = outcome === 'finished' ? state.rankings : computeFinalRankings(state);
    this.enqueue(async () => {
      if (outcome === 'abandoned') await this.deps.repo.markAbandoned(state.id, state);
      try {
        await this.deps.onEnded(this, outcome);
      } finally {
        this.deps.broadcaster.emit(channels.game(this.id), 'game:finish', { gameId: this.id, rankings });
        this.deps.logger.info({ gameId: this.id, outcome, rankings }, 'Game ended');
      }
    });
  }

  /** Stop all timers (server shutdown). State is already persisted. */
  dispose(): void {
    this.clearTimers();
    for (const id of [...this.graceTimers.keys()]) this.clearGrace(id);
  }

  private rememberAction(id: string): void {
    this.seenActions.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_ACTION_LIMIT) {
      const old = this.seenOrder.shift();
      if (old) this.seenActions.delete(old);
    }
  }
}
