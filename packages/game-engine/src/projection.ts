import type { GameEvent, GameState } from '@ludo/shared-types';
import { finishProgress } from './board';
import { boardOf } from './capture';
import { computeLegalMoves, findPlayer } from './movement';
import { deadlineFor } from './turn';

/**
 * Event-sourcing projection: folds one engine event onto a state.
 *
 * `applyEvent(state, e)` for every event emitted by `applyAction` reproduces exactly the
 * state `applyAction` returned. Clients use this to stay in sync from the compact
 * event stream, and replays use it to rebuild any point of a recorded game.
 */
export function applyEvent(state: GameState, event: GameEvent): GameState {
  if (event.gameId !== state.id) throw new Error('Event belongs to a different game');
  if (event.seq !== state.seq + 1) {
    throw new Error(`Out-of-order event: expected seq ${state.seq + 1}, got ${event.seq}`);
  }
  const next = structuredClone(state);
  next.seq = event.seq;
  next.updatedAt = event.at;
  const turn = next.turn;

  switch (event.type) {
    case 'DICE_ROLLED': {
      const player = mustFind(next, event.playerId);
      const { value, consecutiveSixes, auto } = event.payload;
      player.stats.rolls += 1;
      if (value === 6) player.stats.sixes += 1;
      if (!auto) player.consecutiveTimeouts = 0;
      turn.dice = value;
      turn.consecutiveSixes = consecutiveSixes;
      const penalty = value === 6 && next.rules.threeSixPenalty && consecutiveSixes >= 3;
      if (!penalty) {
        const moves = computeLegalMoves(next, player.id, value);
        if (moves.length > 0) {
          turn.phase = 'move';
          turn.legalMoves = moves;
          turn.deadline = deadlineFor(next.rules, event.at);
        }
      }
      break;
    }
    case 'TOKEN_MOVED': {
      const player = mustFind(next, event.playerId);
      const { tokenIndex, to, auto } = event.payload;
      if (!auto) player.consecutiveTimeouts = 0;
      player.tokens[tokenIndex] = to;
      if (to >= finishProgress(boardOf(next))) player.stats.tokensFinished += 1;
      turn.legalMoves = [];
      break;
    }
    case 'TOKEN_CAPTURED': {
      const victim = mustFind(next, event.payload.victim.playerId);
      const attacker = mustFind(next, event.payload.by.playerId);
      victim.tokens[event.payload.victim.tokenIndex] = -1;
      victim.stats.timesCaptured += 1;
      attacker.stats.captures += 1;
      break;
    }
    case 'EXTRA_TURN':
      turn.phase = 'roll';
      turn.dice = null;
      turn.legalMoves = [];
      turn.turnNumber = event.payload.turnNumber;
      turn.deadline = event.payload.deadline;
      break;
    case 'TURN_PENALTY':
      break;
    case 'TURN_TIMEOUT':
      mustFind(next, event.playerId).consecutiveTimeouts = event.payload.consecutiveTimeouts;
      break;
    case 'TURN_CHANGED':
      next.turn = {
        playerId: event.payload.playerId,
        phase: 'roll',
        dice: null,
        consecutiveSixes: 0,
        legalMoves: [],
        deadline: event.payload.deadline,
        turnNumber: event.payload.turnNumber,
      };
      break;
    case 'PLAYER_FINISHED': {
      const player = mustFind(next, event.playerId);
      player.status = 'finished';
      player.rank = event.payload.rank;
      next.rankings.push(player.id);
      turn.legalMoves = [];
      break;
    }
    case 'PLAYER_FORFEITED': {
      const player = mustFind(next, event.playerId);
      if (player.status !== 'active') break;
      const finish = finishProgress(boardOf(next));
      player.status = 'forfeited';
      player.forfeitReason = event.payload.reason;
      player.tokens = player.tokens.map((t) => (t >= finish ? t : -1));
      next.forfeits.push(player.id);
      break;
    }
    case 'GAME_FINISHED':
      next.rankings = event.payload.rankings.slice();
      next.rankings.forEach((id, index) => {
        mustFind(next, id).rank = index + 1;
      });
      next.status = 'finished';
      next.turn = { ...turn, phase: 'over', dice: null, legalMoves: [], deadline: null };
      break;
  }
  return next;
}

export function applyEvents(state: GameState, events: readonly GameEvent[]): GameState {
  return events.reduce(applyEvent, state);
}

function mustFind(state: GameState, playerId: string | null) {
  const p = playerId ? findPlayer(state, playerId) : undefined;
  if (!p) throw new Error(`Event references unknown player ${playerId}`);
  return p;
}
