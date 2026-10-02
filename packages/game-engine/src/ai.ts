import type { AiDifficulty, GameState, LegalMove, PlayerState } from '@ludo/shared-types';
import { finishProgress, isSafeSquare, lastTrackProgress, progressToSquare } from './board';
import { boardOf } from './capture';
import { computeLegalMoves, findPlayer } from './movement';
import { canRelease } from './rules';

/**
 * Heuristic Ludo AI. Pure and fast (a handful of legal moves, each scored in O(tokens)),
 * so it is safe to run on the server event loop and inside a browser Web Worker.
 *
 * Considered, in priority order: captures → releases → escaping danger →
 * advancing toward home → strategic squares (safe squares, stacks, hunting) →
 * avoiding exposure → best remaining move.
 */

interface Weights {
  capture: number;
  captureProgress: number;
  release: number;
  finish: number;
  enterLane: number;
  advance: number;
  leader: number;
  safe: number;
  danger: number;
  escape: number;
  threatDepth: 0 | 1 | 2;
  stack: number;
  hunt: number;
  randomness: number;
}

const WEIGHTS: Record<AiDifficulty, Weights> = {
  easy: {
    capture: 60, captureProgress: 0, release: 40, finish: 50, enterLane: 10, advance: 1, leader: 0,
    safe: 0, danger: 0, escape: 0, threatDepth: 0, stack: 0, hunt: 0, randomness: 0.4,
  },
  medium: {
    capture: 100, captureProgress: 0.5, release: 60, finish: 80, enterLane: 30, advance: 1, leader: 4,
    safe: 15, danger: 0, escape: 0, threatDepth: 0, stack: 0, hunt: 0, randomness: 0,
  },
  hard: {
    capture: 110, captureProgress: 0.8, release: 65, finish: 85, enterLane: 35, advance: 1, leader: 6,
    safe: 20, danger: 1.2, escape: 1.0, threatDepth: 1, stack: 4, hunt: 0, randomness: 0,
  },
  expert: {
    capture: 120, captureProgress: 1, release: 70, finish: 90, enterLane: 40, advance: 1.2, leader: 8,
    safe: 22, danger: 1.5, escape: 1.3, threatDepth: 2, stack: 10, hunt: 4, randomness: 0,
  },
};

type TokenTable = Map<string, number[]>;

function tokenTable(state: GameState): TokenTable {
  const table: TokenTable = new Map();
  for (const p of state.players) table.set(p.id, p.status === 'forfeited' ? [] : p.tokens.slice());
  return table;
}

function applyToTable(table: TokenTable, playerId: string, move: LegalMove): TokenTable {
  const next: TokenTable = new Map();
  table.forEach((tokens, id) => next.set(id, tokens.slice()));
  next.get(playerId)![move.tokenIndex] = move.to;
  for (const victim of move.captures) next.get(victim.playerId)![victim.tokenIndex] = -1;
  return next;
}

/** Probability that an opponent hits `square` on their next turn(s). */
export function threatAt(
  state: GameState,
  table: TokenTable,
  playerId: string,
  square: number,
  depth: 1 | 2,
): number {
  const board = boardOf(state);
  if (isSafeSquare(board, square)) return 0;
  const L = board.trackLength;
  const lastTrack = lastTrackProgress(board);
  let notHit = 1;
  for (const opp of state.players) {
    if (opp.id === playerId || opp.status !== 'active') continue;
    const tokens = table.get(opp.id) ?? [];
    let hasBase = false;
    for (const progress of tokens) {
      if (progress < 0) {
        hasBase = true;
        continue;
      }
      const from = progressToSquare(board, opp.arm, progress);
      if (from === null) continue;
      const d = (square - from + L) % L;
      if (d === 0 || progress + d > lastTrack) continue;
      let p = 0;
      if (d <= 6) p = 1 / 6;
      else if (depth === 2 && d <= 12) p = 1 / 36;
      if (p > 0) notHit *= 1 - p;
    }
    if (depth === 2 && hasBase && canRelease(state.rules, 6)) {
      const start = progressToSquare(board, opp.arm, 0)!;
      const d = (square - start + L) % L;
      if (d >= 1 && d <= 6) notHit *= 1 - 1 / 36;
    }
  }
  return 1 - notHit;
}

