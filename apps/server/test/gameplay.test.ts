import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomView } from '@ludo/shared-types';
import {
  connectGuests,
  currentPlayer,
  playToCompletion,
  sleep,
  startTestServer,
  type TestClient,
  type TestServer,
  testSettings,
} from './harness';

let ctx: TestServer;
const open: TestClient[] = [];

beforeAll(async () => {
  ctx = await startTestServer({ DICE_SEED: '20261002' });
});
afterAll(async () => {
  open.forEach((c) => c.close());
  await ctx?.close();
});

async function startGame(n: number, settings = testSettings({ maxPlayers: Math.max(2, n) })): Promise<TestClient[]> {
  const clients = await connectGuests(ctx.url, n);
  open.push(...clients);
  const [host, ...rest] = clients;
  const { room } = (await host!.emit('room:create', { settings })) as { room: RoomView };
  for (const c of rest) {
    expect((await c.emit('room:join', { code: room.code })).ok).toBe(true);
    expect((await c.emit('player:ready', { ready: true })).ok).toBe(true);
  }
  const started = await host!.emit('game:start', {});
  expect(started.ok).toBe(true);
  await Promise.all(clients.map((c) => c.waitFor(() => !!c.state, 10_000, 'game:start')));
  return clients;
}

const quick = (maxPlayers: number) =>
  testSettings({
    maxPlayers,
    tokensPerPlayer: 1,
    variants: { requireSixToStart: false, continueAfterWinner: false },
  });

describe('turn, dice and token synchronisation', () => {
  it('broadcasts identical dice results and moves to every player', async () => {
    const clients = await startGame(2);
    const current = clients.find((c) => c.myTurn())!;
    const other = clients.find((c) => c !== current)!;
    expect(current.state!.turn.playerId).toBe(current.id);

    const r = await current.roll();
    expect(r.ok).toBe(true);
    await Promise.all(clients.map((c) => c.waitFor(() => c.events.some((e) => e.type === 'DICE_ROLLED'))));
    const a = current.events.find((e) => e.type === 'DICE_ROLLED')!;
    const b = other.events.find((e) => e.type === 'DICE_ROLLED')!;
    expect(a).toEqual(b);
    expect(a.playerId).toBe(current.id);
    await other.waitFor(() => other.state!.seq === current.state!.seq);
    expect(other.state).toEqual(current.state);
  });
});

describe('anti-cheat validation', () => {
  it('rejects wrong-turn, fake dice, stale, duplicate, invalid token and forged game ids', async () => {
    const clients = await startGame(2);
    const current = clients.find((c) => c.myTurn())!;
    const other = clients.find((c) => c !== current)!;

    const wrongTurn = await other.roll();
    expect(!wrongTurn.ok && wrongTurn.error.code).toBe('NOT_YOUR_TURN');

    const stale = await current.roll({ expectedSeq: current.state!.seq + 5 });
    expect(!stale.ok && stale.error.code).toBe('STALE_STATE');

    const forgedGame = await current.roll({ gameId: 'game_doesnotexist' });
    expect(!forgedGame.ok && forgedGame.error.code).toBe('GAME_NOT_FOUND');

    const notUuid = await current.roll({ actionId: 'replay-me' });
    expect(!notUuid.ok && notUuid.error.code).toBe('VALIDATION');

    // A fake dice value or a forged player id is rejected outright, and changes nothing.
    const seqBefore = current.state!.seq;
    for (const forged of [{ value: 6 }, { value: '6' }, { value: 0 }, { value: 7 }, { value: -1 }, { value: 999 }, { playerId: other.id }]) {
      const r = await current.roll({ actionId: randomUUID(), ...forged });
      expect(!r.ok && r.error.code).toBe('VALIDATION');
    }
    const sync = await current.emit('game:sync', { gameId: current.state!.id });
    expect(sync.ok && sync.snapshot!.state.seq).toBe(seqBefore);

    // A clean roll: the server rolls for the socket's own user.
    const actionId = randomUUID();
    const rolled = await current.roll({ actionId });
    expect(rolled.ok).toBe(true);
    await current.waitFor(() => current.events.some((e) => e.type === 'DICE_ROLLED'));
    expect(current.events.find((e) => e.type === 'DICE_ROLLED')!.playerId).toBe(current.id);

    // Replaying the exact same command is rejected.
    const replay = await current.emit('dice:roll', { gameId: current.state!.id, actionId, expectedSeq: current.state!.seq });
    expect(!replay.ok && replay.error.code).toBe('DUPLICATE_ACTION');

    // A token move that is out of range never reaches the engine.
    const outOfRange = await current.move(9);
    expect(!outOfRange.ok && outOfRange.error.code).toBe('VALIDATION');

    // Non-participants cannot act or sync.
    const [outsider] = await connectGuests(ctx.url, 1);
    open.push(outsider!);
    const sneaky = await outsider!.emit('dice:roll', { gameId: current.state!.id, actionId: randomUUID(), expectedSeq: current.state!.seq });
    expect(!sneaky.ok && ['NOT_IN_GAME', 'NOT_YOUR_TURN'].includes(sneaky.error.code)).toBe(true);
    const peek = await outsider!.emit('game:sync', { gameId: current.state!.id });
    expect(!peek.ok && peek.error.code).toBe('NOT_IN_GAME');
  });

  it('rejects an illegal token choice and a duplicate move', async () => {
    const clients = await startGame(2, testSettings({ variants: { requireSixToStart: false } }));
    // Roll until someone has a move phase with at least one non-movable token.
    for (let i = 0; i < 200; i += 1) {
      const current = (await currentPlayer(clients))!;
      if (current.state!.turn.phase === 'move') {
        const legal = new Set(current.state!.turn.legalMoves.map((m) => m.tokenIndex));
        const illegal = [0, 1, 2, 3].find((t) => !legal.has(t));
        if (illegal !== undefined) {
          await sleep(2600); // let the socket rate-limit bucket refill after the fast setup loop
          const r = await current.move(illegal);
          expect(!r.ok && r.error.code).toBe('ILLEGAL_MOVE');
          const token = [...legal][0]!;
          const seq = current.state!.seq;
          const [first, second] = await Promise.all([
            current.move(token, { expectedSeq: seq }),
            current.move(token, { expectedSeq: seq }),
          ]);
          expect(first.ok).toBe(true);
          expect(!second.ok && ['STALE_STATE', 'WRONG_PHASE', 'NOT_YOUR_TURN'].includes(second.error.code)).toBe(true);
          return;
        }
      }
      const before = current.state!.seq;
      await current.act();
      await current.waitFor(() => current.state!.seq > before);
    }
    throw new Error('Never reached a move phase with an illegal option');
  });

  it('rate-limits floods of socket events', async () => {
    const [a] = await connectGuests(ctx.url, 1);
    open.push(a!);
    const results = await Promise.all(Array.from({ length: 60 }, () => a!.emit('matchmaking:leave', {})));
    expect(results.some((r) => !r.ok && r.error.code === 'RATE_LIMITED')).toBe(true);
  });
});

