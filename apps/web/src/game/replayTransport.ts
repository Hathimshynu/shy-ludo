import type { AckResult, GameEvent, GameState } from '@ludo/shared-types';
import { appError } from '@ludo/shared-types';
import { applyEvents } from '@ludo/game-engine';
import type { GameTransport, TransportHandlers } from './transport';

export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface ReplayStatus {
  /** Number of recorded events applied so far. */
  position: number;
  total: number;
  /** Index of the current move (a dice roll or a token move) and how many there are. */
  move: number;
  moves: number;
  playing: boolean;
  speed: ReplaySpeed;
}

/** Events that start a new "move" for stepping: every roll and every token move. */
const STEP_START = new Set<GameEvent['type']>(['DICE_ROLLED', 'TOKEN_MOVED']);
/** Pause between moves at 1× (the board's own animations play on top of this). */
const BASE_GAP_MS = 450;

/**
 * Plays a finished (or past) game back from its recorded event log through the same
 * GameDirector/GameView as a live game. Read-only: actions are refused and the recorded
 * data is never modified; every position is rebuilt with the engine's own projection.
 */
export class ReplayTransport implements GameTransport {
  readonly mode = 'replay' as const;
  private handlers: TransportHandlers | null = null;
  private position = 0;
  private playing = false;
  private speed: ReplaySpeed = 1;
  private timer: number | null = null;
  /** Event index where each move starts. */
  private readonly steps: number[];
  private readonly listeners = new Set<(s: ReplayStatus) => void>();

  constructor(
    private readonly initial: GameState,
    private readonly events: readonly GameEvent[],
  ) {
    const steps = [0];
    events.forEach((e, i) => {
      if (i > 0 && STEP_START.has(e.type)) steps.push(i);
    });
    this.steps = steps;
  }

  // ---- GameTransport ------------------------------------------------------------------

  subscribe(handlers: TransportHandlers): () => void {
    this.handlers = handlers;
    return () => {
      this.handlers = null;
      this.stopTimer();
    };
  }

  requestSnapshot(): void {
    this.handlers?.onSnapshot({ state: this.stateAt(this.position), connected: {}, paused: false });
  }

  /** The director finished animating up to `seq`: schedule the next move while playing. */
  notifyIdle(): void {
    if (!this.playing) return;
    if (this.position >= this.events.length) {
      this.setPlaying(false);
      return;
    }
    this.stopTimer();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.playing) this.pushNextMove();
    }, BASE_GAP_MS / this.speed);
  }

  roll(): Promise<AckResult<{ seq?: number }>> {
    return Promise.resolve({ ok: false, error: appError('FORBIDDEN', 'This is a replay.') });
  }

  move(): Promise<AckResult<{ seq?: number }>> {
    return this.roll();
  }

  emote(): Promise<AckResult> {
    return Promise.resolve({ ok: false, error: appError('FORBIDDEN', 'This is a replay.') });
  }

  leave(): Promise<void> {
    this.dispose();
    return Promise.resolve();
  }

  now(): number {
    // Freeze turn timers at the moment the current position was recorded.
    const s = this.stateAt(this.position);
    return s.turn.deadline !== null ? s.turn.deadline - s.rules.turnTimeSeconds * 1000 : Date.now();
  }

  // ---- Controls -----------------------------------------------------------------------

  get status(): ReplayStatus {
    return {
      position: this.position,
      total: this.events.length,
      move: this.moveIndex(),
      moves: this.steps.length,
      playing: this.playing,
      speed: this.speed,
    };
  }

  onStatus(fn: (s: ReplayStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  play(): void {
    if (this.position >= this.events.length) this.seek(0);
    this.setPlaying(true);
    this.pushNextMove();
  }

  pause(): void {
    this.setPlaying(false);
  }

  setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;
    this.emitStatus();
  }

  /** Animate the next move (dice roll or token move with its consequences). */
  next(): void {
    this.setPlaying(false);
    this.pushNextMove();
  }

  /** Undo the latest move: jump back to just before it (no animation). */
  previous(): void {
    this.setPlaying(false);
    const applied = this.steps.filter((s) => s < this.position);
    this.seek(applied.at(-1) ?? 0);
  }

  restart(): void {
    this.setPlaying(false);
    this.seek(0);
  }

  dispose(): void {
    this.setPlaying(false);
    this.listeners.clear();
  }

  // ---- Internals ----------------------------------------------------------------------

  private stateAt(position: number): GameState {
    return applyEvents(this.initial, this.events.slice(0, position));
  }

  /** Moves applied so far. */
  private moveIndex(): number {
    return this.steps.filter((s) => s < this.position).length;
  }

  private seek(position: number): void {
    this.stopTimer();
    this.position = Math.max(0, Math.min(this.events.length, position));
    this.requestSnapshot();
    this.emitStatus();
  }

  private pushNextMove(): void {
    if (this.position >= this.events.length) {
      this.setPlaying(false);
      return;
    }
    const start = this.position;
    const nextStep = this.steps.find((s) => s > start) ?? this.events.length;
    const batch = this.events.slice(start, nextStep);
    this.position = nextStep;
    this.emitStatus();
    this.handlers?.onEvents(batch);
  }

  private setPlaying(playing: boolean): void {
    if (!playing) this.stopTimer();
    if (this.playing !== playing) {
      this.playing = playing;
      this.emitStatus();
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private emitStatus(): void {
    const s = this.status;
    this.listeners.forEach((fn) => fn(s));
  }
}
