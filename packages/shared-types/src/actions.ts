import type { ForfeitReason } from './game';

export type GameAction =
  | { type: 'ROLL'; playerId: string }
  | { type: 'MOVE'; playerId: string; tokenIndex: number }
  /** Server-only: the current phase deadline expired. */
  | { type: 'TIMEOUT' }
  /** Server-only: a player leaves / is removed. */
  | { type: 'FORFEIT'; playerId: string; reason: ForfeitReason };
