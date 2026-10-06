import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AckResult, GameEvent, GameState } from '@ludo/shared-types';
import { applyAction, applyEvents, createGame, createSequenceDice } from '@ludo/game-engine';
import type { TransportHandlers } from '../src/game/transport';

/**
 * Event-stream integrity in the GameDirector: the client applies only the next expected
 * event, ignores duplicates, and on a gap (or an event it cannot apply) resynchronises
 * from the authority instead of continuing with a corrupted state.
 */
describe('GameDirector sequence handling', () => {
  const store: Record<string, string> = {};
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', { hidden: true, documentElement: { classList: { toggle: () => undefined } } });
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    });
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A short authoritative history: snapshot at seq s0, then events e1..eN. */
  function history() {
    const players = [0, 1].map((i) => ({ id: `p${i}`, name: `P${i}`, avatar: 'comet', kind: 'human' as const }));
    const start = createGame({ id: 'g', players, rules: { requireSixToStart: false, tokensPerPlayer: 1 }, now: 0 });
    let s = start;
    const events: GameEvent[] = [];
    const dice = createSequenceDice([3, 4, 2, 5, 1, 3, 4, 2]);
    while (events.length < 8) {
      const cur = s.turn.playerId!;
      const action = s.turn.phase === 'roll' ? { type: 'ROLL' as const, playerId: cur } : { type: 'MOVE' as const, playerId: cur, tokenIndex: s.turn.legalMoves[0]!.tokenIndex };
      const r = applyAction(s, action, { now: 0, dice });
      if (!r.ok) throw new Error(r.error.code);
      s = r.state;
      events.push(...r.events);
    }
    return { start, events, final: s };
  }

  async function setup(start: GameState) {
    const { GameDirector } = await import('../src/game/director');
    const { useGame } = await import('../src/store/gameStore');
    let handlers: TransportHandlers | null = null;
    let snapshots = 0;
    let current = start;
    const transport = {
      mode: 'online' as const,
      subscribe: (h: TransportHandlers) => ((handlers = h), () => undefined),
      requestSnapshot: () => {
        snapshots += 1;
        handlers!.onSnapshot({ state: current, connected: {}, paused: false });
      },
      roll: async (): Promise<AckResult<{ seq?: number }>> => ({ ok: true }),
      move: async (): Promise<AckResult<{ seq?: number }>> => ({ ok: true }),
      leave: async () => undefined,
      emote: async (): Promise<AckResult> => ({ ok: true }),
      notifyIdle: () => undefined,
      now: () => 0,
    };
    const director = new GameDirector(transport, 'p0');
    director.start();
    return {
      director,
      useGame,
      push: (events: GameEvent[]) => handlers!.onEvents(events),
      setAuthority: (s: GameState) => (current = s),
      snapshots: () => snapshots,
    };
  }

  it('applies events in order and ignores duplicates', async () => {
    const { start, events } = history();
    const t = await setup(start);
    const initialSnapshots = t.snapshots();
    t.push(events.slice(0, 3));
    t.push(events.slice(1, 3)); // duplicates (already applied)
    t.push(events.slice(3));
    await vi.runAllTimersAsync();
    expect(t.useGame.getState().state).toEqual(applyEvents(start, events));
    expect(t.useGame.getState().visual).toEqual(applyEvents(start, events));
    expect(t.snapshots()).toBe(initialSnapshots); // no resync needed
    t.director.stop();
  });

  it('a snapshot arriving mid-animation wins over the animation that was playing', async () => {
    const { start, events, final } = history();
    const doc = globalThis.document as unknown as { hidden: boolean };
    doc.hidden = false; // animations actually wait
    try {
      const t = await setup(start);
      t.push(events.slice(0, 3)); // starts animating (dice roll, move, …)
      await vi.advanceTimersByTimeAsync(50); // mid-animation
      t.setAuthority(final);
      t.director['transport'].requestSnapshot(); // e.g. a resync after reconnect
      await vi.runAllTimersAsync();
      expect(t.useGame.getState().state).toEqual(final);
      // The interrupted animation must not overwrite the fresh snapshot with stale state.
      expect(t.useGame.getState().visual).toEqual(final);
      expect(t.useGame.getState().animating).toBe(false);
      t.director.stop();
    } finally {
      doc.hidden = true;
    }
  });

  it('detects a missing event (1, 2, -, 4) and resynchronises instead of continuing', async () => {
    const { start, events, final } = history();
    const t = await setup(start);
    const initialSnapshots = t.snapshots();
    t.push(events.slice(0, 2)); // seq 1, 2
    await vi.runAllTimersAsync();
    const beforeGap = t.useGame.getState().state!;
    t.setAuthority(final); // the server has moved on
    t.push(events.slice(3, 4)); // seq 4 arrives, seq 3 is missing
    await vi.runAllTimersAsync();
    // The out-of-order event was not applied on top of the old state...
    expect(t.snapshots()).toBe(initialSnapshots + 1);
    // ...and the client now holds the authoritative state, not a corrupted one.
    expect(beforeGap.seq).toBe(events[1]!.seq);
    expect(t.useGame.getState().state).toEqual(final);
    expect(t.useGame.getState().visual).toEqual(final);
    t.director.stop();
  });
});
