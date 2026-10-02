import type { ForfeitReason, MoveKind, TokenRef } from './game';

export interface DiceRolledPayload {
  value: number;
  consecutiveSixes: number;
  /** Tokens that may move with this roll (empty if none). */
  movableTokens: number[];
  /** true when the server rolled because the player's timer expired. */
  auto: boolean;
}

export interface TokenMovedPayload {
  tokenIndex: number;
  from: number;
  to: number;
  path: number[];
  kind: MoveKind;
  auto: boolean;
}

export interface TokenCapturedPayload {
  by: TokenRef;
  victim: TokenRef;
  /** Victim progress before capture. */
  from: number;
  /** Absolute track square of the capture. */
  square: number;
}

export type ExtraTurnReason = 'six' | 'capture' | 'home';

export interface ExtraTurnPayload {
  reasons: ExtraTurnReason[];
  turnNumber: number;
  deadline: number | null;
}

export interface TurnPenaltyPayload {
  reason: 'three-sixes';
}

export interface TurnTimeoutPayload {
  consecutiveTimeouts: number;
}

export type TurnChangeReason = 'moved' | 'no-moves' | 'penalty' | 'forfeit' | 'finished';

export interface TurnChangedPayload {
  playerId: string;
  previousPlayerId: string;
  turnNumber: number;
  deadline: number | null;
  reason: TurnChangeReason;
}

export interface PlayerFinishedPayload {
  rank: number;
}

export interface PlayerForfeitedPayload {
  reason: ForfeitReason;
}

export interface GameFinishedPayload {
  rankings: string[];
  winnerId: string | null;
}

export interface GameEventPayloads {
  DICE_ROLLED: DiceRolledPayload;
  TOKEN_MOVED: TokenMovedPayload;
  TOKEN_CAPTURED: TokenCapturedPayload;
  EXTRA_TURN: ExtraTurnPayload;
  TURN_PENALTY: TurnPenaltyPayload;
  TURN_TIMEOUT: TurnTimeoutPayload;
  TURN_CHANGED: TurnChangedPayload;
  PLAYER_FINISHED: PlayerFinishedPayload;
  PLAYER_FORFEITED: PlayerForfeitedPayload;
  GAME_FINISHED: GameFinishedPayload;
}

export type GameEventType = keyof GameEventPayloads;

export const GAME_EVENT_TYPES: readonly GameEventType[] = [
  'DICE_ROLLED',
  'TOKEN_MOVED',
  'TOKEN_CAPTURED',
  'EXTRA_TURN',
  'TURN_PENALTY',
  'TURN_TIMEOUT',
  'TURN_CHANGED',
  'PLAYER_FINISHED',
  'PLAYER_FORFEITED',
  'GAME_FINISHED',
];

export interface GameEventOf<T extends GameEventType> {
  gameId: string;
  /** Per-game, strictly increasing, gap-free. */
  seq: number;
  type: T;
  /** Acting / affected player, null for game-level events. */
  playerId: string | null;
  at: number;
  payload: GameEventPayloads[T];
}

export type GameEvent = { [K in GameEventType]: GameEventOf<K> }[GameEventType];
