import type {
  AppError,
  ExtraTurnReason,
  ForfeitReason,
  GameAction,
  GameEvent,
  GameEventPayloads,
  GameEventType,
  GameRules,
  GameState,
  LegalMove,
  NewPlayerInput,
  PlayerState,
  TurnChangeReason,
} from '@ludo/shared-types';
import { appError } from '@ludo/shared-types';
import { chooseMove } from './ai';
import { armColors, armCountForPlayers, createBoard, finishProgress, seatArms } from './board';
import { boardOf } from './capture';
import { type DiceEngine, isValidDiceValue } from './dice';
import { computeLegalMoves, findPlayer, movableTokens, movesAreEquivalent } from './movement';
import { normalizeRules } from './rules';
import { activePlayers, deadlineFor, nextActivePlayer } from './turn';
import { validateAction } from './validation';
import { allTokensHome, computeFinalRankings, shouldEndGame } from './win';

export interface EngineContext {
  /** Current time (epoch ms). Injected for deterministic tests. */
  now: number;
  dice: DiceEngine;
}

export type ApplyResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: AppError };

export interface CreateGameOptions {
  id: string;
  players: NewPlayerInput[];
  rules?: Partial<GameRules>;
  now: number;
  /** Seat index that takes the first turn (default 0). */
  firstSeat?: number;
}

export function createGame(options: CreateGameOptions): GameState {
  const rules = normalizeRules({
    ...options.rules,
    maxPlayers: Math.max(options.rules?.maxPlayers ?? options.players.length, options.players.length),
  });
  const count = options.players.length;
  if (count < 2 || count > 8) throw new Error(`A game needs 2–8 players, got ${count}`);
  if (count > rules.maxPlayers) throw new Error('More players than seats');
  const ids = new Set(options.players.map((p) => p.id));
  if (ids.size !== count) throw new Error('Player ids must be unique');

  const armCount = armCountForPlayers(count);
  const board = createBoard(armCount);
  const arms = seatArms(count, armCount);
  const colors = armColors(armCount);

  const players: PlayerState[] = options.players.map((input, seat) => {
    const arm = arms[seat]!;
    return {
      id: input.id,
      name: input.name,
      avatar: input.avatar,
      kind: input.kind,
      botLevel: input.kind === 'bot' ? (input.botLevel ?? 'medium') : null,
      seat,
      arm,
      color: colors[arm]!,
      tokens: Array.from({ length: rules.tokensPerPlayer }, () => -1),
      status: 'active',
      rank: null,
      consecutiveTimeouts: 0,
      forfeitReason: null,
      stats: { captures: 0, timesCaptured: 0, sixes: 0, tokensFinished: 0, rolls: 0 },
    };
  });

  const firstSeat = Math.min(Math.max(options.firstSeat ?? 0, 0), count - 1);
  return {
    schemaVersion: 1,
    id: options.id,
    rules,
    armCount,
    trackLength: board.trackLength,
    players,
    turn: {
      playerId: players[firstSeat]!.id,
      phase: 'roll',
      dice: null,
      consecutiveSixes: 0,
      legalMoves: [],
      deadline: deadlineFor(rules, options.now),
      turnNumber: 1,
    },
    status: 'playing',
    seq: 0,
    rankings: [],
    forfeits: [],
    createdAt: options.now,
    updatedAt: options.now,
  };
}

/**
 * Mutable working copy used while applying one action. Collects events with
 * gap-free sequence numbers.
 */
class Transaction {
  readonly events: GameEvent[] = [];

  constructor(
    readonly state: GameState,
    readonly ctx: EngineContext,
  ) {}

  emit<T extends GameEventType>(type: T, playerId: string | null, payload: GameEventPayloads[T]): void {
    this.state.seq += 1;
    this.events.push({
      gameId: this.state.id,
      seq: this.state.seq,
      type,
      playerId,
      at: this.ctx.now,
      payload,
    } as GameEvent);
  }

  player(id: string): PlayerState {
    const p = findPlayer(this.state, id);
    if (!p) throw new Error(`Unknown player ${id}`);
    return p;
  }
}

/**
 * Apply one action. Never mutates `state`; returns the next state plus the
 * ordered events describing what happened.
 */
