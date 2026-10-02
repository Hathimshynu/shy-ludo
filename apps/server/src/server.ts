import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import type { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { AuthService } from './auth/authService';
import type { AppConfig } from './config';
import { createPrisma } from './db';
import { GameSessionManager } from './game/GameSessionManager';
import type { Logger } from './logger';
import { Matchmaker } from './matchmaking/Matchmaker';
import { RoomManager } from './rooms/RoomManager';
import { ioBroadcaster, type LudoServer, Presence } from './socket/broadcaster';
import { registerGateway } from './socket/gateway';
import {
  type CodeRegistry,
  type MatchQueue,
  MemoryCodeRegistry,
  MemoryMatchQueue,
  RedisCodeRegistry,
  RedisMatchQueue,
} from './services/coordination';
import { GameRepository } from './services/gameRepository';
import { ProfileService } from './services/profileService';
import { seedAchievements } from './services/stats';

export interface LudoServerInstance {
  httpServer: HttpServer;
  io: LudoServer;
  prisma: PrismaClient;
  rooms: RoomManager;
  sessions: GameSessionManager;
  matchmaker: Matchmaker;
  presence: Presence;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export interface CreateServerOptions {
  prisma?: PrismaClient;
  /** Provide a Redis client (e.g. ioredis-mock in tests). Defaults to REDIS_URL. */
  redis?: Redis | null;
}

export async function createLudoServer(
  config: AppConfig,
  logger: Logger,
  options: CreateServerOptions = {},
): Promise<LudoServerInstance> {
  const prisma = options.prisma ?? createPrisma(config.DATABASE_URL);
  await prisma.$connect();
  await seedAchievements(prisma);

  let redis: Redis | null = options.redis !== undefined ? options.redis : null;
  let redisSub: Redis | null = null;
  if (options.redis === undefined && config.REDIS_URL) {
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
    redis.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));
  }
  const queue: MatchQueue = redis ? new RedisMatchQueue(redis) : new MemoryMatchQueue();
  const codes: CodeRegistry = redis ? new RedisCodeRegistry(redis) : new MemoryCodeRegistry();

  const repo = new GameRepository(prisma);
  const auth = new AuthService(prisma, config);
  const profiles = new ProfileService(prisma);

  const healthChecks: Array<() => Promise<void>> = [
    async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
  ];
  if (redis) {
    const r = redis;
    healthChecks.push(async () => {
      await r.ping();
    });
  }

  const app = createApp({ config, logger, prisma, auth, profiles, games: repo, healthChecks });
  const httpServer = createHttpServer(app);
  const io: LudoServer = new Server(httpServer, {
    cors: { origin: config.allowedOrigins, credentials: true },
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    serveClient: false,
  });

  if (redis && config.REDIS_URL && options.redis === undefined) {
    redisSub = redis.duplicate();
    io.adapter(createAdapter(redis, redisSub));
    logger.info('Socket.IO Redis adapter enabled');
  }

  const presence = new Presence();
  const broadcaster = ioBroadcaster(io);
  const isOnline = (id: string) => presence.isOnline(id);

  // Rooms and sessions reference each other through callbacks.
  // eslint-disable-next-line prefer-const
  let sessions: GameSessionManager;
  const rooms = new RoomManager({
    broadcaster,
    repo,
    codes,
    logger,
    lobbyDisconnectSeconds: config.LOBBY_DISCONNECT_SECONDS,
    isOnline,
    startGame: (room) => sessions.startFromRoom(room),
    leaveGame: (userId) => sessions.leave(userId),
  });
  sessions = new GameSessionManager({
    config,
    prisma,
    repo,
    broadcaster,
    logger,
    isOnline,
    onGameEnded: (session) => rooms.onGameEnded(session.roomId, session.state),
    onPlayerReleased: (userId) => rooms.releaseFromGame(userId),
  });
  const matchmaker = new Matchmaker({ queue, rooms, sessions, broadcaster, repo, logger });

  registerGateway({ io, config, logger, auth, presence, rooms, sessions, matchmaker });
  await sessions.recover((stored, state) => rooms.restore(stored, state));

  return {
    httpServer,
    io,
    prisma,
    rooms,
    sessions,
    matchmaker,
    presence,
    listen(port = config.PORT, host = config.HOST) {
      return new Promise((resolve) => {
        httpServer.listen(port, host, () => resolve((httpServer.address() as AddressInfo).port));
      });
    },
    async close() {
      rooms.dispose();
      await sessions.shutdown();
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      if (redisSub) redisSub.disconnect();
      if (redis && options.redis === undefined) redis.disconnect();
      if (!options.prisma) await prisma.$disconnect();
    },
  };
}
