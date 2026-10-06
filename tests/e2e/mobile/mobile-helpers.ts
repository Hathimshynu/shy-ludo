import { type Browser, type Locator, type Page, expect } from '@playwright/test';
import { gameState } from '../helpers';
import { E2E_DICE_SEED, E2E_DICE_SEED_KEY } from '../seed';

export const PORTRAIT = [
  { name: '320', width: 320, height: 568 },
  { name: '360', width: 360, height: 800 },
  { name: '375', width: 375, height: 812 },
  { name: '390', width: 390, height: 844 },
  { name: '414', width: 414, height: 896 },
  { name: '430', width: 430, height: 932 },
  { name: '768 tablet', width: 768, height: 1024 },
] as const;

export const LANDSCAPE = { name: 'landscape 844×390', width: 844, height: 390 } as const;

const SETTINGS = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    state: { soundOn: false, musicOn: false, reduceMotion: true, quality: 'low', showEmotes: true, haptics: true, ...over },
    version: 2,
  });

/** A phone context (touch, coarse pointer) with quiet, fast settings. */
export async function phone(
  browser: Browser,
  viewport: { width: number; height: number },
  opts: { settings?: Record<string, unknown>; userAgent?: string } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
  });
  await context.addInitScript(
    ([s, key, seed]) => {
      try {
        localStorage.setItem('ludo-nova:settings', s);
        localStorage.setItem(key, seed);
      } catch {
        /* ignore */
      }
    },
    [SETTINGS(opts.settings), E2E_DICE_SEED_KEY, E2E_DICE_SEED] as const,
  );
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });
  return page;
}

/** No horizontal scrolling and nothing wider than the viewport. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, width } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scrollWidth, 'page must not scroll horizontally').toBeLessThanOrEqual(width + 1);
}

/** The element is fully inside the visible viewport. */
export async function expectInViewport(page: Page, locator: Locator, label: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} should be rendered`).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.y, `${label} top edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label} right edge`).toBeLessThanOrEqual(vp.width + 1);
  expect(box!.y + box!.height, `${label} bottom edge`).toBeLessThanOrEqual(vp.height + 1);
}

/** Comfortable touch target (~44×44 CSS px). */
export async function expectTouchTarget(locator: Locator, label: string, min = 44): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} should be rendered`).not.toBeNull();
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(min - 0.5);
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(min - 0.5);
}

/** Start a quick solo game (1 token each, release on 1 or 6). */
export async function startSolo(page: Page, opts: { opponents?: number; tokens?: number } = {}): Promise<void> {
  await page.goto('/solo');
  await page
    .getByRole('radiogroup', { name: 'Number of AI opponents' })
    .getByRole('radio', { name: String(opts.opponents ?? 1), exact: true })
    .click();
  await page.getByRole('radiogroup', { name: 'AI difficulty' }).getByRole('radio', { name: 'Easy' }).click();
  await page
    .getByRole('radiogroup', { name: 'Tokens per player' })
    .getByRole('radio', { name: String(opts.tokens ?? 1), exact: true })
    .click();
  await page.getByText('Rule variants').click();
  await page.getByRole('switch', { name: /Six to start/ }).uncheck();
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page).toHaveURL(/\/solo\/game$/);
  await page.waitForFunction(() => !!window.__ludo?.game().state, null, { polling: 200 });
}

/** Wait until it is my turn and the UI accepts input. */
export async function waitForMyTurn(page: Page, phase: 'roll' | 'move' | 'any' = 'any', timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    (wanted) => {
      const g = window.__ludo?.game();
      const v = g?.visual;
      if (!g || !v || !g.state) return false;
      const ready = !g.pending && !g.animating && v.seq === g.state.seq && v.status === 'playing' && v.turn.playerId === g.myId;
      return ready && (wanted === 'any' || v.turn.phase === wanted);
    },
    phase,
    { timeout, polling: 200 },
  );
}

/** Tap the die (touch) and wait for the authoritative result. */
export async function tapRoll(page: Page): Promise<void> {
  const before = (await gameState(page))!.seq;
  await page.getByRole('button', { name: 'Roll the dice' }).tap();
  await page.waitForFunction((seq) => (window.__ludo?.game().state?.seq ?? 0) > seq, before, { timeout: 20_000, polling: 200 });
}

/** Play solo through touch until the game ends (roll by tapping the die, move with the move chips). */
export async function playSoloToEnd(page: Page, maxSteps = 600): Promise<void> {
  for (let i = 0; i < maxSteps; i += 1) {
    const finished = await page.evaluate(() => window.__ludo?.game().visual?.status === 'finished');
    if (finished) return;
    const s = await page.evaluate(() => {
      const g = window.__ludo!.game();
      const v = g.visual!;
      const ready = !g.pending && !g.animating && v.seq === g.state!.seq && v.turn.playerId === g.myId && v.status === 'playing';
      return ready ? v.turn.phase : null;
    });
    if (s === 'roll') await tapRoll(page);
    else if (s === 'move') {
      const before = (await gameState(page))!.seq;
      await page.locator('.move-chip').first().tap();
      await page.waitForFunction((seq) => (window.__ludo?.game().state?.seq ?? 0) > seq, before, { timeout: 20_000, polling: 200 });
    } else await page.waitForTimeout(150);
  }
  throw new Error('Solo game did not finish');
}
