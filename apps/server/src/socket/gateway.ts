import type { Socket } from 'socket.io';
import {
  type AckResult,
  type AppError,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
  appError,
} from '@ludo/shared-types';
import { parseWith, type SocketEventName, type SocketPayload, socketSchemas } from '@ludo/validation';
import type { AppConfig } from '../config';
import { GameError } from '../errors';
import type { Logger } from '../logger';
import type { AuthService } from '../auth/authService';
import { verifyAccessToken } from '../auth/tokens';
import type { GameSessionManager } from '../game/GameSessionManager';
import type { Matchmaker } from '../matchmaking/Matchmaker';
import type { RoomManager, SocketUser } from '../rooms/RoomManager';
import { type Broadcaster, channels, type LudoServer, type Presence } from './broadcaster';
import type { FriendService } from '../services/friendService';

type LudoSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Token bucket per socket: `capacity` burst, refilled at `ratePerSecond`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly ratePerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.ratePerSecond);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export interface GatewayDeps {
  io: LudoServer;
  config: AppConfig;
  logger: Logger;
  auth: AuthService;
  presence: Presence;
  rooms: RoomManager;
  sessions: GameSessionManager;
  matchmaker: Matchmaker;
  friends: FriendService;
  broadcaster: Broadcaster;
}

const MAX_STRIKES = 40;

