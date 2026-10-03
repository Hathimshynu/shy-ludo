import { type Browser, type Page, expect, test } from '@playwright/test';
import { expectInViewport, expectNoHorizontalScroll, phone, startSolo, waitForMyTurn } from './mobile-helpers';

/**
 * Board framing at phone, tablet and desktop sizes: the whole board is on screen, no HUD
 * element covers the board or any token, the board uses the space it is given, and the
 * key information (current player, dice) is visible.
 */

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface Probe {
  board: Rect;
  /** Projected corners of the board's slab. */
  outline: Array<{ x: number; y: number }>;
  tokens: Array<{ key: string; x: number; y: number }>;
}

declare global {
  interface Window {
    __ludoScene?: { probe: () => Probe | null };
  }
}

const VIEWPORTS = [
  { width: 320, height: 568, mobile: true },
  { width: 375, height: 812, mobile: true },
  { width: 390, height: 844, mobile: true },
  { width: 414, height: 896, mobile: true },
  { width: 844, height: 390, mobile: true },
  { width: 768, height: 1024, mobile: true },
  { width: 1280, height: 720, mobile: false },
  { width: 1366, height: 768, mobile: false },
  { width: 1440, height: 900, mobile: false },
  { width: 1920, height: 1080, mobile: false },
];

const SETTINGS = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    state: { soundOn: false, musicOn: false, reduceMotion: true, quality: 'low', showEmotes: true, haptics: false, ...over },
    version: 2,
  });

async function desktop(browser: Browser, viewport: { width: number; height: number }, settings: Record<string, unknown> = {}): Promise<Page> {
  const context = await browser.newContext({ viewport, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  await context.addInitScript((s) => {
    try {
      localStorage.setItem('ludo-nova:settings', s);
    } catch {
      /* ignore */
    }
  }, SETTINGS(settings));
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });
  return page;
}

async function rect(page: Page, selector: string): Promise<Rect | null> {
  const el = page.locator(selector).first();
  // boundingBox() waits for the element; layouts without it (e.g. no player rail on phones) skip it.
  if ((await el.count()) === 0 || !(await el.isVisible())) return null;
  const box = await el.boundingBox();
  return box ? { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height } : null;
}

type Pt = { x: number; y: number };

function hull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = (list: Pt[]) => {
    const out: Pt[] = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, q) <= 0) out.pop();
      out.push(q);
    }
    return out.slice(0, -1);
  };
  return build(p).concat(build([...p].reverse()));
}

