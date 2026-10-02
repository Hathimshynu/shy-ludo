import { expect, test } from '@playwright/test';
import { canAct, createRoom, expectSynchronised, joinRoom, playUntil, signInAsGuest } from '../helpers';
import { phone } from './mobile-helpers';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('phone + phone + desktop + tablet in one game: synchronised play, network blip, deferred update', async ({ browser }) => {
  test.setTimeout(600_000);
  const phoneA = await phone(browser, { width: 390, height: 844 });
  const phoneB = await phone(browser, { width: 375, height: 812 }, { userAgent: IPHONE_UA });
  const tablet = await phone(browser, { width: 768, height: 1024 });
  const desktopCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await desktopCtx.addInitScript(() =>
    localStorage.setItem(
      'ludo-nova:settings',
      JSON.stringify({ state: { soundOn: false, musicOn: false, reduceMotion: true, quality: 'low', showEmotes: true, haptics: false }, version: 2 }),
    ),
  );
  const desktop = await desktopCtx.newPage();
  const pages = [phoneA, phoneB, desktop, tablet];
  for (const p of pages) await signInAsGuest(p);

  const code = await createRoom(phoneA, { players: 4, tokens: 1, quick: true });
  for (const p of [phoneB, desktop, tablet]) await joinRoom(p, code);
  await phoneA.getByRole('button', { name: 'Start game' }).click();
  for (const p of pages) {
    await expect(p).toHaveURL(/\/game\/game_/, { timeout: 30_000 });
    await p.waitForFunction(() => !!window.__ludo?.game().state);
  }
  // Same authoritative engine everywhere; each device uses its own layout.
  await expect(phoneA.locator('.game-root.layout-portrait')).toBeVisible();
  await expect(tablet.locator('.game-root.layout-portrait')).toBeVisible();
  await expect(desktop.locator('.game-root.layout-landscape, .game-root.layout-desktop')).toBeVisible();
  await expectSynchronised(pages);

  // Every device takes turns through its own UI.
  for (let i = 0; i < 12; i += 1) await playUntil(pages, async () => false, 1).catch(() => undefined);
  await expectSynchronised(pages);

  // A deployed update must not interrupt an online game.
  await phoneA.evaluate(() => window.__ludo!.setPwa({ updateReady: true }));
  await phoneA.waitForTimeout(300);
  await expect(phoneA.getByText('A new version of Ludo Nova is available.')).toHaveCount(0);

  // Temporary network loss on phone B: clear status, no frozen UI, state restored.
  await phoneB.context().setOffline(true);
  await expect(phoneB.getByText('Connection lost. Reconnecting…')).toBeVisible();
  await expect(phoneB.getByRole('button', { name: 'Game menu' })).toBeEnabled();
  await phoneB.waitForTimeout(1500);
  await phoneB.context().setOffline(false);
  await expect(phoneB.getByText('Connection lost. Reconnecting…')).toHaveCount(0, { timeout: 30_000 });
  await expectSynchronised(pages);

  // Finish the game; everyone sees the same result.
  await playUntil(pages, async () => (await canAct(phoneA)).finished, 4_000);
  const final = await expectSynchronised(pages);
  expect(final.status).toBe('finished');
  for (const p of pages) await expect(p.locator('.winner-title')).toBeVisible({ timeout: 30_000 });

  // Once the game is over the update banner appears.
  await expect(phoneA.getByText('A new version of Ludo Nova is available.')).toBeVisible();
  await expect(phoneA.getByRole('button', { name: 'Update' })).toBeVisible();

  for (const p of pages) await p.context().close();
});
