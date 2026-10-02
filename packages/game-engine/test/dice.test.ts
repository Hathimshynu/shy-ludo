import { describe, expect, it } from 'vitest';
import { createDiceEngine, createSequenceDice, isValidDiceValue, seededRandom } from '../src';

describe('DiceEngine', () => {
  it('maps the injected random source onto 1–6', () => {
    const values = [0, 0.1667, 0.34, 0.5, 0.67, 0.84, 0.999999];
    let i = 0;
    const dice = createDiceEngine({ random: () => values[i++]! });
    expect(values.map(() => dice.roll())).toEqual([1, 2, 3, 4, 5, 6, 6]);
  });

  it('is uniform for a good random source', () => {
    const dice = createDiceEngine({ random: seededRandom(42) });
    const counts = [0, 0, 0, 0, 0, 0];
    const n = 60_000;
    for (let i = 0; i < n; i += 1) counts[dice.roll() - 1]! += 1;
    for (const c of counts) expect(Math.abs(c - n / 6)).toBeLessThan(n * 0.01);
  });

  it('rejects a broken random source', () => {
    expect(() => createDiceEngine({ random: () => 1 }).roll()).toThrow();
    expect(() => createDiceEngine({ random: () => -0.1 }).roll()).toThrow();
    expect(() => createDiceEngine({ random: () => Number.NaN }).roll()).toThrow();
  });

  it('supports deterministic sequences for tests and replays', () => {
    const dice = createSequenceDice([6, 1, 3]);
    expect([dice.roll(), dice.roll(), dice.roll()]).toEqual([6, 1, 3]);
    expect(() => dice.roll()).toThrow(/exhausted/);
    expect(() => createSequenceDice([7]).roll()).toThrow();
  });

  it('validates dice values', () => {
    expect([1, 2, 3, 4, 5, 6].every(isValidDiceValue)).toBe(true);
    expect([0, 7, 2.5, '3', null, Number.NaN].some(isValidDiceValue)).toBe(false);
  });
});
