import { type AppError, type ErrorCode, FRIENDLY_ERRORS } from '@ludo/shared-types';

const STATUS: Partial<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  GAME_NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  CONFLICT: 409,
  USERNAME_TAKEN: 409,
  EMAIL_TAKEN: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** An expected, user-presentable error. Anything else is reported as INTERNAL. */
export class HttpError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message ?? FRIENDLY_ERRORS[code]);
    this.status = STATUS[code] ?? 400;
  }

  toAppError(): AppError {
    return { code: this.code, message: this.message };
  }
}

export class GameError extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}
