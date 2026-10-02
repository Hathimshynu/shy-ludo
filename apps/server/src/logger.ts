import { pino, type Logger } from 'pino';

/** Structured JSON logger. Secrets and credentials are redacted at the source. */
export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    base: { service: 'ludo-server' },
    redact: {
      paths: [
        'password',
        '*.password',
        'passwordHash',
        '*.passwordHash',
        'token',
        '*.token',
        'accessToken',
        '*.accessToken',
        'refreshToken',
        '*.refreshToken',
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'DATABASE_URL',
        'REDIS_URL',
        'JWT_SECRET',
        'JWT_REFRESH_SECRET',
      ],
      censor: '[redacted]',
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}

export type { Logger };
