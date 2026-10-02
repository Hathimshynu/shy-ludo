import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { io as connectClient, type Socket } from 'socket.io-client';
import { inject } from 'vitest';
import type {
  AppError,
  AuthResponse,
  ClientToServerEvents,
  GameEvent,
  GameSnapshotMessage,
  GameState,
  MatchmakingStatus,
  RoomSettings,
  RoomView,
  ServerToClientEvents,
} from '@ludo/shared-types';
import { applyEvents, DEFAULT_VARIANTS } from '@ludo/game-engine';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { createLudoServer, type CreateServerOptions, type LudoServerInstance } from '../src/server';

export interface LooseAck {
  ok: boolean;
  error: AppError;
  room?: RoomView;
  status?: MatchmakingStatus;
  gameId?: string;
  seq?: number;
  snapshot?: GameSnapshotMessage;
}

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Clone the migrated template into a fresh database for this test file. */
export async function createTestDatabase(): Promise<string> {
  const adminUrl = inject('pgAdminUrl');
  const template = inject('pgTemplate');
  const name = `ludo_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  // CREATE DATABASE … TEMPLATE requires no other connections to the template; retry briefly.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      break;
    } catch (err) {
      if (attempt > 20) throw err;
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));
    }
  }
  await admin.$disconnect();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

export interface TestServer {
  server: LudoServerInstance;
  url: string;
  databaseUrl: string;
  close(): Promise<void>;
}

export async function startTestServer(
  env: Record<string, string> = {},
  options: CreateServerOptions & { databaseUrl?: string } = {},
): Promise<TestServer> {
  const databaseUrl = options.databaseUrl ?? (await createTestDatabase());
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    JWT_SECRET: 'test-access-secret-0123456789-0123456789',
    JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789-0123456789',
    CLIENT_URL: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    BOT_DELAY_MS: '0',
    RATE_LIMIT_DISABLED: 'true',
    ...env,
  });
  const server = await createLudoServer(config, createLogger('silent'), options);
  const port = await server.listen(0, '127.0.0.1');
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    databaseUrl,
    close: () => server.close(),
  };
}

export async function api<T = unknown>(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string; cookie?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T; cookie: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...init.headers,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : null) as T,
    cookie: setCookie ? setCookie.split(';')[0]! : null,
  };
}

export async function guest(base: string, displayName?: string): Promise<AuthResponse & { cookie: string }> {
  const r = await api<AuthResponse>(base, '/api/auth/guest', { body: displayName ? { displayName } : {} });
  if (r.status !== 201) throw new Error(`guest failed ${r.status}`);
  return { ...r.body, cookie: r.cookie! };
}

export function testSettings(
  overrides: Omit<Partial<RoomSettings>, 'variants'> & { variants?: Partial<RoomSettings['variants']> } = {},
): RoomSettings {
  return {
    maxPlayers: overrides.maxPlayers ?? 4,
    turnTimeSeconds: overrides.turnTimeSeconds ?? 60,
    tokensPerPlayer: overrides.tokensPerPlayer ?? 4,
    variants: { ...DEFAULT_VARIANTS, ...overrides.variants },
  };
}

/**
 * A scripted player: keeps an authoritative-state mirror purely from server messages
 * (snapshots + event projection), exactly like the real web client.
 */
export class TestClient {
  readonly socket: ClientSocket;
  state: GameState | null = null;
  room: RoomView | null = null;
  readonly events: GameEvent[] = [];
  readonly received: Array<{ event: string; payload: unknown }> = [];
  finished: string[] | null = null;
  private waiters: Array<() => void> = [];

  constructor(
    readonly base: string,
    readonly auth: AuthResponse,
    opts: { autoConnect?: boolean } = {},
  ) {
    this.socket = connectClient(base, {
      auth: { token: auth.accessToken },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      autoConnect: opts.autoConnect ?? true,
    }) as ClientSocket;
    const record = (event: string) => (payload: unknown) => {
      this.received.push({ event, payload });
      this.notify();
    };
    for (const e of ['player:disconnect', 'player:reconnect', 'game:pause', 'game:resume', 'room:kicked', 'room:closed', 'matchmaking:status', 'game:emote'] as const) {
      this.socket.on(e, record(e) as never);
    }
    this.socket.on('room:update', (room) => {
      this.room = room;
      this.notify();
    });
    this.socket.on('session:restore', ({ room, game }) => {
      this.received.push({ event: 'session:restore', payload: { room, game } });
      this.room = room;
      if (game) this.applySnapshot(game);
      this.notify();
    });
    this.socket.on('game:start', (snap) => {
      this.received.push({ event: 'game:start', payload: snap });
      this.applySnapshot(snap);
      this.notify();
    });
    this.socket.on('game:state', (snap) => {
      this.applySnapshot(snap);
      this.notify();
    });
    this.socket.on('game:events', ({ events }) => {
      if (!this.state) return;
      const fresh = events.filter((e) => e.seq > this.state!.seq);
      this.state = applyEvents(this.state, fresh);
      this.events.push(...fresh);
      this.notify();
    });
    this.socket.on('game:finish', ({ rankings }) => {
      this.finished = rankings;
      this.notify();
    });
  }

  get id(): string {
    return this.auth.user.id;
  }

  applySnapshot(snap: GameSnapshotMessage): void {
    this.state = snap.state;
  }

  connected(): Promise<void> {
    if (this.socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', (err) => reject(err));
    });
  }

  emit<E extends keyof ClientToServerEvents>(
    event: E,
    payload: Parameters<ClientToServerEvents[E]>[0],
  ): Promise<LooseAck> {
    return new Promise((resolve) => {
      (this.socket.emit as (e: string, p: unknown, ack: (r: unknown) => void) => void)(event, payload, (r) =>
        resolve(r as LooseAck),
      );
    });
  }

  roll(overrides: Record<string, unknown> = {}) {
    return this.emit('dice:roll', {
      gameId: this.state!.id,
      actionId: randomUUID(),
      expectedSeq: this.state!.seq,
      ...overrides,
    } as never);
  }

  move(tokenIndex: number, overrides: Record<string, unknown> = {}) {
    return this.emit('token:move', {
      gameId: this.state!.id,
      actionId: randomUUID(),
      expectedSeq: this.state!.seq,
      tokenIndex,
      ...overrides,
    } as never);
  }

  myTurn(): boolean {
    return !!this.state && this.state.status === 'playing' && this.state.turn.playerId === this.id;
  }

  /** Take one action if it is our turn (roll, or move the first legal token). */
  async act(): Promise<boolean> {
    if (!this.myTurn()) return false;
    let r = this.state!.turn.phase === 'roll' ? await this.roll() : await this.move(this.state!.turn.legalMoves[0]!.tokenIndex);
    for (let i = 0; i < 20 && !r.ok && r.error.code === 'RATE_LIMITED'; i += 1) {
      await sleep(200);
      r = this.state!.turn.phase === 'roll' ? await this.roll() : await this.move(this.state!.turn.legalMoves[0]!.tokenIndex);
    }
    if (!r.ok && r.error.code !== 'STALE_STATE') throw new Error(`Action failed: ${r.error.code}`);
    return true;
  }

  waitFor(predicate: () => boolean, timeoutMs = 15_000, label = 'condition'): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== check);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      const check = () => {
        if (predicate()) {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((w) => w !== check);
          resolve();
        }
      };
      this.waiters.push(check);
    });
  }

  waitForEvent(event: string, timeoutMs = 15_000): Promise<unknown> {
    const start = this.received.length;
    return this.waitFor(() => this.received.slice(start).some((r) => r.event === event), timeoutMs, event).then(
      () => this.received.slice(start).find((r) => r.event === event)!.payload,
    );
  }

  close(): void {
    this.socket.disconnect();
  }

  private notify(): void {
    for (const w of [...this.waiters]) w();
  }
}

export async function connectGuests(base: string, count: number): Promise<TestClient[]> {
  const clients: TestClient[] = [];
  for (let i = 0; i < count; i += 1) {
    const auth = await guest(base, `Tester ${i + 1}`);
    const c = new TestClient(base, auth);
    await c.connected();
    clients.push(c);
  }
  return clients;
}

/** Drive every client until the game finishes (each acts when it is their turn). */
export async function playToCompletion(clients: TestClient[], maxActions = 20_000): Promise<void> {
  let actions = 0;
  let idleSince = Date.now();
  while (!clients.every((c) => c.finished)) {
    const current = await currentPlayer(clients);
    if (!current) {
      if (clients.every((c) => c.finished)) break;
      if (Date.now() - idleSince > 20_000) throw new Error('Nobody can act — game stuck');
      continue;
    }
    idleSince = Date.now();
    const before = current.state!.seq;
    await current.act();
    actions += 1;
    if (actions > maxActions) throw new Error('Game did not finish');
    // Wait until this client has applied the resulting events before deciding again.
    await current.waitFor(() => (current.state?.seq ?? 0) > before || !!current.finished, 15_000, 'events');
  }
}

/** Poll briefly until some client sees that it is their turn (or the game ended). */
export async function currentPlayer(clients: TestClient[], timeoutMs = 2_000): Promise<TestClient | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = clients.find((x) => x.myTurn());
    if (c || clients.every((x) => x.finished) || Date.now() > deadline) return c;
    await sleep(3);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
