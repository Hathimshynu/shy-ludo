import { describe, expect, it } from 'vitest';
import {
  armCountForPlayers,
  baseSlotWorld,
  boardCells,
  coordToGrid,
  coordToWorld,
  createBoard,
  finishProgress,
  homeLaneStart,
  isSafeSquare,
  lastTrackProgress,
  progressToCoord,
  progressToSquare,
  progressToWorld,
  seatArms,
  trackSquareCoord,
  type ArmCount,
} from '../src';

const ARM_COUNTS: ArmCount[] = [4, 6, 8];

describe('board geometry', () => {
  it('selects the arm count from the player count', () => {
    expect([2, 3, 4].map(armCountForPlayers)).toEqual([4, 4, 4]);
    expect([5, 6].map(armCountForPlayers)).toEqual([6, 6]);
    expect([7, 8].map(armCountForPlayers)).toEqual([8, 8]);
  });

  it('has 13 track squares per arm', () => {
    expect(createBoard(4).trackLength).toBe(52);
    expect(createBoard(6).trackLength).toBe(78);
    expect(createBoard(8).trackLength).toBe(104);
  });

  it('uses the classic 57-position journey on the 4-arm board', () => {
    const board = createBoard(4);
    expect(lastTrackProgress(board)).toBe(50);
    expect(homeLaneStart(board)).toBe(51);
    expect(finishProgress(board)).toBe(56);
  });

  it('marks start and star squares as safe (2 per arm)', () => {
    for (const n of ARM_COUNTS) {
      const board = createBoard(n);
      expect(board.safeSquares.size).toBe(n * 2);
      for (let arm = 0; arm < n; arm += 1) {
        expect(isSafeSquare(board, progressToSquare(board, arm, 0)!)).toBe(true);
        // Star square is 8 squares after the start square.
        expect(isSafeSquare(board, progressToSquare(board, arm, 8)!)).toBe(true);
      }
    }
  });

  it('maps the 4-arm board onto the classic 15×15 grid', () => {
    const board = createBoard(4);
    const seen = new Set<string>();
    for (let sq = 0; sq < 52; sq += 1) {
      const { row, col } = coordToGrid(board, trackSquareCoord(board, sq));
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(15);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(15);
      // Track squares lie on the cross (rows or columns 6..8).
      expect((row >= 6 && row <= 8) || (col >= 6 && col <= 8)).toBe(true);
      seen.add(`${row},${col}`);
    }
    expect(seen.size).toBe(52);
    // Arm 0 (bottom) start square: lane 2 / depth 4 → row 13, col 6.
    expect(coordToGrid(board, progressToCoord(board, 0, 0))).toEqual({ row: 13, col: 6 });
    // Arm 0 home column ends next to the centre.
    expect(coordToGrid(board, progressToCoord(board, 0, 55))).toEqual({ row: 9, col: 7 });
    expect(coordToGrid(board, progressToCoord(board, 0, 51))).toEqual({ row: 13, col: 7 });
  });

  it('makes consecutive track squares adjacent (incl. diagonal corner steps)', () => {
    const board = createBoard(4);
    for (let sq = 0; sq < 52; sq += 1) {
      const a = coordToGrid(board, trackSquareCoord(board, sq));
      const b = coordToGrid(board, trackSquareCoord(board, sq + 1));
      expect(Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col))).toBe(1);
    }
  });

  it('keeps consecutive squares close on 6- and 8-arm boards', () => {
    for (const n of [6, 8] as const) {
      const board = createBoard(n);
      for (let sq = 0; sq < board.trackLength; sq += 1) {
        const a = coordToWorld(board, trackSquareCoord(board, sq));
        const b = coordToWorld(board, trackSquareCoord(board, sq + 1));
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        expect(d).toBeGreaterThan(0.99);
        expect(d).toBeLessThan(1.8);
      }
    }
  });

  it('never overlaps cells, base slots or home spots', () => {
    for (const n of ARM_COUNTS) {
      const board = createBoard(n);
      const cells = boardCells(board).map((c) => c.world);
      for (let i = 0; i < cells.length; i += 1) {
        for (let j = i + 1; j < cells.length; j += 1) {
          const d = Math.hypot(cells[i]!.x - cells[j]!.x, cells[i]!.z - cells[j]!.z);
          expect(d).toBeGreaterThan(0.99);
        }
      }
      for (let arm = 0; arm < n; arm += 1) {
        for (let slot = 0; slot < 4; slot += 1) {
          const s = baseSlotWorld(board, arm, slot);
          for (const c of cells) {
            // Token radius ~0.35 + half a cell diagonal must stay clear of track cells.
            expect(Math.hypot(s.x - c.x, s.z - c.z)).toBeGreaterThan(0.9);
          }
        }
      }
    }
  });

  it('maps every progress value of a journey to a coordinate', () => {
    for (const n of ARM_COUNTS) {
      const board = createBoard(n);
      for (let arm = 0; arm < n; arm += 1) {
        expect(progressToCoord(board, arm, -1, 2)).toEqual({ kind: 'base', arm, slot: 2 });
        expect(progressToCoord(board, arm, lastTrackProgress(board))).toMatchObject({
          kind: 'track',
          arm,
          lane: 1,
          depth: 5,
        });
        expect(progressToCoord(board, arm, homeLaneStart(board))).toEqual({ kind: 'lane', arm, depth: 4 });
        expect(progressToCoord(board, arm, finishProgress(board))).toEqual({ kind: 'home', arm });
        for (let p = -1; p <= finishProgress(board); p += 1) {
          const w = progressToWorld(board, arm, p, 0);
          expect(Number.isFinite(w.x) && Number.isFinite(w.z)).toBe(true);
        }
      }
    }
  });

  it('seats two players opposite each other', () => {
    expect(seatArms(2, 4)).toEqual([0, 2]);
    expect(seatArms(4, 4)).toEqual([0, 1, 2, 3]);
    expect(seatArms(8, 8)).toHaveLength(8);
    expect(() => seatArms(5, 4)).toThrow();
  });
});
