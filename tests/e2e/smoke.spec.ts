import { expect, test } from '@playwright/test';
import { newPlayer } from './helpers';

test('landing page renders the hero, CTAs and SEO metadata', async ({ browser }) => {
  const { page, context } = await newPlayer(browser);
  await page.goto('/');
  await expect(page.locator('.hero-title')).toContainText('PLAY.');
  await expect(page.locator('.hero-title')).toContainText('ROLL.');
  await expect(page.locator('.hero-title')).toContainText('CONQUER.');
  for (const name of ['Play Online', 'Play vs AI', 'Create Room']) {
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(page).toHaveTitle(/Ludo Nova/);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /2–8 players/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Ludo Nova/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/$/);
  // The interactive 3D preview mounts.
  await expect(page.locator('.hero-board canvas')).toBeVisible({ timeout: 30_000 });
  await context.close();
});

test('private routes are marked noindex', async ({ browser }) => {
  const { page, context } = await newPlayer(browser);
  await page.goto('/settings');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await page.goto('/how-to-play');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /index, follow/);
  await context.close();
});

test('menu navigation and unknown routes', async ({ browser }) => {
  const { page, context } = await newPlayer(browser);
  await page.goto('/play');
  await expect(page.getByRole('link', { name: /Play vs AI/ })).toBeVisible();
  await page.getByRole('link', { name: /How to Play/ }).first().click();
  await expect(page.getByRole('heading', { name: 'How to Play' })).toBeVisible();
  await page.goto('/nope');
  await expect(page.getByRole('heading', { name: 'Lost in space' })).toBeVisible();
  await context.close();
});
