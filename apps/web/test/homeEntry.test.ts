import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AckResult, GameEvent, GameState } from '@ludo/shared-types';
import { type ArmCount, applyAction, createBoard, createGame, createSequenceDice, finishProgress } from '@ludo/game-engine';
import type { TransportHandlers } from '../src/game/transport';
import { HOME_ENTRY_MS, HOME_ENTRY_REDUCED_MS, HOME_REST, homeEntryPose, selectableBreath, SELECTABLE_PERIOD_MS } from '../src/game/motion';

describe('home-entry animation curve', () => {
  it('starts and ends at rest and never runs past its duration', () => {
    expect(homeEntryPose(0).lift).toBe(0);
    expect(homeEntryPose(HOME_ENTRY_MS)).toBe(HOME_REST);
    expect(homeEntryPose(HOME_ENTRY_MS + 5000)).toBe(HOME_REST);
    expect(homeEntryPose(-1)).toBe(HOME_REST);
    expect(homeEntryPose(HOME_ENTRY_REDUCED_MS, true)).toBe(HOME_REST);
    expect(HOME_ENTRY_MS).toBeGreaterThanOrEqual(800);
    expect(HOME_ENTRY_MS).toBeLessThanOrEqual(1500);
  });

  it('pauses briefly, rises, turns and settles', () => {
    expect(homeEntryPose(HOME_ENTRY_MS * 0.05).lift).toBe(0); // brief pause
    const peak = homeEntryPose(HOME_ENTRY_MS * 0.5);
    expect(peak.lift).toBeGreaterThan(0.3);
    expect(peak.lift).toBeLessThan(0.6);
    expect(peak.glow).toBeGreaterThan(0.5);
    expect(homeEntryPose(HOME_ENTRY_MS * 0.9).spin).toBeGreaterThan(Math.PI);
    expect(homeEntryPose(HOME_ENTRY_MS * 0.99).lift).toBeLessThan(0.05); // settled
  });

  it('keeps essential feedback but no turn or tilt with Reduce Animations', () => {
    const mid = homeEntryPose(HOME_ENTRY_REDUCED_MS / 2, true);
    expect(mid.lift).toBeGreaterThan(0);
    expect(mid.lift).toBeLessThan(0.2);
    expect(mid.spin).toBe(0);
    expect(mid.tilt).toBe(0);
  });

  it('breathes slowly for legal tokens (no flashing)', () => {
    expect(selectableBreath(0)).toBeCloseTo(0);
    expect(selectableBreath(SELECTABLE_PERIOD_MS / 2)).toBeCloseTo(1);
    expect(SELECTABLE_PERIOD_MS).toBeGreaterThanOrEqual(1200);
  });
});

/**
 * Full path through the GameDirector: the engine emits TOKEN_MOVED into home →
 * the director plays the move, then starts the home celebration → it finishes →
 * the game state is exactly what the authority sent. Animation never edits state.
 */
describe('home entry through the GameDirector', () => {
  const store: Record<string, string> = {};
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', { hidden: false, documentElement: { classList: { toggle: () => undefined } } });
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

  it('emits the home event, animates, and leaves the authoritative state untouched', async () => {
    const { GameDirector } = await import('../src/game/director');
    const { useGame } = await import('../src/store/gameStore');
    const { presentation } = await import('../src/store/presentationStore');
    const { tokenKey, PLAYER_HEX } = await import('../src/game/layout');

    const players = [0, 1].map((i) => ({ id: `p${i}`, name: `P${i}`, avatar: 'comet', kind: 'human' as const }));
    let s = createGame({ id: 'g', players, rules: { autoMoveSingleOption: false }, now: 0 });
    s.status = 'playing';
    const finish = finishProgress(createBoard(s.armCount as ArmCount));
    s.players[0]!.tokens = [finish - 2, -1, -1, -1];
    const rolled = applyAction(s, { type: 'ROLL', playerId: 'p0' }, { now: 0, dice: createSequenceDice([2]) });
    if (!rolled.ok) throw new Error(rolled.error.code);
    s = rolled.state;
    expect(s.turn.legalMoves.map((m) => m.tokenIndex)).toEqual([0]);

    let handlers: TransportHandlers | null = null;
    let authoritative: GameState = s;
    let sent: GameEvent[] = [];
    const transport = {
      mode: 'solo' as const,
      subscribe: (h: NonNullable<typeof handlers>) => ((handlers = h), () => undefined),
      requestSnapshot: () => handlers!.onSnapshot({ state: authoritative, connected: {}, paused: false }),
      roll: async (): Promise<AckResult<{ seq?: number }>> => ({ ok: true }),
      move: async (tokenIndex: number): Promise<AckResult<{ seq?: number }>> => {
        const r = applyAction(authoritative, { type: 'MOVE', playerId: 'p0', tokenIndex }, { now: 0, dice: createSequenceDice([1]) });
        if (!r.ok) return { ok: false, error: r.error };
        authoritative = r.state;
        sent = r.events;
        queueMicrotask(() => handlers!.onEvents(r.events));
        return { ok: true, seq: r.state.seq };
      },
      leave: async () => undefined,
      emote: async (): Promise<AckResult> => ({ ok: true }),
      notifyIdle: () => undefined,
      now: () => 0,
    };

    const director = new GameDirector(transport, 'p0');
    director.start();
    const key = tokenKey('p0', 0);
    const restBefore = presentation.getState().tokens[key]!.rest;

    await director.move(0);
    await vi.advanceTimersByTimeAsync(0);

    // The engine — not the animation — decided the token reached home.
    const moved = sent.find((e) => e.type === 'TOKEN_MOVED');
    expect(moved && moved.type === 'TOKEN_MOVED' && moved.payload.to).toBe(finish);
    expect(useGame.getState().state).toEqual(authoritative);
    expect(presentation.getState().effects.some((e) => e.kind === 'home')).toBe(false);

    // Walk the two steps of the path; then the home celebration starts.
    await vi.advanceTimersByTimeAsync(2 * 170 + 60);
    const token = presentation.getState().tokens[key]!;
    expect(token.homeAt).toBeDefined();
    expect(token.finished).toBe(true);
    expect(token.rest).not.toEqual(restBefore);
    const effect = presentation.getState().effects.find((e) => e.kind === 'home');
    expect(effect).toBeDefined();
    expect(effect!.color).toBe(PLAYER_HEX[s.players[0]!.color]);
    expect(effect!.dur).toBe(HOME_ENTRY_MS);
    expect(homeEntryPose(performance.now() - token.homeAt! + HOME_ENTRY_MS * 0.4).lift).toBeGreaterThan(0);

    // Let everything finish: the effect is removed, the board is idle again.
    await vi.advanceTimersByTimeAsync(HOME_ENTRY_MS + 3000);
    expect(presentation.getState().effects).toEqual([]);
    expect(homeEntryPose(performance.now() - token.homeAt!)).toBe(HOME_REST);
    const g = useGame.getState();
    expect(g.animating).toBe(false);
    expect(g.state).toEqual(authoritative);
    expect(g.visual).toEqual(authoritative);
    expect(g.visual!.players[0]!.tokens[0]).toBe(finish);
    // The resting position after the celebration is unchanged by it.
    expect(presentation.getState().tokens[key]!.rest).toEqual(token.rest);

    director.stop();
  });
});