export function registerGateway(deps: GatewayDeps): void {
  const { io, config, logger, auth, presence, rooms, sessions, matchmaker, friends, broadcaster } = deps;

  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const claims = typeof token === 'string' ? verifyAccessToken(token, config.JWT_SECRET) : null;
      if (!claims) return next(new Error('UNAUTHORIZED'));
      const user = await auth.getUser(claims.sub);
      if (!user) return next(new Error('UNAUTHORIZED'));
      socket.data = {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        avatar: user.avatar,
        isGuest: user.isGuest,
      };
      next();
    } catch (err) {
      logger.error({ err }, 'Socket authentication failed');
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: LudoSocket) => {
    const userId = socket.data.userId;
    const me = (): SocketUser => ({ id: userId, name: socket.data.displayName, avatar: socket.data.avatar });
    const bucket = new TokenBucket(20, 8);
    let strikes = 0;

    void socket.join(channels.user(userId));
    const first = presence.add(userId, socket.id);
    logger.info({ userId, socketId: socket.id, first }, 'Socket connected');

    // ---- Session restore (refresh / reconnect) ----------------------------------
    const room = rooms.roomOf(userId);
    if (room) void socket.join(channels.room(room.id));
    const session = sessions.forUser(userId);
    if (session) void socket.join(channels.game(session.id));
    if (first) {
      rooms.userConnected(userId);
      sessions.userConnected(userId);
    }
    socket.emit('session:restore', {
      room: room ? rooms.view(room) : null,
      game: session ? session.snapshot() : null,
    });

    // ---- Handler plumbing ---------------------------------------------------------
    function on<E extends SocketEventName>(
      event: E,
      handler: (payload: SocketPayload<E>) => Promise<AckResult<object>> | AckResult<object>,
      cost = 1,
    ): void {
      const untyped = socket as unknown as { on(e: string, fn: (raw: unknown, ack: unknown) => void): void };
      untyped.on(event, async (raw, ack) => {
        const reply = typeof ack === 'function' ? (ack as (r: AckResult<object>) => void) : () => undefined;
        if (!bucket.take(cost)) {
          strikes += 1;
          if (strikes > MAX_STRIKES) {
            logger.warn({ userId, socketId: socket.id }, 'Disconnecting abusive socket');
            socket.disconnect(true);
          }
          return reply({ ok: false, error: appError('RATE_LIMITED') });
        }
        const parsed = parseWith(socketSchemas[event], raw);
        if (!parsed.ok) return reply({ ok: false, error: { code: 'VALIDATION', message: 'Invalid request.' } });
        try {
          reply(await handler(parsed.data as SocketPayload<E>));
        } catch (err) {
          if (err instanceof GameError) return reply({ ok: false, error: err.error });
          logger.error({ err, event, userId }, 'Socket handler failed');
          reply({ ok: false, error: appError('INTERNAL') });
        }
      });
    }

    const ok = <T extends object>(data: T): AckResult<T> => ({ ok: true, ...data }) as AckResult<T>;
    const failWith = (error: AppError): AckResult<object> => ({ ok: false, error });

    // ---- Rooms ------------------------------------------------------------------------
    on('room:create', async ({ settings }) => {
      if (sessions.isPlaying(userId)) return failWith(appError('ALREADY_IN_GAME'));
      await matchmaker.leave(userId);
      return ok({ room: rooms.view(await rooms.create(me(), settings)) });
    });
    on('room:join', async ({ code }) => {
      if (sessions.isPlaying(userId) && rooms.roomOf(userId)?.code !== code) {
        return failWith(appError('ALREADY_IN_GAME'));
      }
      await matchmaker.leave(userId);
      return ok({ room: rooms.view(await rooms.join(me(), code)) });
    });
    on('room:leave', () => {
      rooms.leave(userId);
      return ok({});
    });
    on('room:kick', ({ userId: target }) => {
      rooms.kick(userId, target);
      return ok({});
    });
    on('room:settings', ({ settings }) => ok({ room: rooms.view(rooms.updateSettings(userId, settings)) }));
    on('room:addBot', ({ difficulty }) => ok({ room: rooms.view(rooms.addBot(userId, difficulty)) }));
    on('room:removeBot', ({ botId }) => ok({ room: rooms.view(rooms.removeBot(userId, botId)) }));
    on('player:ready', ({ ready }) => ok({ room: rooms.view(rooms.setReady(userId, ready)) }));
    on('game:start', async () => ok({ gameId: await rooms.start(userId) }), 2);

    // ---- Matchmaking --------------------------------------------------------------------
    on('matchmaking:join', async ({ playerCount }) => ok({ status: await matchmaker.join(me(), playerCount) }), 2);
    on('matchmaking:leave', async () => {
      await matchmaker.leave(userId);
      return ok({});
    });

    // ---- Game actions (identity always from the socket, never the payload) ---------------
    on('dice:roll', ({ gameId, actionId, expectedSeq }) =>
      sessions.handleAction(userId, gameId, { kind: 'roll', actionId, expectedSeq }),
    );
    on('token:move', ({ gameId, actionId, expectedSeq, tokenIndex }) =>
      sessions.handleAction(userId, gameId, { kind: 'move', actionId, expectedSeq, tokenIndex }),
    );
    on('game:sync', ({ gameId }) => ok({ snapshot: sessions.sync(userId, gameId) }), 2);
    on('game:leave', ({ gameId }) => {
      const s = sessions.get(gameId);
      if (!s || !s.isParticipant(userId)) return failWith(appError('NOT_IN_GAME'));
      sessions.leave(userId, gameId);
      return ok({});
    });
    on('game:emote', ({ gameId, emote }) => sessions.emote(userId, gameId, emote));
    on('time:ping', ({ clientTime }) => ok({ clientTime, serverTime: Date.now() }), 0.25);

    // ---- Friends --------------------------------------------------------------------------
    on(
      'friend:invite',
      async ({ userId: friendId }) => {
        const room = rooms.roomOf(userId);
        if (!room || room.kind !== 'private') return failWith(appError('NOT_IN_ROOM'));
        if (!(await friends.areFriends(userId, friendId))) return failWith(appError('FORBIDDEN', 'You can only invite friends.'));
        const user = await auth.getUser(userId);
        if (!user) return failWith(appError('UNAUTHORIZED'));
        broadcaster.emit(channels.user(friendId), 'friend:invite', { from: user, code: room.code });
        return ok({});
      },
      3,
    );

    socket.on('disconnect', (reason) => {
      const last = presence.remove(userId, socket.id);
      logger.info({ userId, socketId: socket.id, reason, last }, 'Socket disconnected');
      if (!last) return;
      rooms.userDisconnected(userId);
      sessions.userDisconnected(userId);
      void matchmaker.leave(userId).catch(() => undefined);
    });
  });
}
