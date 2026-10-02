import { type AppError, type GameAction, type GameState, appError } from '@ludo/shared-types';
import { findPlayer } from './movement';

/**
 * Validates an action against the current state *before* the engine applies it.
 * Returns null when the action may proceed.
 */
export function validateAction(state: GameState, action: GameAction): AppError | null {
  if (state.status !== 'playing') return appError('GAME_OVER');

  switch (action.type) {
    case 'ROLL': {
      const player = findPlayer(state, action.playerId);
      if (!player) return appError('NOT_IN_GAME');
      if (player.status !== 'active') return appError('FORBIDDEN', 'You are no longer playing in this game.');
      if (state.turn.playerId !== player.id) return appError('NOT_YOUR_TURN');
      if (state.turn.phase !== 'roll') return appError('WRONG_PHASE', 'Choose a token to move first.');
      return null;
    }
    case 'MOVE': {
      const player = findPlayer(state, action.playerId);
      if (!player) return appError('NOT_IN_GAME');
      if (player.status !== 'active') return appError('FORBIDDEN', 'You are no longer playing in this game.');
      if (state.turn.playerId !== player.id) return appError('NOT_YOUR_TURN');
      if (state.turn.phase !== 'move') return appError('WRONG_PHASE', 'Roll the dice first.');
      if (
        !Number.isInteger(action.tokenIndex) ||
        action.tokenIndex < 0 ||
        action.tokenIndex >= player.tokens.length
      ) {
        return appError('INVALID_TOKEN');
      }
      if (!state.turn.legalMoves.some((m) => m.tokenIndex === action.tokenIndex)) {
        return appError('ILLEGAL_MOVE');
      }
      return null;
    }
    case 'TIMEOUT':
      return null;
    case 'FORFEIT': {
      const player = findPlayer(state, action.playerId);
      if (!player) return appError('NOT_IN_GAME');
      return null;
    }
  }
}
