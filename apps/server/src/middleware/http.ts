import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { ZodTypeAny, z } from 'zod';
import { parseWith } from '@ludo/validation';
import type { ApiErrorBody } from '@ludo/shared-types';
import type { AppConfig } from '../config';
import { HttpError } from '../errors';
import type { Logger } from '../logger';
import { verifyAccessToken } from '../auth/tokens';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    userId?: string;
    isGuest?: boolean;
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  };
}

function bearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/** Attach the user if a valid access token is present; never fails. */
export function optionalAuth(config: AppConfig): RequestHandler {
  return (req, _res, next) => {
    const token = bearer(req);
    const claims = token ? verifyAccessToken(token, config.JWT_SECRET) : null;
    if (claims) {
      req.userId = claims.sub;
      req.isGuest = claims.g;
    }
    next();
  };
}

/** Reject the request unless a valid access token is present. */
export function requireAuth(config: AppConfig): RequestHandler {
  return (req, _res, next) => {
    const token = bearer(req);
    const claims = token ? verifyAccessToken(token, config.JWT_SECRET) : null;
    if (!claims) return next(new HttpError('UNAUTHORIZED'));
    req.userId = claims.sub;
    req.isGuest = claims.g;
    next();
  };
}

/**
 * CSRF protection for cookie-authenticated endpoints (refresh / logout).
 * Requires a custom header (which forces a CORS pre-flight) and, when the browser
 * sends an Origin, that it is on the allow-list.
 */
export function csrfGuard(config: AppConfig): RequestHandler {
  return (req, _res, next) => {
    if (req.header('x-requested-with') !== 'ludo') return next(new HttpError('FORBIDDEN'));
    const origin = req.header('origin');
    if (origin && !config.allowedOrigins.includes(origin.replace(/\/$/, ''))) {
      return next(new HttpError('FORBIDDEN'));
    }
    next();
  };
}

export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req, _res, next) => {
    const result = parseWith(schema, req.body);
    if (!result.ok) return next(new HttpError('VALIDATION', result.error.message, result.error.fields));
    req.body = result.data as z.infer<S>;
    next();
  };
}

export function limiter(config: AppConfig, windowMs: number, limit: number): RequestHandler {
  if (config.RATE_LIMIT_DISABLED) return (_req, _res, next) => next();
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError('RATE_LIMITED')),
  });
}

export function notFound(): RequestHandler {
  return (_req, _res, next) => next(new HttpError('NOT_FOUND'));
}

/** Converts errors to a friendly JSON body. Internal details are logged, never returned. */
export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    let status = 500;
    let body: ApiErrorBody;
    if (err instanceof HttpError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } };
    } else if (isBodyParserError(err)) {
      status = 400;
      body = { error: { code: 'BAD_REQUEST', message: 'Malformed request body.' } };
    } else {
      logger.error({ err, requestId: req.requestId, path: req.path }, 'Unhandled request error');
      body = { error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } };
    }
    body.requestId = req.requestId;
    res.status(status).json(body);
  };
}

function isBodyParserError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err && (err as { status: number }).status === 400;
}
