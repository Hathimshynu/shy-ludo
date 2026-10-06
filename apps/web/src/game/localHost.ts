import {
  type AckResult,
  type AiDifficulty,
  type GameAction,
  type GameEvent,
  type GameState,
  type NewPlayerInput,
  type RuleVariants,
  appError,
} from '@ludo/shared-types';
import {
  applyAction,
  chooseMove,
  createDiceEngine,
  createGame,
  currentBot,
  type DiceEngine,
} from '@ludo/game-engine';

export interface SoloConfig {
  playerName: string;
  avatar: string;
  opponents: number;
  difficulty: AiDifficulty;
  turnTimeSeconds: number;
  tokensPerPlayer: number;
  variants: RuleVariants;
}

export type HostInbound =
  | { type: 'init'; config: SoloConfig; saved?: GameState | null }
  | { type: 'roll'; requestId: number; expectedSeq: number }
  | { type: 'move'; requestId: number; expectedSeq: number; tokenIndex: number }
  | { type: 'sync' }
  | { type: 'idle'; seq: number };

export type HostOutbound =
  | { type: 'snapshot'; state: GameState }
  | { type: 'events'; events: GameEvent[] }
  | { type: 'ack'; requestId: number; result: AckResult<{ seq?: number }> }
  | { type: 'finish'; rankings: string[] }
  | { type: 'save'; state: GameState | null };

export const SOLO_HUMAN_ID = 'you';
const BOT_NAMES = ['Astra', 'Bolt', 'Cosmo', 'Dash', 'Echo', 'Flux', 'Halo'];
const BOT_AVATARS = ['rocket', 'saturn', 'pulsar', 'quasar', 'meteor', 'orbit', 'galaxy'];

export function soloPlayers(config: SoloConfig): NewPlayerInput[] {
  const players: NewPlayerInput[] = [
    { id: SOLO_HUMAN_ID, name: config.playerName || 'You', avatar: config.avatar, kind: 'human' },
  ];
  for (let i = 0; i < Math.min(7, Math.max(1, config.opponents)); i += 1) {
    players.push({
      id: `ai${i + 1}`,
      name: BOT_NAMES[i]!,
      avatar: BOT_AVATARS[i]!,
      kind: 'bot',
      botLevel: config.difficulty,
    });
  }
  return players;
}

function cryptoRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 4294967296;
}

/**
 * Hosts a solo game: the same authoritative engine the server uses, plus AI
 * opponents. Runs inside a Web Worker so AI and rules never block rendering.
 */
export class LocalGameHost {
  private state: GameState | null = null;
  private readonly dice: DiceEngine;
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private idleSeq = -1;

  constructor(
    private readonly post: (msg: HostOutbound) => void,
    private readonly opts: { random?: () => number; botDelayMs?: number; now?: () => number } = {},
  ) {
    this.dice = createDiceEngine({ random: opts.random ?? cryptoRandom });
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  handle(msg: HostInbound): void {
    switch (msg.type) {
      case 'init': {
        if (msg.saved && msg.saved.status === 'playing') {
          this.state = msg.saved;
          // A resumed game gets a fresh timer.
          if (this.state.turn.deadline !== null && this.state.rules.turnTimeSeconds > 0) {
            this.state = { ...this.state, turn: { ...this.state.turn, deadline: this.now() + this.state.rules.turnTimeSeconds * 1000 } };
          }
        } else {
          const c = msg.config;
          this.state = createGame({
            id: `solo_${Math.floor(cryptoRandom() * 1e12).toString(36)}`,
            players: soloPlayers(c),
            rules: {
              ...c.variants,
              tokensPerPlayer: c.tokensPerPlayer,
              turnTimeSeconds: c.turnTimeSeconds,
              maxConsecutiveTimeouts: 0,
              maxPlayers: c.opponents + 1,
            },
            now: this.now(),
            firstSeat: 0,
          });
        }
        this.post({ type: 'snapshot', state: this.state });
        this.post({ type: 'save', state: this.state });
        this.schedule();
        break;
      }
      case 'sync':
        if (this.state) this.post({ type: 'snapshot', state: this.state });
        break;
      case 'idle':
        this.idleSeq = msg.seq;
        this.schedule();
        break;
      case 'roll':
        this.post({ type: 'ack', requestId: msg.requestId, result: this.human(msg.expectedSeq, { type: 'ROLL', playerId: SOLO_HUMAN_ID }) });
        break;
      case 'move':
        this.post({
          type: 'ack',
          requestId: msg.requestId,
          result: this.human(msg.expectedSeq, { type: 'MOVE', playerId: SOLO_HUMAN_ID, tokenIndex: msg.tokenIndex }),
        });
        break;
    }
  }

  dispose(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    if (this.turnTimer) clearTimeout(this.turnTimer);
  }

  private human(expectedSeq: number, action: GameAction): AckResult<{ seq?: number }> {
    if (!this.state) return { ok: false, error: appError('GAME_NOT_FOUND') };
    if (expectedSeq !== this.state.seq) return { ok: false, error: appError('STALE_STATE') };
    return this.apply(action);
  }

  private apply(action: GameAction): AckResult<{ seq?: number }> {
    const result = applyAction(this.state!, action, { now: this.now(), dice: this.dice });
    if (!result.ok) return { ok: false, error: result.error };
    this.state = result.state;
    this.post({ type: 'events', events: result.events });
    if (this.state.status === 'finished') {
      this.post({ type: 'finish', rankings: this.state.rankings });
      this.post({ type: 'save', state: null });
      this.dispose();
    } else {
      this.post({ type: 'save', state: this.state });
      this.schedule();
    }
    return { ok: true, seq: this.state.seq };
  }

  private schedule(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.botTimer = null;
    this.turnTimer = null;
    const s = this.state;
    if (!s || s.status !== 'playing') return;
    const bot = currentBot(s);
    // Bots wait until the board has finished animating up to the current state.
    if (bot && this.idleSeq === s.seq) {
      const seq = s.seq;
      this.botTimer = setTimeout(() => {
        if (!this.state || this.state.seq !== seq) return;
        if (this.state.turn.phase === 'roll') this.apply({ type: 'ROLL', playerId: bot.id });
        else {
          const move = chooseMove(this.state, bot.id, bot.botLevel ?? 'medium', this.opts.random);
          if (move) this.apply({ type: 'MOVE', playerId: bot.id, tokenIndex: move.tokenIndex });
        }
      }, this.opts.botDelayMs ?? 650);
    }
    if (!bot && s.turn.deadline !== null && this.idleSeq === s.seq) {
      const turn = s.turn.turnNumber;
      const phase = s.turn.phase;
      this.turnTimer = setTimeout(() => {
        if (this.state?.turn.turnNumber === turn && this.state.turn.phase === phase) this.apply({ type: 'TIMEOUT' });
      }, Math.max(0, s.turn.deadline - this.now()));
    }
  }
}
