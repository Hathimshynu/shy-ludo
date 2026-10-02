import { expect, test, type Page } from '@playwright/test';
import { gameState } from '../helpers';
import {
  LANDSCAPE,
  expectInViewport,
  expectNoHorizontalScroll,
  expectTouchTarget,
  phone,
  playSoloToEnd,
  startSolo,
  tapRoll,
  waitForMyTurn,
} from './mobile-helpers';

const GAME_VIEWPORTS = [
  { name: '320', width: 320, height: 568 },
  { name: '375', width: 375, height: 812 },
  { name: '390', width: 390, height: 844 },
  { name: '414', width: 414, height: 896 },
  LANDSCAPE,
];

/** Roll by tapping until the game offers a choice of moves; returns false if it never did. */
async function rollUntilChoice(page: Page, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    await waitForMyTurn(page);
    const phase = await page.evaluate(() => window.__ludo!.game().visual!.turn.phase);
    if (phase === 'move' && (await page.locator('.move-chip').count()) > 0) return true;
    if (phase === 'roll') await tapRoll(page);
  }
  return false;
}

for (const vp of GAME_VIEWPORTS) {
  test(`game HUD, touch dice and token selection at ${vp.name}`, async ({ browser }) => {
    test.setTimeout(480_000);
    const page = await phone(browser, vp);
    await startSolo(page, { tokens: 2 });
    const portrait = vp.width < vp.height;
    await expect(page.locator(`.game-root.layout-${portrait ? 'portrait' : 'landscape'}`)).toBeVisible();

    // HUD regions are inside the viewport and do not overlap each other.
    const top = (await page.locator('.hud-top').boundingBox())!;
    const tray = page.locator('.dice-tray');
    await expectInViewport(page, tray, 'dice tray');
    const trayBox = (await tray.boundingBox())!;
    if (portrait) expect(top.y + top.height).toBeLessThanOrEqual(trayBox.y);
    else expect(top.x + top.width).toBeLessThanOrEqual(trayBox.x + 1);
    await expectTouchTarget(page.getByRole('button', { name: 'Game menu' }), 'menu button');
    await expectTouchTarget(page.locator('.dice-button'), 'dice');
    await expectNoHorizontalScroll(page);

    // The camera frames the board in the space the HUD leaves free.
    const insets = await page.evaluate(() => window.__ludo!.presentation().insets);
    if (portrait) {
      expect(insets.top).toBeGreaterThan(30);
      expect(insets.bottom).toBeGreaterThan(80);
    } else {
      expect(insets.right).toBeGreaterThan(200);
    }

    // Token selection: tap a move chip → selection feedback → the move is applied.
    expect(await rollUntilChoice(page)).toBe(true);
    const chip = page.locator('.move-chip').first();
    await expectInViewport(page, chip, 'move chip');
    await expectTouchTarget(chip, 'move chip');
    const before = (await gameState(page))!.seq;
    await chip.tap();
    await page.waitForFunction((seq) => (window.__ludo?.game().state?.seq ?? 0) > seq, before);
    const selected = await page.evaluate(() => window.__ludo!.presentation().selected);
    expect(selected?.key).toMatch(/^you#\d$/);
    await page.context().close();
  });
}

test('double taps never send duplicate roll or move requests', async ({ browser }) => {
  const page = await phone(browser, { width: 390, height: 844 });
  await startSolo(page, { tokens: 2 });
  await waitForMyTurn(page, 'roll');
  const rollsBefore = (await gameState(page))!.players[0]!.stats.rolls;
  const dice = page.locator('.dice-button');
  await dice.tap();
  await dice.tap({ force: true });
  await dice.tap({ force: true });
  await page.waitForTimeout(1500);
  const rollsAfter = (await gameState(page))!.players[0]!.stats.rolls;
  expect(rollsAfter - rollsBefore).toBe(1);
  await page.context().close();
});

test('safe areas: HUD stays clear of a notch and the home indicator', async ({ browser }) => {
  const page = await phone(browser, { width: 390, height: 844 });
  await startSolo(page);
  // Simulate an iPhone notch (47px) and home indicator (34px).
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--sat', '47px');
    document.documentElement.style.setProperty('--sab', '34px');
  });
  await page.waitForTimeout(300);
  const pill = (await page.locator('.turn-pill').boundingBox())!;
  expect(pill.y).toBeGreaterThanOrEqual(47);
  const strip = (await page.locator('.player-strip').boundingBox())!;
  expect(strip.y + strip.height).toBeLessThanOrEqual(844 - 34 + 1);
  // The camera re-frames for the new HUD size.
  await expect.poll(() => page.evaluate(() => window.__ludo!.presentation().insets.top)).toBeGreaterThan(47 + 40);
  await page.context().close();
});

