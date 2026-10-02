import { create } from 'zustand';
import type { GameState } from '@ludo/shared-types';

export type GameMode = 'online' | 'solo';

export interface Banner {
  id: number;
  text: string;
  sub?: string;
  color: string;
}

export interface EmoteBubble {
  id: number;
  playerId: string;
  emote: string;
}

interface GameStoreState {
  mode: GameMode | null;
  gameId: string | null;
  myId: string | null;
  /** Latest authoritative state (may run ahead of what the board shows). */
  state: GameState | null;
  /** State matching what the board currently shows (lags while animating). */
  visual: GameState | null;
  connected: Record<string, boolean>;
  paused: boolean;
  pending: boolean;
  animating: boolean;
  rankings: string[] | null;
  banner: Banner | null;
  emotes: EmoteBubble[];
  gone: boolean;
  reset: () => void;
}

const empty = {
  mode: null,
  gameId: null,
  myId: null,
  state: null,
  visual: null,
  connected: {},
  paused: false,
  pending: false,
  animating: false,
  rankings: null,
  banner: null,
  emotes: [],
  gone: false,
} satisfies Omit<GameStoreState, 'reset'>;

export const useGame = create<GameStoreState>((set) => ({
  ...empty,
  reset: () => set({ ...empty }),
}));

/** Can the local player act right now? (Board caught up, my turn, connected, not paused.) */
export function selectCanAct(s: GameStoreState): boolean {
  const v = s.visual;
  return (
    !!v &&
    !!s.state &&
    !s.pending &&
    !s.animating &&
    !s.paused &&
    v.seq === s.state.seq &&
    v.status === 'playing' &&
    v.turn.playerId === s.myId
  );
}
