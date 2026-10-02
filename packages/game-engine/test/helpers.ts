import type { GameAction, GameEvent, GameRules, GameState, NewPlayerInput } from '@ludo/shared-types';
import {
  type ApplyResult,
  applyAction,
  createGame,
  createSequenceDice,
  type DiceEngine,
  finishProgress,
  boardOf,
} from '../src';

export const NOW = 1_700_000_000_000;

export function makePlayers(count: number, kind: 'human' | 'bot' = 'human'): NewPlayerInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    name: `Player ${i}`,
    avatar: 'comet',
    kind,
    botLevel: kind === 'bot' ? 'medium' : null,
  }));
}

export function newGame(count = 2, rules: Partial<GameRules> = {}): GameState {
  return createGame({ id: 'g1', players: makePlayers(count), rules, now: NOW });
}

/** Directly place tokens (test setup only). */
export function withTokens(state: GameState, tokens: Record<string, number[]>): GameState {
  const next = structuredClone(state);
  for (const [id, values] of Object.entries(tokens)) {
    const p = next.players.find((x) => x.id === id);
    if (!p) throw new Error(`no player ${id}`);
    p.tokens = values.slice();
  }
  return next;
}

export function withTurn(state: GameState, playerId: string): GameState {
  const next = structuredClone(state);
  next.turn.playerId = playerId;
  return next;
}

export function finishOf(state: GameState): number {
  return finishProgress(boardOf(state));
}

export function act(
  state: GameState,
  action: GameAction,
  dice: DiceEngine | number[] = [],
  now = NOW,
): ApplyResult {
  const engine = Array.isArray(dice) ? createSequenceDice(dice) : dice;
  return applyAction(state, action, { now, dice: engine });
}

/** Apply and assert success. */
export function must(
  state: GameState,
  action: GameAction,
  dice: DiceEngine | number[] = [],
  now = NOW,
): { state: GameState; events: GameEvent[] } {
  const result = act(state, action, dice, now);
  if (!result.ok) throw new Error(`Expected success, got ${result.error.code}: ${result.error.message}`);
  return { state: result.state, events: result.events };
}

export function types(events: GameEvent[]): string[] {
  return events.map((e) => e.type);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
