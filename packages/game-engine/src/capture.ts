import type { GameState, TokenRef } from '@ludo/shared-types';
import { type ArmCount, type BoardGeometry, createBoard, isSafeSquare, progressToSquare } from './board';

export function boardOf(state: Pick<GameState, 'armCount'>): BoardGeometry {
  return createBoard(state.armCount as ArmCount);
}

/** All tokens (of any player still on the board) standing on an absolute track square. */
export function tokensOnSquare(state: GameState, square: number): TokenRef[] {
  const board = boardOf(state);
  const refs: TokenRef[] = [];
  for (const player of state.players) {
    if (player.status === 'forfeited') continue;
    player.tokens.forEach((progress, tokenIndex) => {
      if (progressToSquare(board, player.arm, progress) === square) {
        refs.push({ playerId: player.id, tokenIndex });
      }
    });
  }
  return refs;
}

/**
 * Opponent tokens that would be captured by `playerId` landing on `square`.
 * Safe squares never capture. Every opponent token on the square is captured.
 */
export function capturesAt(state: GameState, playerId: string, square: number): TokenRef[] {
  const board = boardOf(state);
  if (isSafeSquare(board, square)) return [];
  return tokensOnSquare(state, square).filter((ref) => ref.playerId !== playerId);
}

/**
 * True when an opponent of `playerId` has a blockade (2+ tokens) on `square`.
 * Blockades only exist on non-safe track squares and only when the rule is enabled.
 */
export function isBlockedFor(state: GameState, playerId: string, square: number): boolean {
  if (!state.rules.allowBlockades) return false;
  const board = boardOf(state);
  if (isSafeSquare(board, square)) return false;
  const counts = new Map<string, number>();
  for (const ref of tokensOnSquare(state, square)) {
    if (ref.playerId === playerId) continue;
    const next = (counts.get(ref.playerId) ?? 0) + 1;
    if (next >= 2) return true;
    counts.set(ref.playerId, next);
  }
  return false;
}
