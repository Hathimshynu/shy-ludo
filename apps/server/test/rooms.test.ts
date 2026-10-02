import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomView } from '@ludo/shared-types';
import { connectGuests, startTestServer, type TestClient, type TestServer, testSettings } from './harness';

let ctx: TestServer;
const open: TestClient[] = [];

beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  open.forEach((c) => c.close());
  await ctx?.close();
});

async function guests(n: number) {
  const c = await connectGuests(ctx.url, n);
  open.push(...c);
  return c;
}

describe('connections', () => {
  it('rejects unauthenticated sockets', async () => {
    const { io } = await import('socket.io-client');
    const s = io(ctx.url, { auth: { token: 'forged' }, transports: ['websocket'], reconnection: false, forceNew: true });
    const err = await new Promise<Error>((resolve) => s.once('connect_error', resolve));
    expect(err.message).toBe('UNAUTHORIZED');
    s.close();
  });

  it('sends an empty session:restore to idle users', async () => {
    const [a] = await guests(1);
    await a!.waitFor(() => a!.received.some((r) => r.event === 'session:restore'));
    expect(a!.received.find((r) => r.event === 'session:restore')!.payload).toEqual({ room: null, game: null });
  });
});

describe('private rooms', () => {
  it('creates a room with a 6-character code and lets a friend join', async () => {
    const [host, friend] = await guests(2);
    const created = await host!.emit('room:create', { settings: testSettings({ maxPlayers: 8 }) });
    expect(created.ok).toBe(true);
    const room = (created as { room: RoomView }).room;
    expect(room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(room.seats).toHaveLength(1);
    expect(room.seats[0]).toMatchObject({ id: host!.id, isHost: true });

    const joined = await friend!.emit('room:join', { code: room.code.toLowerCase() });
    expect(joined.ok).toBe(true);
    await host!.waitFor(() => host!.room?.seats.length === 2, 5000, 'host sees friend');
    expect(host!.room!.seats.map((s) => s.id)).toEqual([host!.id, friend!.id]);

    // Joining twice is idempotent.
    const again = await friend!.emit('room:join', { code: room.code });
    expect(again.ok).toBe(true);
    expect((again as { room: RoomView }).room.seats).toHaveLength(2);
  });

  it('rejects invalid and unknown room codes', async () => {
    const [a] = await guests(1);
    const invalid = await a!.emit('room:join', { code: 'abc' });
    expect(!invalid.ok && invalid.error.code).toBe('VALIDATION');
    const unknown = await a!.emit('room:join', { code: 'ZZZZZZ' });
    expect(!unknown.ok && unknown.error.code).toBe('ROOM_NOT_FOUND');
  });

  it('rejects joining a full room', async () => {
    const [host, b, c] = await guests(3);
    const created = (await host!.emit('room:create', { settings: testSettings({ maxPlayers: 2 }) })) as { room: RoomView };
    expect((await b!.emit('room:join', { code: created.room.code })).ok).toBe(true);
    const full = await c!.emit('room:join', { code: created.room.code });
    expect(!full.ok && full.error.code).toBe('ROOM_FULL');
  });

  it('gives the host control: settings, bots, kick — and nobody else', async () => {
    const [host, guestA] = await guests(2);
    const { room } = (await host!.emit('room:create', { settings: testSettings() })) as { room: RoomView };
    await guestA!.emit('room:join', { code: room.code });

    const notHost = await guestA!.emit('room:settings', { settings: testSettings({ maxPlayers: 6 }) });
    expect(!notHost.ok && notHost.error.code).toBe('NOT_HOST');
    const notHostBot = await guestA!.emit('room:addBot', { difficulty: 'hard' });
    expect(!notHostBot.ok && notHostBot.error.code).toBe('NOT_HOST');

    const changed = (await host!.emit('room:settings', { settings: testSettings({ maxPlayers: 6, turnTimeSeconds: 15 }) })) as {
      room: RoomView;
    };
    expect(changed.room.settings).toMatchObject({ maxPlayers: 6, turnTimeSeconds: 15 });

    const withBot = (await host!.emit('room:addBot', { difficulty: 'expert' })) as { room: RoomView };
    const bot = withBot.room.seats.find((s) => s.kind === 'bot')!;
    expect(bot).toMatchObject({ botLevel: 'expert', ready: true });
    const noBot = (await host!.emit('room:removeBot', { botId: bot.id })) as { room: RoomView };
    expect(noBot.room.seats.some((s) => s.kind === 'bot')).toBe(false);

    const kicked = guestA!.waitForEvent('room:kicked');
    expect((await host!.emit('room:kick', { userId: guestA!.id })).ok).toBe(true);
    await kicked;
    await host!.waitFor(() => host!.room?.seats.length === 1);
  });

  it('requires everyone ready and at least two seats before starting', async () => {
    const [host, b] = await guests(2);
    const { room } = (await host!.emit('room:create', { settings: testSettings() })) as { room: RoomView };
    const alone = await host!.emit('game:start', {});
    expect(!alone.ok && alone.error.code).toBe('NOT_ENOUGH_PLAYERS');
    await b!.emit('room:join', { code: room.code });
    const notReady = await host!.emit('game:start', {});
    expect(!notReady.ok && notReady.error.code).toBe('NOT_READY');
    const notHostStart = await b!.emit('game:start', {});
    expect(!notHostStart.ok && notHostStart.error.code).toBe('NOT_HOST');
    expect((await b!.emit('player:ready', { ready: true })).ok).toBe(true);
    const started = await host!.emit('game:start', {});
    expect(started.ok).toBe(true);
    await Promise.all([host!.waitFor(() => !!host!.state), b!.waitFor(() => !!b!.state)]);
    expect(host!.state!.id).toBe((started as { gameId: string }).gameId);
    expect(b!.state).toEqual(host!.state);

    const lateJoiner = (await guests(1))[0]!;
    const late = await lateJoiner.emit('room:join', { code: room.code });
    expect(!late.ok && late.error.code).toBe('ROOM_IN_GAME');
  });

  it('transfers host when the host leaves, and closes empty rooms', async () => {
    const [host, b] = await guests(2);
    const { room } = (await host!.emit('room:create', { settings: testSettings() })) as { room: RoomView };
    await b!.emit('room:join', { code: room.code });
    await host!.emit('room:leave', {});
    await b!.waitFor(() => b!.room?.hostId === b!.id, 5000, 'host transfer');
    expect((await b!.emit('room:leave', {})).ok).toBe(true);
    const gone = await host!.emit('room:join', { code: room.code });
    expect(!gone.ok && gone.error.code).toBe('ROOM_NOT_FOUND');
  });
});
