import { describe, expect, it } from 'vitest';
import { applyAction, createGame, createSequenceDice } from '@ludo/game-engine';
import { recommendTier } from '../src/services/device';
import { describeMoves } from '../src/game/moves';
import { computeGameLayout } from '../src/hooks/useMedia';

const base = {
  webgl: true,
  webgl2: true,
  maxTextureSize: 16384,
  softwareRenderer: false,
  cores: 8,
  memoryGb: 8 as number | null,
  coarsePointer: false,
  screenPixels: 2560 * 1440,
  dpr: 1,
  saveData: false,
};

describe('graphics tier detection', () => {
  it('picks ULTRA/HIGH for capable desktops and LOW without hardware WebGL', () => {
    expect(recommendTier(base)).toBe('ultra');
    expect(recommendTier({ ...base, cores: 4 })).toBe('high');
    expect(recommendTier({ ...base, webgl: false })).toBe('low');
    expect(recommendTier({ ...base, softwareRenderer: true })).toBe('low');
  });

  it('scales phones by memory and cores', () => {
    const phone = { ...base, coarsePointer: true };
    expect(recommendTier({ ...phone, memoryGb: 8, cores: 8 })).toBe('high');
    expect(recommendTier({ ...phone, memoryGb: 4, cores: 8 })).toBe('medium');
    expect(recommendTier({ ...phone, memoryGb: 2, cores: 8 })).toBe('low');
    expect(recommendTier({ ...phone, memoryGb: null, cores: 4 })).toBe('low');
    expect(recommendTier({ ...phone, webgl2: false })).toBe('low');
  });

  it('respects data-saver', () => {
    expect(recommendTier({ ...base, saveData: true })).toBe('medium');
  });
});

describe('game layout selection', () => {
  it('chooses portrait, landscape and desktop compositions', () => {
    for (const [w, h] of [[320, 568], [360, 800], [375, 812], [390, 844], [414, 896], [430, 932], [768, 1024]]) {
      expect(computeGameLayout(w!, h!)).toBe('portrait');
    }
    expect(computeGameLayout(844, 390)).toBe('landscape');
    expect(computeGameLayout(1024, 600)).toBe('landscape');
    expect(computeGameLayout(1366, 1024)).toBe('desktop');
    expect(computeGameLayout(1440, 900)).toBe('desktop');
  });
});

describe('on-screen move choices', () => {
  const players = [0, 1].map((i) => ({ id: `p${i}`, name: `P${i}`, avatar: 'comet', kind: 'human' as const }));

  it('collapses equivalent moves so overlapping tokens are never ambiguous', () => {
    let s = createGame({ id: 'g', players, rules: { autoMoveSingleOption: false }, now: 0 });
    // Two tokens stacked on the same square + two in base, roll a six.
    s.players[0]!.tokens = [5, 5, -1, -1];
    const r = applyAction(s, { type: 'ROLL', playerId: 'p0' }, { now: 0, dice: createSequenceDice([6]) });
    if (!r.ok) throw new Error(r.error.code);
    s = r.state;
    expect(s.turn.legalMoves).toHaveLength(4);
    const choices = describeMoves(s, 'p0');
    expect(choices).toHaveLength(2);
    expect(choices.map((c) => c.action).sort()).toEqual(['Move 6', 'Release']);
    expect(choices.find((c) => c.action === 'Release')!.token).toBe('From base');
  });

  it('labels captures and finishing moves', () => {
    let s = createGame({ id: 'g', players, now: 0 });
    // p0 at progress 10 (square 18) can capture p1 at square 20 (p1 progress 38); token 1 can finish.
    s.players[0]!.tokens = [10, 54, -1, -1];
    s.players[1]!.tokens = [38, -1, -1, -1];
    const r = applyAction(s, { type: 'ROLL', playerId: 'p0' }, { now: 0, dice: createSequenceDice([2]) });
    if (!r.ok) throw new Error(r.error.code);
    s = r.state;
    const actions = describeMoves(s, 'p0').map((c) => c.action);
    expect(actions).toContain('Capture!');
    expect(actions).toContain('Bring home');
  });

  it('returns nothing when it is not my move phase', () => {
    const s = createGame({ id: 'g', players, now: 0 });
    expect(describeMoves(s, 'p0')).toEqual([]);
    expect(describeMoves(s, 'p1')).toEqual([]);
  });
});
