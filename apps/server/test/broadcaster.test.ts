import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { Adapter, type BroadcastOptions } from 'socket.io-adapter';
import { io as connect, type Socket } from 'socket.io-client';
import { channels, ioBroadcaster, type LudoServer } from '../src/socket/broadcaster';

/**
 * Behaves like @socket.io/redis-adapter: a cluster-wide join/leave is only published, and
 * even this instance's sockets join after the (simulated) Redis round trip.
 */
class AsyncJoinAdapter extends Adapter {
  override addSockets(opts: BroadcastOptions, rooms: string[]): void {
    if (opts.flags?.local) return super.addSockets(opts, rooms);
    setTimeout(() => super.addSockets(opts, rooms), 30);
  }
  override delSockets(opts: BroadcastOptions, rooms: string[]): void {
    if (opts.flags?.local) return super.delSockets(opts, rooms);
    setTimeout(() => super.delSockets(opts, rooms), 30);
  }
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
});

async function setup() {
  const http = createServer();
  const io = new Server(http, { adapter: AsyncJoinAdapter as unknown as never }) as unknown as LudoServer;
  io.on('connection', (socket) => void socket.join(channels.user(String(socket.handshake.auth.user))));
  await new Promise<void>((r) => http.listen(0, r));
  const url = `http://localhost:${(http.address() as AddressInfo).port}`;
  const client: Socket = connect(url, { auth: { user: 'u1' }, transports: ['websocket'], forceNew: true });
  await new Promise<void>((r) => client.once('connect', () => r()));
  // The connection handler's own socket.join is synchronous; give it a tick.
  await new Promise((r) => setTimeout(r, 20));
  cleanup.push(() => {
    client.close();
    void io.close();
  });
  return { io, client };
}

describe('broadcaster with an asynchronous (Redis-style) adapter', () => {
  it('delivers an event emitted immediately after seating a user in a channel', async () => {
    const { io, client } = await setup();
    const b = ioBroadcaster(io);
    const got = new Promise<unknown>((resolve) => client.on('game:start' as never, resolve as never));
    // Exactly what GameSessionManager.startFromRoom does: join, then emit at once.
    b.join('u1', channels.game('g1'));
    b.emit(channels.game('g1'), 'game:start', { gameId: 'g1' } as never);
    const result = await Promise.race([got, new Promise((r) => setTimeout(() => r('LOST'), 500))]);
    expect(result).not.toBe('LOST');
  });

  it('stops delivering immediately after leaving a channel', async () => {
    const { io, client } = await setup();
    const b = ioBroadcaster(io);
    b.join('u1', channels.game('g2'));
    await new Promise((r) => setTimeout(r, 60));
    let received = 0;
    client.on('game:emote' as never, (() => (received += 1)) as never);
    b.leave('u1', channels.game('g2'));
    b.emit(channels.game('g2'), 'game:emote', { gameId: 'g2', playerId: 'x', emote: 'wave' });
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(0);
  });
});
