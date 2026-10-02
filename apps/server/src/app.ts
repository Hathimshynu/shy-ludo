import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from './logger';
import { apiRouter, healthRouter, type ApiDeps } from './api/routes';
import { errorHandler, limiter, notFound, requestId } from './middleware/http';

export function createApp(deps: ApiDeps & { logger: Logger }): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(requestId());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        // Non-browser clients (no Origin) are allowed; browsers must be on the allow-list.
        if (!origin || config.allowedOrigins.includes(origin.replace(/\/$/, ''))) cb(null, true);
        else cb(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());

  app.use(healthRouter(deps));
  app.use('/api', limiter(config, 60_000, 300), apiRouter(deps));
  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}
