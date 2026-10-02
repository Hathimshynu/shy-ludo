import type { GameState, PlayerState } from '@ludo/shared-types';
import { finishProgress } from './board';
import { boardOf } from './capture';

export function allTokensHome(state: GameState, player: PlayerState): boolean {
  const finish = finishProgress(boardOf(state));
  return player.tokens.every((t) => t >= finish);
}

/** Sum of progress used to rank unfinished players (tokens in base count as 0). */
export function totalProgress(player: PlayerState): number {
  return player.tokens.reduce((sum, t) => sum + (t < 0 ? 0 : t + 1), 0);
}

/**
 * Final ranking order:
 *   1. finished players in the order they finished,
 *   2. still-active players by total progress (seat breaks ties),
 *   3. forfeited players, most recent forfeit first.
 */
export function computeFinalRankings(state: GameState): string[] {
  const finished = state.rankings.slice();
  const active = state.players
    .filter((p) => p.status === 'active')
    .sort((a, b) => totalProgress(b) - totalProgress(a) || a.seat - b.seat)
    .map((p) => p.id);
  const forfeited = state.forfeits.slice().reverse();
  return [...finished, ...active, ...forfeited];
}

/** Should the game end now? */
export function shouldEndGame(state: GameState): boolean {
  const active = state.players.filter((p) => p.status === 'active').length;
  if (active <= 1) return true;
  if (!state.rules.continueAfterWinner && state.rankings.length >= 1) return true;
  return false;
}
