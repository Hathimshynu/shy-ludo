import { describe, expect, it } from 'vitest';
import { AI_DIFFICULTIES } from '@ludo/shared-types';
import { chooseMove, rankMoves } from '../src';
import { must, newGame, withTokens } from './helpers';

describe('AI move selection', () => {
  it('captures when it can', () => {
    // p0 token 0 at progress 10 can capture p1 at square 20 with a 2; token 1 could advance.
    const s = withTokens(newGame(2), { p0: [10, 30, -1, -1], p1: [38, -1, -1, -1] });
    const rolled = must(s, { type: 'ROLL', playerId: 'p0' }, [2]).state;
    for (const level of ['medium', 'hard', 'expert'] as const) {
      expect(chooseMove(rolled, 'p0', level)!.tokenIndex).toBe(0);
    }
  });

  it('releases a token on a six when there is nothing to capture', () => {
    const s = withTokens(newGame(2), { p0: [30, -1, -1, -1] });
    const rolled = must(s, { type: 'ROLL', playerId: 'p0' }, [6]).state;
    const move = chooseMove(rolled, 'p0', 'medium')!;
    expect(move.kind).toBe('release');
  });

  it('finishes a token when possible', () => {
    const s = withTokens(newGame(2), { p0: [53, 20, -1, -1] });
    const rolled = must(s, { type: 'ROLL', playerId: 'p0' }, [3]).state;
    expect(chooseMove(rolled, 'p0', 'medium')!.kind).toBe('finish');
  });

  it('(hard) escapes a threatened token instead of exposing a safe one', () => {
    // p0 token 0 at square 18 (progress 10) is 2 squares ahead of p1 at square 16 (star, progress 34).
    // p0 token 1 sits on its own start square (safe). Rolling 5 carries token 0 out of reach.
    const s = withTokens(newGame(2), { p0: [10, 0, -1, -1], p1: [34, -1, -1, -1] });
    const rolled = must(s, { type: 'ROLL', playerId: 'p0' }, [5]).state;
    const ranked = rankMoves(rolled, 'p0', 5, 'hard');
    expect(ranked[0]!.move.tokenIndex).toBe(0);
    expect(chooseMove(rolled, 'p0', 'hard')!.tokenIndex).toBe(0);
  });

  it('(hard) prefers a safe landing square over a dangerous one', () => {
    // Token 0: progress 5 → 8 (star, safe). Token 1: progress 20 → 23, square 31, right in front of p1.
    const s = withTokens(newGame(2), { p0: [5, 20, -1, -1], p1: [43, -1, -1, -1] });
    const rolled = must(s, { type: 'ROLL', playerId: 'p0' }, [3]).state;
    expect(chooseMove(rolled, 'p0', 'hard')!.tokenIndex).toBe(0);
  });

  it('always returns one of the legal moves at every difficulty', () => {
    const s = withTokens(newGame(4), { p0: [5, 20, 44, -1], p1: [3, 12, -1, -1], p2: [30, -1, -1, -1] });
    for (const dice of [1, 2, 3, 4, 5, 6]) {
      const rolled = must(s, { type: 'ROLL', playerId: 'p0' }, [dice]).state;
      if (rolled.turn.phase !== 'move') continue;
      for (const level of AI_DIFFICULTIES) {
        const move = chooseMove(rolled, 'p0', level, () => 0.3)!;
        expect(rolled.turn.legalMoves).toContainEqual(move);
      }
    }
  });

  it('returns null when it is not the player’s move phase', () => {
    const s = newGame(2);
    expect(chooseMove(s, 'p0', 'expert')).toBeNull();
    expect(chooseMove(s, 'p1', 'expert')).toBeNull();
  });
});