describe('complete games', () => {
  it('plays a 2-player game to completion; winner and stats are synchronised and recorded', async () => {
    const clients = await startGame(2, quick(2));
    await playToCompletion(clients);
    const [a, b] = clients;
    expect(a!.finished).toEqual(b!.finished);
    expect(a!.state).toEqual(b!.state);
    expect(a!.state!.status).toBe('finished');
    const winner = a!.finished![0]!;
    expect(a!.state!.rankings[0]).toBe(winner);

    const profiles = await ctx.server.prisma.profile.findMany({ where: { userId: { in: clients.map((c) => c.id) } } });
    expect(profiles.every((p) => p.gamesPlayed === 1)).toBe(true);
    expect(profiles.find((p) => p.userId === winner)!.gamesWon).toBe(1);
    const events = await ctx.server.prisma.gameEvent.count({ where: { gameId: a!.state!.id } });
    expect(events).toBe(a!.state!.seq);
    const game = await ctx.server.prisma.game.findUnique({ where: { id: a!.state!.id } });
    expect(game!.status).toBe('FINISHED');
  });

  it('keeps 8 players in 8 separate sessions synchronised through a full game', async () => {
    const clients = await startGame(8, quick(8));
    expect(clients[0]!.state!.armCount).toBe(8);
    expect(new Set(clients[0]!.state!.players.map((p) => p.color)).size).toBe(8);
    await playToCompletion(clients);
    const reference = clients[0]!.state!;
    for (const c of clients) {
      expect(c.state).toEqual(reference);
      expect(c.finished).toEqual(clients[0]!.finished);
    }
    expect(reference.status).toBe('finished');
    expect(reference.rankings).toHaveLength(8);
    // Every client saw every event exactly once, in order.
    for (const c of clients) expect(c.events.map((e) => e.seq)).toEqual(reference.seq ? Array.from({ length: reference.seq }, (_, i) => i + 1) : []);
  });

  it('lets bots play alongside a human in a private room', async () => {
    const [host] = await connectGuests(ctx.url, 1);
    open.push(host!);
    await host!.emit('room:create', { settings: quick(3) });
    await host!.emit('room:addBot', { difficulty: 'hard' });
    await host!.emit('room:addBot', { difficulty: 'easy' });
    expect((await host!.emit('game:start', {})).ok).toBe(true);
    await host!.waitFor(() => !!host!.state);
    await playToCompletion([host!]);
    expect(host!.state!.status).toBe('finished');
    const botEvents = host!.events.filter((e) => e.playerId?.startsWith('bot_') && e.type === 'DICE_ROLLED');
    expect(botEvents.length).toBeGreaterThan(0);
    // Games with fewer than two humans are unranked.
    const profile = await ctx.server.prisma.profile.findUnique({ where: { userId: host!.id } });
    expect(profile!.gamesPlayed).toBe(0);
    // The private room returns to the lobby for a rematch.
    await host!.waitFor(() => host!.room?.status === 'lobby', 5000, 'room back to lobby');
  });
});
