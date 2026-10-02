import { expect, test } from '@playwright/test';
import { actViaSocket, canAct, createRoom, expectSynchronised, joinRoom, newPlayer, playUntil, signInAsGuest } from './helpers';

test.use({ trace: 'off', screenshot: 'off' });

test('8 separate players in 8 browser sessions stay synchronised through a whole game', async ({ browser }) => {
  test.setTimeout(1_500_000);
  const players = await Promise.all(Array.from({ length: 8 }, () => newPlayer(browser, { width: 640, height: 480 })));
  const pages = players.map((p) => p.page);
  for (const p of pages) await signInAsGuest(p);

  const code = await createRoom(pages[0]!, { players: 8, tokens: 1, quick: true });
  for (const p of pages.slice(1)) await joinRoom(p, code);
  await expect(pages[0]!.locator('.lobby-count')).toContainText('8/8');
  await pages[0]!.getByRole('button', { name: 'Start game' }).click();

  for (const p of pages) {
    await expect(p).toHaveURL(/\/game\/game_/, { timeout: 30_000 });
    await p.waitForFunction(() => !!window.__ludo?.game().state);
  }
  const start = await expectSynchronised(pages);
  expect(start.players).toHaveLength(8);
  expect(start.armCount).toBe(8);
  expect(new Set(start.players.map((p) => p.color)).size).toBe(8);

  // Every session acts through its own socket; every session renders and applies all events.
  let checks = 0;
  await playUntil(
    pages,
    async () => {
      checks += 1;
      // Periodically assert that all 8 sessions agree on the authoritative state.
      if (checks % 25 === 0) await expectSynchronised(pages);
      return (await canAct(pages[0]!)).finished;
    },
    6_000,
    actViaSocket,
  );
  const final = await expectSynchronised(pages);
  expect(final.status).toBe('finished');
  for (const p of pages) await expect(p.locator('.winner-title')).toBeVisible({ timeout: 30_000 });
  await Promise.all(players.map((p) => p.context.close()));
});