/** Separating-axis test: does the board's convex outline overlap the rectangle (shrunk by slack)? */
function outlineOverlaps(outline: Pt[], r: Rect, slack = 4): boolean {
  const poly = hull(outline);
  const rect: Pt[] = [
    { x: r.left + slack, y: r.top + slack },
    { x: r.right - slack, y: r.top + slack },
    { x: r.right - slack, y: r.bottom - slack },
    { x: r.left + slack, y: r.bottom - slack },
  ];
  for (const shape of [poly, rect]) {
    for (let i = 0; i < shape.length; i += 1) {
      const a = shape[i]!;
      const b = shape[(i + 1) % shape.length]!;
      const n = { x: b.y - a.y, y: a.x - b.x };
      const proj = (pts: Pt[]) => pts.map((p) => p.x * n.x + p.y * n.y);
      const pa = proj(poly);
      const pb = proj(rect);
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  }
  return true;
}
const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

/** Wait until the camera has settled on its fitted pose (probe stops changing). */
async function settledProbe(page: Page): Promise<Probe> {
  await page.waitForFunction(() => !!window.__ludoScene?.probe(), null, { polling: 250, timeout: 60_000 });
  let last = '';
  for (let i = 0; i < 40; i += 1) {
    const p = (await page.evaluate(() => window.__ludoScene!.probe()))!;
    const key = JSON.stringify(p.board, (_, v: unknown) => (typeof v === 'number' ? Math.round(v) : v));
    if (key === last) return p;
    last = key;
    await page.waitForTimeout(400);
  }
  throw new Error('camera never settled');
}

for (const vp of VIEWPORTS) {
  test(`board fits and stays clear of the HUD at ${vp.width}×${vp.height}`, async ({ browser }) => {
    test.setTimeout(300_000);
    const page = vp.mobile ? await phone(browser, vp) : await desktop(browser, vp);
    await startSolo(page, { opponents: 3, tokens: 4 });
    // Same rule as computeGameLayout (apps/web/src/hooks/useMedia.ts).
    const layout = vp.width / vp.height < 0.9 ? 'portrait' : vp.height < 640 || vp.width < 1024 ? 'landscape' : 'desktop';
    await expect(page.locator(`.game-root.layout-${layout}`)).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Key information is on screen.
    await expectInViewport(page, page.locator('.dice-tray'), 'dice tray');
    if (layout === 'desktop') {
      await expectInViewport(page, page.locator('.player-card.is-turn'), 'current player card');
      await expect(page.locator('.hud-turn')).toBeVisible();
    } else {
      await expectInViewport(page, page.locator('.turn-pill'), 'current player pill');
    }

    const probe = await settledProbe(page);
    const view: Rect = { left: 0, top: 0, right: vp.width, bottom: vp.height };
    const b = probe.board;
    expect(b.left, 'board left edge').toBeGreaterThanOrEqual(-2);
    expect(b.top, 'board top edge').toBeGreaterThanOrEqual(-2);
    expect(b.right, 'board right edge').toBeLessThanOrEqual(view.right + 2);
    expect(b.bottom, 'board bottom edge').toBeLessThanOrEqual(view.bottom + 2);

    const hud = (
      await Promise.all(['.hud-top', '.hud-dock', '.hud-players'].map(async (sel) => ({ sel, r: await rect(page, sel) })))
    ).filter((h): h is { sel: string; r: Rect } => h.r !== null);
    // The bars themselves may span the screen edge-to-edge; what matters is their visible content.
    const content = (
      await Promise.all(
        ['.hud-top .icon-btn', '.turn-pill', '.hud-title', '.hud-top .conn', '.dice-tray', '.move-picker', '.player-strip', '.dock-players', '.hud-players']
          .map(async (sel) => ({ sel, r: await rect(page, sel) })),
      )
    ).filter((h): h is { sel: string; r: Rect } => h.r !== null);

    for (const t of probe.tokens) {
      expect(inside(t, view), `token ${t.key} on screen`).toBe(true);
      for (const h of content) expect(inside(t, h.r), `token ${t.key} covered by ${h.sel}`).toBe(false);
    }
    // The board's playfield never sits under the top bar or the action dock.
    const topBar = hud.find((h) => h.sel === '.hud-top')!.r;
    expect(b.top, 'board below the top bar').toBeGreaterThanOrEqual(topBar.bottom - 4);
    for (const h of content) {
      if (h.sel === '.hud-top .icon-btn' || h.sel === '.hud-top .conn' || h.sel === '.turn-pill' || h.sel === '.hud-title') continue;
      expect(outlineOverlaps(probe.outline, h.r), `board overlaps ${h.sel}`).toBe(false);
    }

    // The board uses the space: it fills at least 85% of the free width or height.
    const insets = await page.evaluate(() => window.__ludo!.presentation().insets);
    const freeW = vp.width - insets.left - insets.right;
    const freeH = vp.height - insets.top - insets.bottom;
    const fill = Math.max((b.right - b.left) / freeW, (b.bottom - b.top) / freeH);
    expect(fill, 'board fills the free area').toBeGreaterThan(0.85);
    await page.context().close();
  });
}

test('the board is completely still while nothing is happening', async ({ browser }) => {
  test.setTimeout(300_000);
  // Full animations on, medium quality: nothing on the board may move on its own.
  const page = await desktop(browser, { width: 1280, height: 720 }, { reduceMotion: false, quality: 'medium' });
  await startSolo(page, { opponents: 1, tokens: 2 });
  await waitForMyTurn(page, 'roll', 120_000);
  await settledProbe(page);
  // Compare only the board's own pixels: hide the HUD (timer text, the separate dice canvas) layered over it.
  await page.addStyleTag({ content: '.game-root > :not(.game-canvas) { visibility: hidden !important; }' });
  // Let the turn entrance and any finished effect wind down.
  await page.waitForTimeout(1500);
  const canvas = page.locator('.game-canvas canvas').first();
  const a = await canvas.screenshot();
  await page.waitForTimeout(2000);
  const b = await canvas.screenshot();
  // Still my roll: nothing happened in between.
  const phase = await page.evaluate(() => window.__ludo!.game().visual!.turn.phase);
  expect(phase).toBe('roll');
  expect(Buffer.compare(a, b), 'idle board frames must be identical').toBe(0);
  await page.context().close();
});