test('orientation changes keep the game, the connection and the dice state', async ({ browser }) => {
  const page = await phone(browser, { width: 390, height: 844 });
  await startSolo(page, { tokens: 2 });
  await waitForMyTurn(page, 'roll');
  await tapRoll(page);
  const before = (await gameState(page))!;
  const diceBefore = await page.evaluate(() => window.__ludo!.presentation().dice.value);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('.game-root.layout-landscape')).toBeVisible();
  await expect(page.locator('.dice-tray')).toBeInViewport();
  let after = (await gameState(page))!;
  expect(after.id).toBe(before.id);
  expect(after.seq).toBeGreaterThanOrEqual(before.seq);
  expect(await page.evaluate(() => window.__ludo!.presentation().dice.value)).toBe(diceBefore);
  await expect.poll(() => page.evaluate(() => window.__ludo!.presentation().insets.right)).toBeGreaterThan(200);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.game-root.layout-portrait')).toBeVisible();
  after = (await gameState(page))!;
  expect(after.id).toBe(before.id);
  await expect.poll(() => page.evaluate(() => window.__ludo!.presentation().insets.bottom)).toBeGreaterThan(80);
  await expectNoHorizontalScroll(page);
  await page.context().close();
});

test('Android Back asks before leaving a game; Back again keeps playing', async ({ browser }) => {
  const page = await phone(browser, { width: 360, height: 800 });
  await startSolo(page);
  await page.goBack();
  const dialog = page.getByRole('dialog', { name: 'Leave this game?' });
  await expect(dialog).toBeVisible();
  await expectInViewport(page, dialog, 'leave sheet');
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/solo\/game$/);
  // Back once more still asks (the guard re-arms).
  await page.goBack();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep playing' }).tap();
  await expect(page).toHaveURL(/\/solo\/game$/);
  await page.context().close();
});

test('sound needs a tap on mobile: "Tap to enable sound" hint, and haptics fire where supported', async ({ browser }) => {
  const page = await phone(browser, { width: 390, height: 844 }, { settings: { soundOn: true } });
  await page.addInitScript(() => {
    (window as unknown as { __vibrations: unknown[] }).__vibrations = [];
    navigator.vibrate = (p: VibratePattern) => {
      (window as unknown as { __vibrations: unknown[] }).__vibrations.push(p);
      return true;
    };
  });
  await startSolo(page);
  // Reload: the saved solo game resumes, but no user gesture has happened yet.
  await page.reload();
  await page.waitForFunction(() => !!window.__ludo?.game().state);
  const hint = page.getByRole('button', { name: /Tap to enable sound/ });
  await expect(hint).toBeVisible();
  await hint.tap();
  await expect(hint).toHaveCount(0);
  await waitForMyTurn(page, 'roll');
  await tapRoll(page);
  const vibrations = await page.evaluate(() => (window as unknown as { __vibrations: unknown[] }).__vibrations.length);
  expect(vibrations).toBeGreaterThan(0);
  await page.context().close();
});

test('winner screen fits every phone size without scrolling to the buttons', async ({ browser }) => {
  test.setTimeout(420_000);
  const page = await phone(browser, { width: 320, height: 568 });
  await startSolo(page);
  await playSoloToEnd(page);
  const title = page.locator('.winner-title');
  await expect(title).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2200); // entrance animation
  for (const vp of [
    { width: 320, height: 568 },
    { width: 360, height: 800 },
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 414, height: 896 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(200);
    for (const name of ['Play again', 'Exit']) {
      const btn = page.getByRole('button', { name, exact: true });
      await expectInViewport(page, btn, `${name} at ${vp.width}×${vp.height}`);
      await expectTouchTarget(btn, name);
    }
    await expect(title).toBeInViewport();
  }
  await page.context().close();
});
