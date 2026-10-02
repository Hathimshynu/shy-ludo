import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { GameEvent, GameSnapshotMessage, MatchmakingStatus, RoomView } from '@ludo/shared-types';
import {
  connectGuests,
  currentPlayer,
  guest,
  playToCompletion,
  sleep,
  startTestServer,
  TestClient,
  type TestServer,
  testSettings,
} from './harness';
import { RedisCodeRegistry, RedisMatchQueue } from '../src/services/coordination';

let ctx: TestServer;
const open: TestClient[] = [];

beforeAll(async () => {
  ctx = await startTestServer({ DISCONNECT_GRACE_SECONDS: '5' });
});
afterAll(async () => {
  open.forEach((c) => c.close());
  await ctx?.close();
});

async function startGame(server: TestServer, n: number, settings = testSettings({ maxPlayers: Math.max(2, n) })) {
  const clients = await connectGuests(server.url, n);
  open.push(...clients);
  const [host, ...rest] = clients;
  const { room } = (await host!.emit('room:create', { settings })) as { room: RoomView };
  for (const c of rest) {
    await c.emit('room:join', { code: room.code });
    await c.emit('player:ready', { ready: true });
  }
  expect((await host!.emit('game:start', {})).ok).toBe(true);
  await Promise.all(clients.map((c) => c.waitFor(() => !!c.state)));
  return clients;
}

/** Re-open a connection for the same user (browser refresh). */
async function reconnect(server: TestServer, client: TestClient): Promise<TestClient> {
  const again = new TestClient(server.url, client.auth);
  open.push(again);
  await again.connected();
  await again.waitFor(() => again.received.some((r) => r.event === 'session:restore'));
  return again;
}

describe('reconnection', () => {
  it('restores the running game after a refresh and keeps the seat', async () => {
    const [a, b] = await startGame(ctx, 2);
    // Play a few actions so there is real state to restore.
    for (let i = 0; i < 4; i += 1) {
      const cur = (await currentPlayer([a!, b!]))!;
      const before = cur.state!.seq;
      await cur.act();
      await cur.waitFor(() => cur.state!.seq > before);
    }
    const disconnectSeen = b!.waitForEvent('player:disconnect');
    a!.close();
    expect(await disconnectSeen).toMatchObject({ playerId: a!.id, graceSeconds: 5 });

    const reconnectSeen = b!.waitForEvent('player:reconnect');
    const a2 = await reconnect(ctx, a!);
    await reconnectSeen;
    const restore = a2.received.find((r) => r.event === 'session:restore')!.payload as { game: GameSnapshotMessage; room: RoomView };
    expect(restore.room.gameId).toBe(b!.state!.id);
    await b!.waitFor(() => b!.state!.seq === restore.game.state.seq);
    expect(restore.game.state).toEqual(b!.state);
    expect(restore.game.connected[a!.id]).toBe(true);

    // The restored client can keep playing.
    await playToCompletion([a2, b!].map((c) => c), 50).catch((err: Error) => {
      if (!/did not finish/.test(err.message)) throw err;
    });
    expect(a2.events.length).toBeGreaterThan(0);
  });

  it('pauses when every player is offline and resumes with a fresh deadline', async () => {
    const [a, b] = await startGame(ctx, 2);
    const gameId = a!.state!.id;
    a!.close();
    b!.close();
    const session = ctx.server.sessions.get(gameId)!;
    await sleep(200);
    expect(session.isPaused).toBe(true);
    const b2 = new TestClient(ctx.url, b!.auth, { autoConnect: false });
    open.push(b2);
    const resumed = b2.waitForEvent('game:resume');
    b2.socket.connect();
    const payload = (await resumed) as { deadline: number };
    expect(session.isPaused).toBe(false);
    expect(payload.deadline).toBeGreaterThan(Date.now() + 30_000);
  });

  it('forfeits a player who does not return within the grace period', async () => {
    const [a, b, c] = await startGame(ctx, 3);
    c!.close();
    await a!.waitFor(
      () => a!.events.some((e) => e.type === 'PLAYER_FORFEITED' && e.playerId === c!.id),
      12_000,
      'disconnect forfeit',
    );
    const forfeit = a!.events.find((e) => e.type === 'PLAYER_FORFEITED')! as Extract<GameEvent, { type: 'PLAYER_FORFEITED' }>;
    expect(forfeit.payload.reason).toBe('disconnect');
    await b!.waitFor(() => b!.state!.seq === a!.state!.seq);
    expect(b!.state).toEqual(a!.state);
  });

  it('ends the game for the remaining player when an opponent leaves', async () => {
    const [a, b] = await startGame(ctx, 2);
    expect((await a!.emit('game:leave', { gameId: a!.state!.id })).ok).toBe(true);
    await b!.waitFor(() => !!b!.finished, 10_000, 'finish');
    expect(b!.finished).toEqual([b!.id, a!.id]);
  });
});

describe('server-side turn timer', () => {
  it('auto-plays expired turns and forfeits after repeated timeouts', async () => {
    const fast = await startTestServer({ TEST_TURN_SECONDS: '1' });
    try {
      const [a, b] = await startGame(fast, 2, testSettings({ maxPlayers: 2 }));
      // Nobody acts: the server must drive the game by itself.
      await a!.waitFor(() => !!a!.finished, 20_000, 'timeouts to end the game');
      expect(a!.events.filter((e) => e.type === 'TURN_TIMEOUT').length).toBeGreaterThanOrEqual(3);
      expect(a!.events.some((e) => e.type === 'PLAYER_FORFEITED')).toBe(true);
      await b!.waitFor(() => !!b!.finished);
      expect(b!.state).toEqual(a!.state);
    } finally {
      await fast.close();
    }
  });
});

