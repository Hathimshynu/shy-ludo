import { expect, test } from '@playwright/test';
import { canAct, gameState, newPlayer, playUntil } from './helpers';

test('solo game vs AI: roll, move, AI plays, refresh resumes, and the game can be won or lost', async ({ browser }) => {
  const { page, context } = await newPlayer(browser);
  await page.goto('/solo');
  await page.getByRole('radiogroup', { name: 'Number of AI opponents' }).getByRole('radio', { name: '1', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'AI difficulty' }).getByRole('radio', { name: 'Easy' }).click();
  await page.getByRole('radiogroup', { name: 'Tokens per player' }).getByRole('radio', { name: '1', exact: true }).click();
  await page.getByText('Rule variants').click();
  await page.getByRole('switch', { name: /Six to start/ }).uncheck();
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page).toHaveURL(/\/solo\/game$/);
  await page.waitForFunction(() => !!window.__ludo?.game().state);
  await expect(page.locator('.game-canvas canvas')).toBeVisible();
  await expect(page.locator('.player-card')).toHaveCount(2);

  // Play a few turns through the UI; the AI must take turns too.
  let aiActed = false;
  await playUntil([page], async () => {
    const s = await gameState(page);
    aiActed ||= !!s && s.players.some((p) => p.kind === 'bot' && p.stats.rolls > 0);
    return aiActed && (s?.players[0]!.stats.rolls ?? 0) >= 3;
  });
  const before = (await gameState(page))!;
  expect(before.players.find((p) => p.kind === 'bot')!.stats.rolls).toBeGreaterThan(0);

  // Refresh: the solo game resumes from local storage (same game, not a restart).
  await page.reload();
  await page.waitForFunction(() => !!window.__ludo?.game().state);
  const after = (await gameState(page))!;
  expect(after.id).toBe(before.id);
  expect(after.seq).toBeGreaterThanOrEqual(before.seq);

  // Finish the game.
  await playUntil([page], async () => (await canAct(page)).finished, 3_000);
  await expect(page.locator('.winner-title')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ranking li')).toHaveCount(2);
  await context.close();
});
