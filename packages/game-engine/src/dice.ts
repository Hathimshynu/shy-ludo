/**
 * Dice engine. The random source is injected so tests are deterministic and the
 * server can supply a cryptographically secure generator.
 */
export interface DiceEngine {
  /** Returns an integer 1–6. */
  roll(): number;
}

export interface DiceEngineOptions {
  /** Uniform random number in [0, 1). */
  random: () => number;
}

export const DICE_FACES = 6;

export function isValidDiceValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= DICE_FACES;
}

export function createDiceEngine({ random }: DiceEngineOptions): DiceEngine {
  return {
    roll() {
      const r = random();
      if (!(r >= 0 && r < 1)) throw new Error(`Random source returned ${r}, expected [0, 1)`);
      return Math.floor(r * DICE_FACES) + 1;
    },
  };
}

/** Dice that return a fixed sequence (tests, replays). Throws when exhausted. */
export function createSequenceDice(values: readonly number[]): DiceEngine & { remaining(): number } {
  let index = 0;
  return {
    roll() {
      const value = values[index];
      if (value === undefined) throw new Error('Sequence dice exhausted');
      if (!isValidDiceValue(value)) throw new Error(`Invalid dice value in sequence: ${value}`);
      index += 1;
      return value;
    },
    remaining() {
      return values.length - index;
    },
  };
}

/** Small, fast, seedable PRNG (mulberry32). Not for production dice. */
export function seededRandom(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
