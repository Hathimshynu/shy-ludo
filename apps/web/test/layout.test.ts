import { describe, expect, it } from 'vitest';
import { createBoard, createGame, yardDirection } from '@ludo/game-engine';
import { boardRotationFor, computePlacements, tokenKey } from '../src/game/layout';

const game = (n: number) =>
  createGame({
    id: 'g',
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, avatar: 'comet', kind: 'human' as const })),
    now: 0,
  });

describe('token layout', () => {
  it('gives every token a distinct resting place, even when stacked', () => {
    for (const n of [2, 4, 6, 8]) {
      const s = game(n);
      // Put all tokens of every player on their start square: stacks of 4 (+ visitors).
      s.players.forEach((p) => (p.tokens = [0, 0, 0, 0]));
      const placements = computePlacements(s);
      const pts = [...placements.values()];
      expect(pts).toHaveLength(n * 4);
      for (let i = 0; i < pts.length; i += 1) {
        for (let j = i + 1; j < pts.length; j += 1) {
          expect(Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.z - pts[j]!.z)).toBeGreaterThan(0.15);
        }
      }
      expect(placements.get(tokenKey('p0', 0))!.scale).toBeLessThan(1);
    }
  });

  it('keeps single tokens centred at full size', () => {
    const s = game(4);
    s.players[0]!.tokens = [5, -1, -1, -1];
    const p = computePlacements(s).get(tokenKey('p0', 0))!;
    expect(p.scale).toBe(1);
  });

  it('rotates the board so my yard faces the bottom-left', () => {
    for (const arms of [4, 6, 8] as const) {
      const board = createBoard(arms);
      for (let arm = 0; arm < arms; arm += 1) {
        const r = boardRotationFor(arms, arm);
        const d = yardDirection(board, arm);
        // three.js Y-rotation: x' = x cos r + z sin r, z' = -x sin r + z cos r
        const x = d.x * Math.cos(r) + d.z * Math.sin(r);
        const z = -d.x * Math.sin(r) + d.z * Math.cos(r);
        expect(x).toBeCloseTo(-Math.SQRT1_2, 5);
        expect(z).toBeCloseTo(Math.SQRT1_2, 5);
      }
    }
  });
});
