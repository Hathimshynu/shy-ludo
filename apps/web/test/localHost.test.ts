import { describe, expect, it } from 'vitest';
import type { GameState } from '@ludo/shared-types';
import { DEFAULT_VARIANTS, applyEvents, seededRandom } from '@ludo/game-engine';
import { type HostOutbound, LocalGameHost, SOLO_HUMAN_ID, type SoloConfig, soloPlayers } from '../src/game/localHost';

const config = (over: Partial<SoloConfig> = {}): SoloConfig => ({
  playerName: 'Tester',
  avatar: 'comet',
  opponents: 3,
  difficulty: 'hard',
  turnTimeSeconds: 0,
  tokensPerPlayer: 1,
  variants: { ...DEFAULT_VARIANTS, requireSixToStart: false, continueAfterWinner: false },
  ...over,
});

/** Drive a solo game like the browser does: mirror state from messages, act on our turn. */
async function play(cfg: SoloConfig, seed: number) {
  const out: HostOutbound[] = [];
  let mirror: GameState | null = null;
  let finished: string[] | null = null;
  let requestId = 1;
  const host = new LocalGameHost(
    (m) => {
      out.push(m);
      if (m.type === 'snapshot') mirror = m.state;
      if (m.type === 'events') mirror = applyEvents(mirror!, m.events);
      if (m.type === 'finish') finished = m.rankings;
    },
    { random: seededRandom(seed), botDelayMs: 0 },
  );
  host.handle({ type: 'init', config: cfg });
  for (let i = 0; i < 20_000 && !finished; i += 1) {
    const s = mirror as GameState | null;
    if (!s) break;
    if (s.turn.playerId === SOLO_HUMAN_ID) {
      if (s.turn.phase === 'roll') host.handle({ type: 'roll', requestId: requestId++, expectedSeq: s.seq });
      else host.handle({ type: 'move', requestId: requestId++, expectedSeq: s.seq, tokenIndex: s.turn.legalMoves[0]!.tokenIndex });
    } else {
      // Tell the host the board caught up, then let the bot timer fire.
      host.handle({ type: 'idle', seq: s.seq });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  host.dispose();
  return { out, mirror: mirror as GameState | null, finished: finished as string[] | null };
}

describe('LocalGameHost (solo mode)', () => {
  it('seats the human plus 1–7 AI opponents', () => {
    expect(soloPlayers(config({ opponents: 1 }))).toHaveLength(2);
    expect(soloPlayers(config({ opponents: 7 }))).toHaveLength(8);
    expect(soloPlayers(config({ opponents: 7 })).filter((p) => p.kind === 'bot').every((p) => p.botLevel === 'hard')).toBe(true);
  });

  it('plays a full game against AI and reports a winner', async () => {
    const { finished, mirror, out } = await play(config(), 7);
    expect(finished).not.toBeNull();
    expect(mirror!.status).toBe('finished');
    expect(out.some((m) => m.type === 'save' && m.state === null)).toBe(true);
    // Bots really played.
    const botMoves = out.flatMap((m) => (m.type === 'events' ? m.events : [])).filter((e) => e.type === 'TOKEN_MOVED' && e.playerId !== SOLO_HUMAN_ID);
    expect(botMoves.length).toBeGreaterThan(0);
  });

  it('works for an 8-player solo table', async () => {
    const { finished } = await play(config({ opponents: 7 }), 3);
    expect(finished).not.toBeNull();
  });

  it('rejects stale and out-of-turn actions', () => {
    const out: HostOutbound[] = [];
    const host = new LocalGameHost((m) => out.push(m), { random: seededRandom(1), botDelayMs: 0 });
    host.handle({ type: 'init', config: config() });
    host.handle({ type: 'roll', requestId: 1, expectedSeq: 99 });
    const ack = out.find((m) => m.type === 'ack') as Extract<HostOutbound, { type: 'ack' }>;
    expect(ack.result.ok).toBe(false);
    if (!ack.result.ok) expect(ack.result.error.code).toBe('STALE_STATE');
    host.handle({ type: 'move', requestId: 2, expectedSeq: 0, tokenIndex: 0 });
    const ack2 = out.filter((m) => m.type === 'ack')[1] as Extract<HostOutbound, { type: 'ack' }>;
    expect(ack2.result.ok).toBe(false);
    host.dispose();
  });

  it('resumes a saved game instead of starting a new one', () => {
    const out: HostOutbound[] = [];
    const first = new LocalGameHost((m) => out.push(m), { random: seededRandom(2), botDelayMs: 0 });
    first.handle({ type: 'init', config: config() });
    const saved = (out.find((m) => m.type === 'snapshot') as Extract<HostOutbound, { type: 'snapshot' }>).state;
    first.dispose();
    const out2: HostOutbound[] = [];
    const second = new LocalGameHost((m) => out2.push(m));
    second.handle({ type: 'init', config: config(), saved });
    const resumed = (out2.find((m) => m.type === 'snapshot') as Extract<HostOutbound, { type: 'snapshot' }>).state;
    expect(resumed.id).toBe(saved.id);
    second.dispose();
  });
});
