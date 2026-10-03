/**
 * Event-driven animation curves shared by the 3D layer. Pure functions of time so they
 * can be unit-tested and never touch game state: the engine decides *that* a token
 * reached home; these only decide how that looks.
 */

/** Home-entry celebration length (ms). */
export const HOME_ENTRY_MS = 1200;
export const HOME_ENTRY_REDUCED_MS = 420;
/** Winner tokens hop for this long after the game ends, then rest. */
export const WINNER_HOP_MS = 4500;
/** Period of the calm "you can move this token" breathing cue (ms). */
export const SELECTABLE_PERIOD_MS = 1600;

const easeOut = (u: number) => 1 - (1 - u) ** 3;
const easeIn = (u: number) => u * u * u;
const clamp01 = (u: number) => Math.min(1, Math.max(0, u));

export interface HomePose {
  /** Height above the rest position (world units). */
  lift: number;
  /** Rotation about the vertical axis (radians). */
  spin: number;
  /** Small forward/back tilt (radians). */
  tilt: number;
  /** Uniform scale multiplier. */
  scale: number;
  /** Aura/ring strength 0..1 (used by the board effect). */
  glow: number;
  done: boolean;
}

export const HOME_REST: HomePose = { lift: 0, spin: 0, tilt: 0, scale: 1, glow: 0, done: true };

/**
 * Home entry: brief pause → rise with a soft aura → slow turn → settle into place.
 *
 *   0.00–0.10 pause · 0.10–0.45 rise · 0.45–0.70 hover & turn · 0.70–1.00 settle
 */
export function homeEntryPose(ageMs: number, reduce = false): HomePose {
  const dur = reduce ? HOME_ENTRY_REDUCED_MS : HOME_ENTRY_MS;
  if (!(ageMs >= 0) || ageMs >= dur) return HOME_REST;
  const u = ageMs / dur;
  if (reduce) {
    // Essential feedback only: a small lift and glow, no turn or tilt.
    const k = Math.sin(Math.PI * u);
    return { lift: k * 0.12, spin: 0, tilt: 0, scale: 1 + k * 0.05, glow: k, done: false };
  }
  const MAX_LIFT = 0.42;
  let lift: number;
  if (u < 0.1) lift = 0;
  else if (u < 0.45) lift = easeOut((u - 0.1) / 0.35) * MAX_LIFT;
  else if (u < 0.7) lift = MAX_LIFT + Math.sin(((u - 0.45) / 0.25) * Math.PI) * 0.03;
  else lift = (1 - easeIn((u - 0.7) / 0.3)) * MAX_LIFT;
  const turn = clamp01((u - 0.1) / 0.75);
  const spin = (1 - (1 - turn) ** 2) * Math.PI * 2;
  const tilt = Math.sin(turn * Math.PI) * 0.1;
  const scale = 1 + Math.sin(clamp01((u - 0.1) / 0.9) * Math.PI) * 0.1;
  const glow = u < 0.1 ? u / 0.1 : 1 - clamp01((u - 0.55) / 0.45);
  return { lift, spin, tilt, scale, glow: clamp01(glow), done: false };
}

/** 0..1 breathing value for legal-move tokens: slow, smooth, never a flash. */
export function selectableBreath(nowMs: number): number {
  return 0.5 - 0.5 * Math.cos((nowMs / SELECTABLE_PERIOD_MS) * Math.PI * 2);
}