export function applyAction(state: GameState, action: GameAction, ctx: EngineContext): ApplyResult {
  const error = validateAction(state, action);
  if (error) return { ok: false, error };

  const tx = new Transaction(structuredClone(state), ctx);
  switch (action.type) {
    case 'ROLL':
      tx.player(action.playerId).consecutiveTimeouts = 0;
      doRoll(tx, false);
      break;
    case 'MOVE': {
      tx.player(action.playerId).consecutiveTimeouts = 0;
      const move = tx.state.turn.legalMoves.find((m) => m.tokenIndex === action.tokenIndex);
      if (!move) return { ok: false, error: appError('ILLEGAL_MOVE') };
      doMove(tx, move, false);
      break;
    }
    case 'TIMEOUT':
      doTimeout(tx);
      break;
    case 'FORFEIT':
      doForfeit(tx, action.playerId, action.reason);
      break;
  }
  tx.state.updatedAt = ctx.now;
  return { ok: true, state: tx.state, events: tx.events };
}

function doRoll(tx: Transaction, auto: boolean): void {
  const { state } = tx;
  const player = tx.player(state.turn.playerId);
  const value = tx.ctx.dice.roll();
  if (!isValidDiceValue(value)) throw new Error(`Dice engine produced invalid value ${value}`);

  player.stats.rolls += 1;
  if (value === 6) player.stats.sixes += 1;
  const consecutiveSixes = value === 6 ? state.turn.consecutiveSixes + 1 : 0;
  state.turn.consecutiveSixes = consecutiveSixes;
  state.turn.dice = value;

  if (value === 6 && state.rules.threeSixPenalty && consecutiveSixes >= 3) {
    tx.emit('DICE_ROLLED', player.id, { value, consecutiveSixes, movableTokens: [], auto });
    tx.emit('TURN_PENALTY', player.id, { reason: 'three-sixes' });
    passTurn(tx, 'penalty');
    return;
  }

  const moves = computeLegalMoves(state, player.id, value);
  tx.emit('DICE_ROLLED', player.id, {
    value,
    consecutiveSixes,
    movableTokens: movableTokens(moves),
    auto,
  });

  if (moves.length === 0) {
    if (value === 6 && state.rules.extraTurnOnSix) {
      grantExtraTurn(tx, ['six']);
    } else {
      passTurn(tx, 'no-moves');
    }
    return;
  }

  state.turn.phase = 'move';
  state.turn.legalMoves = moves;
  state.turn.deadline = deadlineFor(state.rules, tx.ctx.now);

  if (state.rules.autoMoveSingleOption && movesAreEquivalent(moves)) {
    doMove(tx, moves[0]!, true);
  }
}

function doMove(tx: Transaction, move: LegalMove, auto: boolean): void {
  const { state } = tx;
  const player = tx.player(state.turn.playerId);
  const board = boardOf(state);
  const dice = state.turn.dice ?? 0;

  player.tokens[move.tokenIndex] = move.to;
  tx.emit('TOKEN_MOVED', player.id, {
    tokenIndex: move.tokenIndex,
    from: move.from,
    to: move.to,
    path: move.path,
    kind: move.kind,
    auto,
  });

  for (const victimRef of move.captures) {
    const victim = tx.player(victimRef.playerId);
    const from = victim.tokens[victimRef.tokenIndex]!;
    victim.tokens[victimRef.tokenIndex] = -1;
    victim.stats.timesCaptured += 1;
    player.stats.captures += 1;
    const square = (board.startSquares[player.arm]! + move.to) % board.trackLength;
    tx.emit('TOKEN_CAPTURED', victim.id, {
      by: { playerId: player.id, tokenIndex: move.tokenIndex },
      victim: victimRef,
      from,
      square,
    });
  }

  const reachedHome = move.to >= finishProgress(board);
  if (reachedHome) player.stats.tokensFinished += 1;

  state.turn.legalMoves = [];

  if (allTokensHome(state, player)) {
    player.status = 'finished';
    state.rankings.push(player.id);
    player.rank = state.rankings.length;
    tx.emit('PLAYER_FINISHED', player.id, { rank: player.rank });
    if (shouldEndGame(state)) {
      finishGame(tx);
      return;
    }
    passTurn(tx, 'finished');
    return;
  }

  const reasons: ExtraTurnReason[] = [];
  if (dice === 6 && state.rules.extraTurnOnSix) reasons.push('six');
  if (move.captures.length > 0 && state.rules.extraTurnOnCapture) reasons.push('capture');
  if (reachedHome && state.rules.extraTurnOnHome) reasons.push('home');

  if (reasons.length > 0) grantExtraTurn(tx, reasons);
  else passTurn(tx, 'moved');
}

