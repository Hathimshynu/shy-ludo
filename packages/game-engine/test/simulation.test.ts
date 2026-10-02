import { describe, expect, it } from 'vitest';
import type { AiDifficulty, GameAction, GameState } from '@ludo/shared-types';
import {
  applyAction,
  applyEvents,
  chooseMove,
  createDiceEngine,
  createGame,
  finishProgress,
  boardOf,
  seededRandom,
} from '../src';
import { makePlayers, NOW } from './helpers';

interface SimOptions {
  players: number;
  seed: number;
  tokens?: number;
  levels?: AiDifficulty[];
  timeoutRate?: number;
  forfeitRate?: number;
  checkProjection?: boolean;
  continueAfterWinner?: boolean;
}

function simulate(opts: SimOptions): { state: GameState; actions: number } {
  const random = seededRandom(opts.seed);
  const dice = createDiceEngine({ random: seededRandom(opts.seed * 7919 + 1) });
  let state = createGame({
    id: `sim-${opts.seed}`,
    players: makePlayers(opts.players),
    rules: {
      tokensPerPlayer: opts.tokens ?? 4,
      maxConsecutiveTimeouts: 0,
      continueAfterWinner: opts.continueAfterWinner ?? true,
    },
    now: NOW,
  });
  let projected = state;
  const finish = finishProgress(boardOf(state));
  let actions = 0;
  let now = NOW;

  while (state.status === 'playing') {
    actions += 1;
    now += 1000;
    if (actions > 200_000) throw new Error('Game did not terminate');
    const pid = state.turn.playerId;
    const seat = state.players.find((p) => p.id === pid)!.seat;
    const level = opts.levels?.[seat] ?? 'medium';
    let action: GameAction;
    const r = random();
    if (opts.forfeitRate && r < opts.forfeitRate) {
      action = { type: 'FORFEIT', playerId: pid, reason: 'left' };
    } else if (opts.timeoutRate && r < (opts.forfeitRate ?? 0) + opts.timeoutRate) {
      action = { type: 'TIMEOUT' };
    } else if (state.turn.phase === 'roll') {
      action = { type: 'ROLL', playerId: pid };
    } else {
      const move = chooseMove(state, pid, level, random)!;
      action = { type: 'MOVE', playerId: pid, tokenIndex: move.tokenIndex };
    }

    const result = applyAction(state, action, { now, dice });
    if (!result.ok) throw new Error(`Unexpected rejection ${result.error.code} for ${action.type}`);
    if (result.events.length === 0) throw new Error('Action produced no events');
    // Gap-free sequence numbers.
    result.events.forEach((e, i) => {
      if (e.seq !== state.seq + i + 1) throw new Error('Sequence gap');
    });
    state = result.state;

    // Invariants.
    for (const p of state.players) {
      for (const t of p.tokens) {
        if (t < -1 || t > finish) throw new Error('Token out of range: ' + t);
      }
    }
    if (state.status === 'playing') {
      const current = state.players.find((p) => p.id === state.turn.playerId)!;
      if (current.status !== 'active') throw new Error('Turn belongs to an inactive player');
      if (state.turn.phase === 'move' && state.turn.legalMoves.length === 0) {
        throw new Error('Move phase without legal moves');
      }
    }

    if (opts.checkProjection) {
      projected = applyEvents(projected, result.events);
      expect(projected).toEqual(state);
    }
  }
  return { state, actions };
}

describe('full game simulations', () => {
  for (let players = 2; players <= 8; players += 1) {
    it(`plays a complete ${players}-player game to a valid final ranking`, () => {
      const { state } = simulate({ players, seed: players * 101, checkProjection: players <= 4 });
      expect(state.status).toBe('finished');
      expect(state.rankings).toHaveLength(players);
      expect(new Set(state.rankings).size).toBe(players);
      expect(state.players.map((p) => p.rank).sort((a, b) => a! - b!)).toEqual(
        Array.from({ length: players }, (_, i) => i + 1),
      );
      // Everyone except the last-placed player brought every token home.
      const finish = finishProgress(boardOf(state));
      const last = state.rankings[players - 1]!;
      for (const p of state.players) {
        if (p.id !== last) expect(p.tokens.every((t) => t === finish)).toBe(true);
      }
    });
  }

  it('keeps the event projection identical to the engine under timeouts and forfeits', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { state } = simulate({
        players: 2 + (seed % 5),
        seed,
        tokens: 2,
        timeoutRate: 0.08,
        forfeitRate: 0.002,
        checkProjection: true,
      });
      expect(state.status).toBe('finished');
    }
  });

  it('is fully deterministic for a given seed', () => {
    const a = simulate({ players: 4, seed: 99, tokens: 2 });
    const b = simulate({ players: 4, seed: 99, tokens: 2 });
    expect(a.state).toEqual(b.state);
    expect(a.actions).toBe(b.actions);
  });

  it('ends 8-player games at the first winner when configured', () => {
    const { state } = simulate({ players: 8, seed: 7, tokens: 2, continueAfterWinner: false });
    expect(state.status).toBe('finished');
    expect(state.players.filter((p) => p.status === 'finished')).toHaveLength(1);
    expect(state.rankings).toHaveLength(8);
  });
});

describe('AI strength', () => {
  it('Expert beats Easy far more often than not', () => {
    let expertWins = 0;
    const games = 60;
    for (let seed = 1; seed <= games; seed += 1) {
      // Alternate seats to remove first-move advantage.
      const expertSeat = seed % 2;
      const levels: AiDifficulty[] = expertSeat === 0 ? ['expert', 'easy'] : ['easy', 'expert'];
      const { state } = simulate({ players: 2, seed: 1000 + seed, levels, tokens: 4 });
      if (state.rankings[0] === `p${expertSeat}`) expertWins += 1;
    }
    expect(expertWins / games).toBeGreaterThan(0.6);
  });
});
