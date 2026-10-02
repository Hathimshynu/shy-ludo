export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
  'VALIDATION',
  'INVALID_CREDENTIALS',
  'USERNAME_TAKEN',
  'EMAIL_TAKEN',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ROOM_IN_GAME',
  'ALREADY_IN_ROOM',
  'NOT_IN_ROOM',
  'NOT_HOST',
  'NOT_READY',
  'NOT_ENOUGH_PLAYERS',
  'ALREADY_IN_GAME',
  'ALREADY_QUEUED',
  'GAME_NOT_FOUND',
  'NOT_IN_GAME',
  'GAME_OVER',
  'GAME_PAUSED',
  'NOT_YOUR_TURN',
  'WRONG_PHASE',
  'INVALID_TOKEN',
  'ILLEGAL_MOVE',
  'STALE_STATE',
  'DUPLICATE_ACTION',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppError {
  code: ErrorCode;
  message: string;
}

/** Friendly copy shown to players. Raw backend errors are never displayed. */
export const FRIENDLY_ERRORS: Record<ErrorCode, string> = {
  BAD_REQUEST: 'Something about that request was not right.',
  UNAUTHORIZED: 'Please sign in to continue.',
  FORBIDDEN: 'You are not allowed to do that.',
  NOT_FOUND: 'We could not find that.',
  CONFLICT: 'That conflicts with the current state. Please try again.',
  RATE_LIMITED: 'Slow down a little — too many requests.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
  VALIDATION: 'Please check the highlighted fields.',
  INVALID_CREDENTIALS: 'Incorrect username or password.',
  USERNAME_TAKEN: 'That username is already taken.',
  EMAIL_TAKEN: 'That email is already registered.',
  ROOM_NOT_FOUND: 'Room not found. Check the code and try again.',
  ROOM_FULL: 'Room is full.',
  ROOM_IN_GAME: 'That room has already started its game.',
  ALREADY_IN_ROOM: 'You are already in a room.',
  NOT_IN_ROOM: 'You are not in that room.',
  NOT_HOST: 'Only the host can do that.',
  NOT_READY: 'Everyone must be ready before starting.',
  NOT_ENOUGH_PLAYERS: 'At least two players are needed to start.',
  ALREADY_IN_GAME: 'You are already playing a game.',
  ALREADY_QUEUED: 'You are already searching for a match.',
  GAME_NOT_FOUND: 'That game no longer exists.',
  NOT_IN_GAME: 'You are not a player in this game.',
  GAME_OVER: 'This game has finished.',
  GAME_PAUSED: 'The game is paused.',
  NOT_YOUR_TURN: 'It is not your turn.',
  WRONG_PHASE: 'You cannot do that right now.',
  INVALID_TOKEN: 'Invalid move.',
  ILLEGAL_MOVE: 'Invalid move.',
  STALE_STATE: 'The board changed — syncing…',
  DUPLICATE_ACTION: 'That action was already received.',
};

export function appError(code: ErrorCode, message?: string): AppError {
  return { code, message: message ?? FRIENDLY_ERRORS[code] };
}
