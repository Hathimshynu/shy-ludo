import { type Browser, type BrowserContext, type Page, expect } from '@playwright/test';
import type { GameState } from '@ludo/shared-types';

interface LudoHook {
  game: () => {
    state: GameState | null;
    visual: GameState | null;
    myId: string | null;
    pending: boolean;
    animating: boolean;
    paused: boolean;
  };
  lobby: () => { room: { code: string } | null };
  socket: { emit: (event: string, payload: unknown) => Promise<{ ok: boolean; error?: { code: string } }> };
}

declare global {
  interface Window {
    __ludo?: LudoHook;
  }
}

/** Fast, quiet settings so software-rendered WebGL keeps up. */
const FAST_SETTINGS = JSON.stringify({
  state: { soundOn: false, musicOn: false, sfxVolume: 0, musicVolume: 0, reduceMotion: true, quality: 'low', showEmotes: true },
  version: 1,
});

export async function newPlayer(browser: Browser, viewport = { width: 1280, height: 800 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((settings) => {
    try {
      localStorage.setItem('ludo-nova:settings', settings);
    } catch {
      /* ignore */
    }
  }, FAST_SETTINGS);
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });
  return { context, page };
}

export async function signInAsGuest(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await expect(page).toHaveURL(/\/play$/);
  await page.waitForFunction(() => !!window.__ludo && (window.__ludo.socket as unknown as { connected: boolean }).connected, null, {
    timeout: 30_000,
  });
}

export function gameState(page: Page): Promise<GameState | null> {
  return page.evaluate(() => window.__ludo?.game().state ?? null);
}

/** True when the UI would let this player act right now. */
export function canAct(page: Page): Promise<{ can: boolean; phase: string | null; finished: boolean }> {
  return page.evaluate(() => {
    const g = window.__ludo?.game();
    const v = g?.visual;
    if (!g || !v || !g.state) return { can: false, phase: null, finished: false };
    const can =
      !g.pending && !g.animating && !g.paused && v.seq === g.state.seq && v.status === 'playing' && v.turn.playerId === g.myId;
    return { can, phase: v.turn.phase, finished: v.status === 'finished' };
  });
}

/** Take one action through the real UI (keyboard: Space rolls, 1–4 moves). */
export async function actViaUi(page: Page): Promise<boolean> {
  const { can, phase } = await canAct(page);
  if (!can) return false;
  const before = (await gameState(page))!.seq;
  if (phase === 'roll') {
    await page.getByRole('button', { name: 'Roll the dice' }).click();
  } else {
    const legal = await page.evaluate(() => window.__ludo!.game().visual!.turn.legalMoves.map((m) => m.tokenIndex));
    await page.keyboard.press(String(legal[0]! + 1));
  }
  await page.waitForFunction((seq) => (window.__ludo?.game().state?.seq ?? 0) > seq, before, { timeout: 20_000 });
  return true;
}

/**
 * Take one action through this browser's own Socket.IO connection (same transport and
 * server path as the UI, minus the synthetic click). Used for the 8-session test where
 * eight software-rendered WebGL pages make synthetic input very slow.
 */
export async function actViaSocket(page: Page): Promise<boolean> {
  const { can } = await canAct(page);
  if (!can) return false;
  const before = (await gameState(page))!.seq;
  const result = await page.evaluate(async () => {
    const g = window.__ludo!.game();
    const s = g.state!;
    const base = { gameId: s.id, actionId: crypto.randomUUID(), expectedSeq: s.seq };
    const r =
      s.turn.phase === 'roll'
        ? await window.__ludo!.socket.emit('dice:roll', base)
        : await window.__ludo!.socket.emit('token:move', { ...base, tokenIndex: s.turn.legalMoves[0]!.tokenIndex });
    return r.ok ? 'OK' : r.error!.code;
  });
  if (result !== 'OK') return result === 'STALE_STATE' || result === 'RATE_LIMITED';
  await page.waitForFunction((seq) => (window.__ludo?.game().state?.seq ?? 0) > seq, before, { timeout: 30_000 });
  return true;
}

/** Let every player act on their turn until `done()` or the game ends. */
export async function playUntil(
  pages: Page[],
  done: () => Promise<boolean>,
  maxActions = 2_000,
  act: (page: Page) => Promise<boolean> = actViaUi,
): Promise<void> {
  for (let i = 0; i < maxActions; i += 1) {
    if (await done()) return;
    let acted = false;
    for (const p of pages) {
      if (await act(p)) {
        acted = true;
        break;
      }
    }
    if (!acted) await pages[0]!.waitForTimeout(150);
  }
  throw new Error('playUntil: condition not reached');
}

/** Wait until every page shows the same authoritative state (same seq), then compare them. */
export async function expectSynchronised(pages: Page[]): Promise<GameState> {
  await expect
    .poll(async () => new Set(await Promise.all(pages.map(async (p) => (await gameState(p))?.seq))).size, { timeout: 30_000 })
    .toBe(1);
  const states = await Promise.all(pages.map(gameState));
  for (const s of states) expect(s).toEqual(states[0]);
  return states[0]!;
}

export async function createRoom(
  page: Page,
  opts: { players: number; tokens?: number; quick?: boolean },
): Promise<string> {
  await page.goto('/friends');
  await page.getByRole('radiogroup', { name: 'Players' }).getByRole('radio', { name: String(opts.players), exact: true }).click();
  if (opts.tokens) {
    await page.getByRole('radiogroup', { name: 'Tokens per player' }).getByRole('radio', { name: String(opts.tokens), exact: true }).click();
  }
  if (opts.quick) {
    await page.getByText('Rule variants').click();
    await page.getByRole('switch', { name: /Six to start/ }).uncheck();
    await page.getByRole('switch', { name: /Rank everyone/ }).uncheck();
  }
  await page.getByRole('button', { name: 'Create Private Room' }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{6}$/);
  return page.url().split('/').pop()!;
}

export async function joinRoom(page: Page, code: string): Promise<void> {
  await page.goto(`/room/${code}`);
  await expect(page.getByRole('heading', { name: new RegExp(`Room code`) }).or(page.locator('.room-code'))).toBeVisible();
  await page.getByRole('button', { name: 'I’m ready' }).click();
  await expect(page.getByRole('button', { name: 'Not ready' })).toBeVisible();
}