describe('matchmaking', () => {
  it('matches two players into one game and never double-books them', async () => {
    const [a, b] = await connectGuests(ctx.url, 2);
    open.push(a!, b!);
    const ra = await a!.emit('matchmaking:join', { playerCount: 2 });
    expect((ra as { status: MatchmakingStatus }).status.state).toBe('searching');
    const again = await a!.emit('matchmaking:join', { playerCount: 2 });
    expect(again.ok).toBe(true);
    const other = await a!.emit('matchmaking:join', { playerCount: 4 });
    expect(!other.ok && other.error.code).toBe('ALREADY_QUEUED');

    await b!.emit('matchmaking:join', { playerCount: 2 });
    await Promise.all([a!.waitFor(() => !!a!.state), b!.waitFor(() => !!b!.state)]);
    expect(a!.state!.id).toBe(b!.state!.id);
    expect(a!.state!.players.map((p) => p.id).sort()).toEqual([a!.id, b!.id].sort());

    const busy = await a!.emit('matchmaking:join', { playerCount: 2 });
    expect(!busy.ok && busy.error.code).toBe('ALREADY_IN_GAME');
  });

  it('forms exactly one 4-player match from 5 simultaneous requests', async () => {
    const clients = await connectGuests(ctx.url, 5);
    open.push(...clients);
    await Promise.all(clients.map((c) => c.emit('matchmaking:join', { playerCount: 4 })));
    await sleep(500);
    const matched = clients.filter((c) => c.state);
    expect(matched).toHaveLength(4);
    expect(new Set(matched.map((c) => c.state!.id)).size).toBe(1);
    const waiting = clients.find((c) => !c.state)!;
    const left = await waiting.emit('matchmaking:leave', {});
    expect(left.ok).toBe(true);
  });

  it('removes a disconnected user from the queue', async () => {
    const [a] = await connectGuests(ctx.url, 1);
    await a!.emit('matchmaking:join', { playerCount: 8 });
    expect(ctx.server.matchmaker.isQueued(a!.id)).toBe(true);
    a!.close();
    await sleep(200);
    expect(ctx.server.matchmaker.isQueued(a!.id)).toBe(false);
  });
});

describe('crash recovery', () => {
  it('reloads active games from PostgreSQL after a restart', async () => {
    const first = await startTestServer({ DISCONNECT_GRACE_SECONDS: '30' });
    const [a, b] = await startGame(first, 2);
    for (let i = 0; i < 6; i += 1) {
      const cur = (await currentPlayer([a!, b!]))!;
      const before = cur.state!.seq;
      await cur.act();
      await cur.waitFor(() => cur.state!.seq > before);
    }
    const gameId = a!.state!.id;
    await first.server.sessions.get(gameId)!.idle();
    const seq = a!.state!.seq;
    a!.close();
    b!.close();
    await first.close();

    const second = await startTestServer({ DISCONNECT_GRACE_SECONDS: '30' }, { databaseUrl: first.databaseUrl });
    try {
      expect(second.server.sessions.get(gameId)?.state.seq).toBe(seq);
      const a2 = await reconnect(second, a!);
      const b2 = await reconnect(second, b!);
      expect(a2.state!.id).toBe(gameId);
      expect(a2.state!.seq).toBe(seq);
      const cur = (await currentPlayer([a2, b2]))!;
      const before = cur.state!.seq;
      await cur.act();
      await cur.waitFor(() => cur.state!.seq > before);
      a2.close();
      b2.close();
    } finally {
      await second.close();
    }
  });
});

describe('Redis coordination', () => {
  it('pops matchmaking batches atomically', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const q = new RedisMatchQueue(redis, 'test:mm:');
    await q.add(4, 'a');
    await q.add(4, 'b');
    await q.add(4, 'a'); // no duplicates
    await q.add(4, 'c');
    expect(await q.length(4)).toBe(3);
    expect(await q.popIfAtLeast(4, 4)).toBeNull();
    await q.add(4, 'd');
    await q.add(4, 'e');
    expect(await q.popIfAtLeast(4, 4)).toEqual(['b', 'a', 'c', 'd']);
    expect(await q.length(4)).toBe(1);
    await q.remove(4, 'e');
    expect(await q.length(4)).toBe(0);
    const codes = new RedisCodeRegistry(redis, 'test:code:');
    expect(await codes.claim('ABCDEF', 'r1')).toBe(true);
    expect(await codes.claim('ABCDEF', 'r2')).toBe(false);
    await codes.release('ABCDEF');
    expect(await codes.claim('ABCDEF', 'r3')).toBe(true);
  });

  it('runs matchmaking end-to-end through the Redis queue', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const server = await startTestServer({}, { redis });
    try {
      const auths = await Promise.all([guest(server.url), guest(server.url)]);
      const clients = auths.map((au) => new TestClient(server.url, au));
      await Promise.all(clients.map((c) => c.connected()));
      await Promise.all(clients.map((c) => c.emit('matchmaking:join', { playerCount: 2 })));
      await Promise.all(clients.map((c) => c.waitFor(() => !!c.state)));
      expect(clients[0]!.state!.id).toBe(clients[1]!.state!.id);
      clients.forEach((c) => c.close());
    } finally {
      await server.close();
    }
  });
});