export function scoreMove(
  state: GameState,
  player: PlayerState,
  move: LegalMove,
  difficulty: AiDifficulty,
): number {
  const w = WEIGHTS[difficulty];
  const board = boardOf(state);
  const finish = finishProgress(board);
  let score = 0;

  // 1. Captures (more valuable the further the victim had travelled).
  for (const victim of move.captures) {
    const victimProgress = findPlayer(state, victim.playerId)?.tokens[victim.tokenIndex] ?? 0;
    score += w.capture + Math.max(0, victimProgress) * w.captureProgress;
  }
  // 2. Getting tokens out of base.
  if (move.kind === 'release') score += w.release;
  // 4. Advancing toward home.
  if (move.kind === 'finish') score += w.finish;
  if (move.kind === 'enter-lane') score += w.enterLane;
  score += (move.to - Math.max(move.from, 0)) * w.advance;
  score += (Math.max(move.from, 0) / finish) * w.leader;

  const landing = progressToSquare(board, player.arm, move.to);
  // 5. Strategic squares.
  if (landing !== null && isSafeSquare(board, landing)) score += w.safe;

  if (w.threatDepth > 0) {
    const before = tokenTable(state);
    const after = applyToTable(before, player.id, move);
    const depth = w.threatDepth === 2 ? 2 : 1;
    // 6. Avoid exposure at the destination.
    if (landing !== null) {
      score -= threatAt(state, after, player.id, landing, depth) * (move.to + 8) * w.danger;
    }
    // 3. Escape danger at the origin.
    const origin = progressToSquare(board, player.arm, move.from);
    if (origin !== null) {
      const stillCovered = player.tokens.some(
        (t, i) => i !== move.tokenIndex && progressToSquare(board, player.arm, t) === origin,
      );
      if (!stillCovered) {
        score += threatAt(state, before, player.id, origin, depth) * (move.from + 8) * w.escape;
      }
    }
    if (landing !== null && !isSafeSquare(board, landing) && w.stack > 0) {
      const stacked = player.tokens.some(
        (t, i) => i !== move.tokenIndex && progressToSquare(board, player.arm, t) === landing,
      );
      if (stacked) score += w.stack * (state.rules.allowBlockades ? 2 : 1);
    }
    if (w.hunt > 0 && landing !== null) {
      score += huntingTargets(state, after, player.id, landing) * w.hunt;
    }
  }
  return score;
}

/** Opponent tokens 1–6 squares ahead of `square` that we could hit next turn. */
function huntingTargets(state: GameState, table: TokenTable, playerId: string, square: number): number {
  const board = boardOf(state);
  const L = board.trackLength;
  const me = findPlayer(state, playerId)!;
  const myProgress = (square - progressToSquare(board, me.arm, 0)! + L) % L;
  let targets = 0;
  for (const opp of state.players) {
    if (opp.id === playerId || opp.status !== 'active') continue;
    for (const progress of table.get(opp.id) ?? []) {
      const sq = progressToSquare(board, opp.arm, progress);
      if (sq === null || isSafeSquare(board, sq)) continue;
      const d = (sq - square + L) % L;
      if (d >= 1 && d <= 6 && myProgress + d <= lastTrackProgress(board)) targets += 1;
    }
  }
  return targets;
}

/**
 * Choose a move for `playerId` in the current move phase. Returns null when
 * there is nothing to choose. Deterministic for every level except Easy.
 */
export function chooseMove(
  state: GameState,
  playerId: string,
  difficulty: AiDifficulty,
  random: () => number = Math.random,
): LegalMove | null {
  const player = findPlayer(state, playerId);
  if (!player) return null;
  const moves =
    state.turn.playerId === playerId && state.turn.phase === 'move' && state.turn.dice !== null
      ? state.turn.legalMoves
      : [];
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0]!;

  const w = WEIGHTS[difficulty];
  if (w.randomness > 0 && random() < w.randomness) {
    return moves[Math.floor(random() * moves.length)] ?? moves[0]!;
  }

  let best = moves[0]!;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const move of moves) {
    const score = scoreMove(state, player, move, difficulty);
    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }
  return best;
}

/** Convenience for analysis/tests: legal moves for an arbitrary dice value, ranked best-first. */
export function rankMoves(
  state: GameState,
  playerId: string,
  dice: number,
  difficulty: AiDifficulty,
): Array<{ move: LegalMove; score: number }> {
  const player = findPlayer(state, playerId);
  if (!player) return [];
  return computeLegalMoves(state, playerId, dice)
    .map((move) => ({ move, score: scoreMove(state, player, move, difficulty) }))
    .sort((a, b) => b.score - a.score);
}
