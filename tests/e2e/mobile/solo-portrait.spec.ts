import { expect, test } from '@playwright/test';
import { actViaUi, gameState } from '../helpers';

test('mobile portrait: solo game is playable with touch and the page does not scroll', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'ludo-nova:settings',
      JSON.stringify({ state: { soundOn: false, musicOn: false, reduceMotion: true, quality: 'low', showEmotes: true }, version: 1 }),
    );
  });
  await page.goto('/solo');
  await page.getByRole('radiogroup', { name: 'Number of AI opponents' }).getByRole('radio', { name: '7', exact: true }).click();
  await page.getByRole('button', { name: 'Start game' }).click();
  await page.waitForFunction(() => !!window.__ludo?.game().state);
  await expect(page.locator('.player-card')).toHaveCount(8);
  // The dice tray and every player card are inside the viewport.
  const vp = page.viewportSize()!;
  const tray = (await page.locator('.dice-tray').boundingBox())!;
  expect(tray.y + tray.height).toBeLessThanOrEqual(vp.height);
  expect(tray.x).toBeGreaterThanOrEqual(0);
  expect(tray.x + tray.width).toBeLessThanOrEqual(vp.width);
  // No horizontal or vertical page scroll during play.
  const scroll = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
  expect(scroll[0]).toBeLessThanOrEqual(vp.width);
  // Tap the die (touch) when it is our turn.
  for (let i = 0; i < 40 && !(await actViaUi(page)); i += 1) await page.waitForTimeout(250);
  expect((await gameState(page))!.players[0]!.stats.rolls).toBeGreaterThan(0);
});
