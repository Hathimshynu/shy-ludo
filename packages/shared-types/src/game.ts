import type { GameRules } from './rules';

export const PLAYER_COLORS = [
  'red',
  'green',
  'yellow',
  'blue',
  'purple',
  'orange',
  'cyan',
  'pink',
] as const;
export type PlayerColor = (typeof PLAYER_COLORS)[number];

export type AiDifficulty = 'easy' | 'medium' | 'hard' | 'expert';
export const AI_DIFFICULTIES: readonly AiDifficulty[] = ['easy', 'medium', 'hard', 'expert'];
export type PlayerKind = 'human' | 'bot';
export type PlayerStatus = 'active' | 'finished' | 'forfeited';
export type ForfeitReason = 'timeout' | 'disconnect' | 'left';

export interface PlayerStats {
  captures: number;
  timesCaptured: number;
  sixes: number;
  tokensFinished: number;
  rolls: number;
}

export interface PlayerState {
  /** User id (humans) or a generated bot id. Never supplied by clients. */
  id: string;
  name: string;
  avatar: string;
  kind: PlayerKind;
  botLevel: AiDifficulty | null;
  /** Turn order index 0..n-1. */
  seat: number;
  /** Board arm this player owns. */
  arm: number;
  color: PlayerColor;
  /**
   * Token progress values: -1 = base, 0 = start square, finish = trackLength + 4.
   * See GAME_RULES.md.
   */
  tokens: number[];
  status: PlayerStatus;
  rank: number | null;
  consecutiveTimeouts: number;
  forfeitReason: ForfeitReason | null;
  stats: PlayerStats;
}

export type MoveKind = 'release' | 'move' | 'enter-lane' | 'finish';

export interface TokenRef {
  playerId: string;
  tokenIndex: number;
}

export interface LegalMove {
  tokenIndex: number;
  from: number;
  to: number;
  /** Progress values visited, excluding `from`, ending with `to`. */
  path: number[];
  kind: MoveKind;
  captures: TokenRef[];
}

export type TurnPhase = 'roll' | 'move' | 'over';

export interface TurnState {
  playerId: string;
  phase: TurnPhase;
  dice: number | null;
  consecutiveSixes: number;
  legalMoves: LegalMove[];
  /** Epoch ms when the current phase times out (server clock). null = no timer. */
  deadline: number | null;
  /** Increments whenever a new roll opportunity begins (new player or extra turn). */
  turnNumber: number;
}

export type GameStatus = 'playing' | 'finished';

export interface GameState {
  schemaVersion: 1;
  id: string;
  rules: GameRules;
  armCount: number;
  trackLength: number;
  players: PlayerState[];
  turn: TurnState;
  status: GameStatus;
  /** Sequence number of the last emitted event. */
  seq: number;
  /** Player ids in final ranking order (filled as players finish). */
  rankings: string[];
  /** Player ids in the order they forfeited. */
  forfeits: string[];
  createdAt: number;
  updatedAt: number;
}

export interface NewPlayerInput {
  id: string;
  name: string;
  avatar: string;
  kind: PlayerKind;
  botLevel?: AiDifficulty | null;
}
