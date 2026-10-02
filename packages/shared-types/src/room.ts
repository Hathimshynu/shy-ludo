import type { AiDifficulty } from './game';
import type { GameRules } from './rules';

/** Rule toggles a host may change in a private room. */
export interface RuleVariants {
  requireSixToStart: boolean;
  extraTurnOnSix: boolean;
  extraTurnOnCapture: boolean;
  extraTurnOnHome: boolean;
  threeSixPenalty: boolean;
  exactHomeEntry: boolean;
  allowBlockades: boolean;
  continueAfterWinner: boolean;
}

export interface RoomSettings {
  maxPlayers: number;
  turnTimeSeconds: number;
  tokensPerPlayer: number;
  variants: RuleVariants;
}

export type RoomKind = 'private' | 'matchmaking';
export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface RoomSeat {
  /** User id for humans, generated id for bots. */
  id: string;
  kind: 'human' | 'bot';
  name: string;
  avatar: string;
  botLevel: AiDifficulty | null;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
}

export interface RoomView {
  id: string;
  code: string;
  kind: RoomKind;
  hostId: string;
  status: RoomStatus;
  settings: RoomSettings;
  seats: RoomSeat[];
  gameId: string | null;
  createdAt: number;
}

export function settingsToRules(settings: RoomSettings, base: GameRules): GameRules {
  return {
    ...base,
    ...settings.variants,
    maxPlayers: settings.maxPlayers,
    tokensPerPlayer: settings.tokensPerPlayer,
    turnTimeSeconds: settings.turnTimeSeconds,
  };
}
