import type { GameState, LegalMove } from '@ludo/shared-types';
import { tokenKey } from './layout';

export interface MoveChoice {
  tokenIndex: number;
  key: string;
  /** What the move does: "Release", "Capture!", "Bring home", … */
  action: string;
  /** Which token: "Front token", "2nd token", "From base", … */
  token: string;
}

const ORDINALS = ['Front token', '2nd token', '3rd token', '4th token'];

/**
 * Turn the legal moves into a short, unambiguous list of on-screen choices.
 * Moves with identical outcomes (e.g. releasing any of several base tokens, or two
 * tokens stacked on the same square) collapse into one choice, so overlapping tokens
 * never make selection ambiguous.
 */
export function describeMoves(state: GameState, playerId: string): MoveChoice[] {
  const me = state.players.find((p) => p.id === playerId);
  if (!me || state.turn.playerId !== playerId || state.turn.phase !== 'move') return [];
  const moves: LegalMove[] = state.turn.legalMoves;

  // Rank tokens that are out on the board by how far they have travelled.
  const onBoard = me.tokens
    .map((progress, index) => ({ progress, index }))
    .filter((t) => t.progress >= 0)
    .sort((a, b) => b.progress - a.progress);
  const rank = new Map(onBoard.map((t, i) => [t.index, i]));

  const seen = new Set<string>();
  const choices: MoveChoice[] = [];
  for (const m of moves) {
    const outcome = `${m.from}->${m.to}`;
    if (seen.has(outcome)) continue;
    seen.add(outcome);
    let action: string;
    if (m.captures.length > 0) action = 'Capture!';
    else if (m.kind === 'release') action = 'Release';
    else if (m.kind === 'finish') action = 'Bring home';
    else if (m.kind === 'enter-lane') action = 'Into home lane';
    else action = `Move ${m.to - m.from}`;
    const token = m.kind === 'release' ? 'From base' : (ORDINALS[rank.get(m.tokenIndex) ?? 0] ?? 'Token');
    choices.push({ tokenIndex: m.tokenIndex, key: tokenKey(playerId, m.tokenIndex), action, token });
  }
  return choices;
}
