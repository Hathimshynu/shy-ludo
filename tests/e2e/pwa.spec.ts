import { type Page, expect, test } from '@playwright/test';
import { newPlayer, signInAsGuest } from './helpers';
import { phone } from './mobile/mobile-helpers';

/** Width/height from a PNG's IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function waitForServiceWorker(page: Page): Promise<void> {
  // Poll with evaluate: an async predicate passed to waitForFunction would resolve immediately.
  // `active` is set while still "activating"; navigations are only controlled once "activated".
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? 'none'), {
      timeout: 60_000,
      intervals: [500],
    })
    .toBe('activated');
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test.describe('manifest and icons', () => {
  test('web app manifest meets installability criteria', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    const m = await res.json();
    expect(m).toMatchObject({
      name: 'Ludo Nova',
      short_name: 'Ludo Nova',
      display: 'standalone',
      scope: '/',
      orientation: 'any',
      theme_color: '#0b0820',
      background_color: '#0b0820',
    });
    expect(m.start_url).toMatch(/^\/play/);
    expect(JSON.stringify(m).toLowerCase()).not.toContain('ludo king');

    const icons = m.icons as Array<{ src: string; sizes: string; purpose: string }>;
    for (const want of [
      { sizes: '192x192', purpose: 'any' },
      { sizes: '512x512', purpose: 'any' },
      { sizes: '512x512', purpose: 'maskable' },
    ]) {
      expect(icons.some((i) => i.sizes === want.sizes && i.purpose === want.purpose), JSON.stringify(want)).toBe(true);
    }
    for (const icon of icons) {
      const img = await request.get(icon.src);
      expect(img.ok(), icon.src).toBe(true);
      expect(img.headers()['content-type']).toContain('image/png');
      const { width, height } = pngSize(await img.body());
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });

  test('HTML head: viewport, Apple touch icon, standalone meta, manifest link, SEO intact', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).toContain('viewport-fit=cover');
    expect(html).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="theme-color" content="#0b0820"');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('property="og:image"');
    const apple = await request.get('/icons/apple-touch-icon.png');
    expect(pngSize(await apple.body())).toEqual({ width: 180, height: 180 });
    expect((await request.get('/favicon.svg')).ok()).toBe(true);
    // robots/sitemap still served (not replaced by the SPA fallback)
    expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /game/');
    expect(await (await request.get('/sitemap.xml')).text()).toContain('<urlset');
  });
});

test.describe('service worker', () => {
  test('registers, precaches the shell, and never caches API or socket traffic', async ({ browser }) => {
    const { page, context } = await newPlayer(browser);
    await page.goto('/');
    await waitForServiceWorker(page);
    await signInAsGuest(page); // generates authenticated /api traffic
    await page.goto('/leaderboard');
    await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) urls.push(new URL(req.url).pathname);
      }
      return urls;
    });
    expect(cached.length).toBeGreaterThan(10);
    expect(cached).toContain('/index.html');
    expect(cached.some((u) => /soloGame\.worker/.test(u)), 'solo worker is precached').toBe(true);
    expect(cached.filter((u) => u.startsWith('/api') || u.startsWith('/socket.io') || u.startsWith('/health'))).toEqual([]);
    expect(cached).not.toContain('/og-image.png');
    await context.close();
  });

  test('offline: the app shell loads, online play explains it is offline, solo still works', async ({ browser }) => {
    const { page, context } = await newPlayer(browser);
    await page.goto('/play');
    await waitForServiceWorker(page);
    await page.reload(); // now controlled by the service worker
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { polling: 250, timeout: 30_000 });
    await context.setOffline(true);

    await page.goto('/play');
    await expect(page.getByRole('heading', { name: /Ready to roll/ })).toBeVisible();
    await expect(page.getByText(/You’re offline\. Solo games still work/)).toBeVisible();

    await page.goto('/online');
    await expect(page.getByRole('alert').filter({ hasText: 'Reconnect to the internet to play online' })).toBeVisible();
    await page.getByRole('button', { name: 'Find Match' }).click();
    await expect(page.getByText('You’re offline. Reconnect to the internet to play online.').first()).toBeVisible();

    // Solo works entirely offline (engine + AI from the precached worker).
    await page.goto('/solo');
    await page.getByRole('button', { name: 'Start game' }).click();
    await page.waitForFunction(() => !!window.__ludo?.game().state, null, { timeout: 30_000 });
    await expect(page.locator('.player-card')).toHaveCount(4);
    await context.setOffline(false);
    await context.close();
  });
});

test.describe('install experience', () => {
  test('Android: custom install prompt uses beforeinstallprompt, then remembers the install', async ({ browser }) => {
    const page = await phone(browser, { width: 390, height: 844 });
    await page.goto('/play');
    await page.waitForFunction(() => !!window.__ludo, null, { polling: 250 });
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
      e.prompt = async () => {
        (window as unknown as { __prompted: boolean }).__prompted = true;
      };
      e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
    });
    const card = page.getByRole('dialog', { name: 'Play Ludo Nova anywhere' });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: 'Install' }).tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __prompted?: boolean }).__prompted)).toBe(true);
    await expect(card).toHaveCount(0);
    await page.reload();
    await page.waitForTimeout(3500);
    await expect(card).toHaveCount(0);
    await page.goto('/settings');
    await expect(page.getByText('Installed', { exact: true })).toBeVisible();
    await page.context().close();
  });

  test('"Later" snoozes the prompt across reloads', async ({ browser }) => {
    const page = await phone(browser, { width: 375, height: 812 });
    const fire = () =>
      page.evaluate(() => {
        const e = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
        e.prompt = async () => undefined;
        e.userChoice = Promise.resolve({ outcome: 'dismissed' });
        window.dispatchEvent(e);
      });
    await page.goto('/play');
    await page.waitForFunction(() => !!window.__ludo, null, { polling: 250 });
    await fire();
    const card = page.getByRole('dialog', { name: 'Play Ludo Nova anywhere' });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: 'Later' }).tap();
    await expect(card).toHaveCount(0);
    await page.reload();
    await page.waitForFunction(() => !!window.__ludo, null, { polling: 250 });
    await fire();
    await page.waitForTimeout(3500);
    await expect(card).toHaveCount(0);
    await page.context().close();
  });

  test('iOS Safari: shows "Add to Home Screen" instructions instead of a prompt', async ({ browser }) => {
    const page = await phone(browser, { width: 390, height: 844 }, { userAgent: IPHONE_UA });
    await page.goto('/play');
    await page.waitForFunction(() => window.__ludo?.pwa().platform === 'ios', null, { polling: 250 });
    const card = page.getByRole('dialog', { name: 'Play Ludo Nova anywhere' });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: 'Install' }).tap();
    const help = page.getByRole('dialog', { name: 'Install Ludo Nova' });
    await expect(help).toBeVisible();
    await expect(help).toContainText('Add to Home Screen');
    await expect(help).toContainText('Share');
    await help.getByRole('button', { name: 'Got it' }).tap();
    await expect(help).toHaveCount(0);
    await page.context().close();
  });

  test('desktop: no install prompt is pushed at the player', async ({ browser }) => {
    const { page, context } = await newPlayer(browser);
    await page.goto('/play');
    await page.waitForTimeout(3500);
    await expect(page.getByRole('dialog', { name: 'Play Ludo Nova anywhere' })).toHaveCount(0);
    await context.close();
  });
});

test('standalone launch opens the game menu instead of the marketing page', async ({ browser }) => {
  const page = await phone(browser, { width: 390, height: 844 });
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (q: string) =>
      q.includes('display-mode: standalone') ? ({ ...original(q), matches: true, media: q } as MediaQueryList) : original(q);
  });
  await page.goto('/');
  await expect(page).toHaveURL(/\/play$/);
  await expect(page.locator('html.is-standalone')).toHaveCount(1);
  await page.context().close();
});
