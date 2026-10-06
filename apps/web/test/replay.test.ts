import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GameEvent, GameState } from '@ludo/shared-types';
import { applyAction, applyEvents, createDiceEngine, createGame, seededRandom } from '@ludo/game-engine';
import { ReplayTransport } from '../src/game/replayTransport';

function recordedGame() {
  const players = [0, 1].map((i) => ({ id: `p${i}`, name: `P${i}`, avatar: 'comet', kind: 'human' as const }));
  const initial = createGame({ id: 'g', players, rules: { requireSixToStart: false, tokensPerPlayer: 1 }, now: 0 });
  let s = initial;
  const events: GameEvent[] = [];
  const dice = createDiceEngine({ random: seededRandom(5) });
  for (let i = 0; i < 14 && s.status === 'playing'; i += 1) {
    const cur = s.turn.playerId!;
    const action = s.turn.phase === 'roll' ? { type: 'ROLL' as const, playerId: cur } : { type: 'MOVE' as const, playerId: cur, tokenIndex: s.turn.legalMoves[0]!.tokenIndex };
    const r = applyAction(s, action, { now: 0, dice });
    if (!r.ok) throw new Error(r.error.code);
    s = r.state;
    events.push(...r.events);
  }
  return { initial, events };
}

describe('ReplayTransport', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function attach(t: ReplayTransport) {
    const seen = { snapshots: [] as GameState[], batches: [] as GameEvent[][] };
    t.subscribe({
      onSnapshot: (s) => seen.snapshots.push(s.state),
      onEvents: (e) => seen.batches.push(e),
      onFinish: () => undefined,
      onPresence: () => undefined,
      onPause: () => undefined,
      onEmote: () => undefined,
      onGone: () => undefined,
    });
    return seen;
  }

  it('starts at the initial state and steps one move (roll or token move) at a time', () => {
    const { initial, events } = recordedGame();
    const t = new ReplayTransport(initial, events);
    const seen = attach(t);
    t.requestSnapshot();
    expect(seen.snapshots[0]).toEqual(initial);
    t.next();
    expect(seen.batches[0]![0]!.type).toBe('DICE_ROLLED');
    t.next();
    expect(['TOKEN_MOVED', 'DICE_ROLLED']).toContain(seen.batches[1]![0]!.type);
    // Batches are contiguous and in order.
    const flat = seen.batches.flat();
    expect(flat).toEqual(events.slice(0, flat.length));
    expect(t.status.move).toBe(2);
  });

  it('steps back to exactly the recorded state before the latest move', () => {
    const { initial, events } = recordedGame();
    const t = new ReplayTransport(initial, events);
    const seen = attach(t);
    t.next();
    t.next();
    t.next();
    const applied = seen.batches.flat().length;
    const lastBatch = seen.batches.at(-1)!.length;
    t.previous();
    expect(seen.snapshots.at(-1)).toEqual(applyEvents(initial, events.slice(0, applied - lastBatch)));
    expect(t.status.move).toBe(2);
    t.restart();
    expect(seen.snapshots.at(-1)).toEqual(initial);
    expect(t.status.position).toBe(0);
  });

  it('plays to the end when the board reports idle, then stops', async () => {
    const { initial, events } = recordedGame();
    const t = new ReplayTransport(initial, events);
    const seen = attach(t);
    t.setSpeed(4);
    t.play();
    for (let i = 0; i < 100 && t.status.playing; i += 1) {
      t.notifyIdle();
      await vi.runAllTimersAsync();
    }
    expect(t.status.playing).toBe(false);
    expect(t.status.position).toBe(events.length);
    expect(seen.batches.flat()).toEqual(events);
  });

  it('refuses actions and never modifies the recorded game', async () => {
    const { initial, events } = recordedGame();
    const frozenInitial = structuredClone(initial);
    const frozenEvents = structuredClone(events);
    const t = new ReplayTransport(initial, events);
    attach(t);
    expect((await t.roll()).ok).toBe(false);
    expect((await t.move()).ok).toBe(false);
    expect((await t.emote()).ok).toBe(false);
    t.next();
    t.next();
    t.previous();
    t.requestSnapshot();
    expect(initial).toEqual(frozenInitial);
    expect(events).toEqual(frozenEvents);
  });
});