function grantExtraTurn(tx: Transaction, reasons: ExtraTurnReason[]): void {
  const { state } = tx;
  state.turn.phase = 'roll';
  state.turn.dice = null;
  state.turn.legalMoves = [];
  state.turn.turnNumber += 1;
  state.turn.deadline = deadlineFor(state.rules, tx.ctx.now);
  tx.emit('EXTRA_TURN', state.turn.playerId, {
    reasons,
    turnNumber: state.turn.turnNumber,
    deadline: state.turn.deadline,
  });
}

function passTurn(tx: Transaction, reason: TurnChangeReason): void {
  const { state } = tx;
  const previous = state.turn.playerId;
  const next = nextActivePlayer(state, previous);
  if (!next || activePlayers(state).length <= 1) {
    finishGame(tx);
    return;
  }
  state.turn = {
    playerId: next.id,
    phase: 'roll',
    dice: null,
    consecutiveSixes: 0,
    legalMoves: [],
    deadline: deadlineFor(state.rules, tx.ctx.now),
    turnNumber: state.turn.turnNumber + 1,
  };
  tx.emit('TURN_CHANGED', next.id, {
    playerId: next.id,
    previousPlayerId: previous,
    turnNumber: state.turn.turnNumber,
    deadline: state.turn.deadline,
    reason,
  });
}

function doTimeout(tx: Transaction): void {
  const { state } = tx;
  const player = tx.player(state.turn.playerId);
  player.consecutiveTimeouts += 1;
  tx.emit('TURN_TIMEOUT', player.id, { consecutiveTimeouts: player.consecutiveTimeouts });

  const limit = state.rules.maxConsecutiveTimeouts;
  if (limit > 0 && player.consecutiveTimeouts >= limit) {
    doForfeit(tx, player.id, 'timeout');
    return;
  }

  if (state.turn.phase === 'roll') {
    doRoll(tx, true);
  }
  // doRoll may already have moved automatically, passed the turn, or granted an extra roll.
  if (state.status === 'playing' && state.turn.phase === 'move' && state.turn.playerId === player.id) {
    const choice = chooseMove(state, player.id, 'medium') ?? state.turn.legalMoves[0];
    if (choice) doMove(tx, choice, true);
  }
}

function doForfeit(tx: Transaction, playerId: string, reason: ForfeitReason): void {
  const { state } = tx;
  const player = tx.player(playerId);
  if (player.status !== 'active') return;

  player.status = 'forfeited';
  player.forfeitReason = reason;
  const finish = finishProgress(boardOf(state));
  player.tokens = player.tokens.map((t) => (t >= finish ? t : -1));
  state.forfeits.push(player.id);
  tx.emit('PLAYER_FORFEITED', player.id, { reason });

  if (shouldEndGame(state)) {
    finishGame(tx);
    return;
  }
  if (state.turn.playerId === player.id) passTurn(tx, 'forfeit');
}

function finishGame(tx: Transaction): void {
  const { state } = tx;
  if (state.status === 'finished') return;
  const rankings = computeFinalRankings(state);
  rankings.forEach((id, index) => {
    const p = tx.player(id);
    p.rank = index + 1;
  });
  state.rankings = rankings;
  state.status = 'finished';
  state.turn = { ...state.turn, phase: 'over', dice: null, legalMoves: [], deadline: null };
  tx.emit('GAME_FINISHED', null, { rankings, winnerId: rankings[0] ?? null });
}

/** The player whose turn it is, if they are a bot. */
export function currentBot(state: GameState): PlayerState | null {
  if (state.status !== 'playing') return null;
  const p = findPlayer(state, state.turn.playerId);
  return p && p.kind === 'bot' && p.status === 'active' ? p : null;
}
