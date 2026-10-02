import { loadConfig } from './config';
import { createLogger } from './logger';
import { createLudoServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, !config.isProduction && process.stdout.isTTY);
  const server = await createLudoServer(config, logger);
  const port = await server.listen();
  logger.info(
    { port, env: config.NODE_ENV, redis: Boolean(config.REDIS_URL), origins: config.allowedOrigins },
    'Server started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await server.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
