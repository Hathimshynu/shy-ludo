import type { GameState, LegalMove, MoveKind, PlayerState } from '@ludo/shared-types';
import {
  BASE_PROGRESS,
  finishProgress,
  homeLaneStart,
  isOnTrack,
  lastTrackProgress,
  progressToSquare,
} from './board';
import { boardOf, capturesAt, isBlockedFor } from './capture';
import { canRelease } from './rules';

export function findPlayer(state: GameState, playerId: string): PlayerState | undefined {
  return state.players.find((p) => p.id === playerId);
}

export function tokenFinished(state: GameState, progress: number): boolean {
  return progress >= finishProgress(boardOf(state));
}

/**
 * Compute the move for one token with a given dice value, or null if illegal.
 * Pure: does not touch `state`.
 */
export function computeMove(
  state: GameState,
  player: PlayerState,
  tokenIndex: number,
  dice: number,
): LegalMove | null {
  const board = boardOf(state);
  const from = player.tokens[tokenIndex];
  if (from === undefined) return null;
  const finish = finishProgress(board);
  if (from >= finish) return null;

  if (from === BASE_PROGRESS) {
    if (!canRelease(state.rules, dice)) return null;
    const square = progressToSquare(board, player.arm, 0);
    if (square === null || isBlockedFor(state, player.id, square)) return null;
    return {
      tokenIndex,
      from,
      to: 0,
      path: [0],
      kind: 'release',
      captures: capturesAt(state, player.id, square),
    };
  }

  let to = from + dice;
  if (to > finish) {
    if (state.rules.exactHomeEntry) return null;
    to = finish;
  }

  const path: number[] = [];
  for (let p = from + 1; p <= to; p += 1) {
    path.push(p);
    const square = progressToSquare(board, player.arm, p);
    if (square !== null && isBlockedFor(state, player.id, square)) return null;
  }

  let kind: MoveKind = 'move';
  if (to >= finish) kind = 'finish';
  else if (from <= lastTrackProgress(board) && to >= homeLaneStart(board)) kind = 'enter-lane';

  const landing = progressToSquare(board, player.arm, to);
  const captures = landing !== null && isOnTrack(board, to) ? capturesAt(state, player.id, landing) : [];
  return { tokenIndex, from, to, path, kind, captures };
}

/** Every legal move for `playerId` with `dice`. */
export function computeLegalMoves(state: GameState, playerId: string, dice: number): LegalMove[] {
  const player = findPlayer(state, playerId);
  if (!player || player.status !== 'active') return [];
  const moves: LegalMove[] = [];
  for (let i = 0; i < player.tokens.length; i += 1) {
    const move = computeMove(state, player, i, dice);
    if (move) moves.push(move);
  }
  return moves;
}

/** True when every legal move produces the same board outcome (e.g. all tokens in base). */
export function movesAreEquivalent(moves: readonly LegalMove[]): boolean {
  if (moves.length === 0) return false;
  const first = moves[0]!;
  return moves.every((m) => m.from === first.from && m.to === first.to);
}

export function movableTokens(moves: readonly LegalMove[]): number[] {
  return moves.map((m) => m.tokenIndex);
}
