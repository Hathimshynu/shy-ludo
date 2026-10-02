import type { GameRules, GameState, PlayerState } from '@ludo/shared-types';

export function deadlineFor(rules: GameRules, now: number): number | null {
  return rules.turnTimeSeconds > 0 ? now + rules.turnTimeSeconds * 1000 : null;
}

export function activePlayers(state: GameState): PlayerState[] {
  return state.players.filter((p) => p.status === 'active');
}

/** Next active player after `playerId` in seat order, or null if nobody else can play. */
export function nextActivePlayer(state: GameState, playerId: string): PlayerState | null {
  const ordered = [...state.players].sort((a, b) => a.seat - b.seat);
  const startIdx = ordered.findIndex((p) => p.id === playerId);
  for (let step = 1; step <= ordered.length; step += 1) {
    const candidate = ordered[(startIdx + step) % ordered.length]!;
    if (candidate.status === 'active' && candidate.id !== playerId) return candidate;
  }
  return null;
}

export function currentPlayer(state: GameState): PlayerState {
  const player = state.players.find((p) => p.id === state.turn.playerId);
  if (!player) throw new Error('Turn points at an unknown player');
  return player;
}
