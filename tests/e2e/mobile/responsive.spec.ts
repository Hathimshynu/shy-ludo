import { expect, test } from '@playwright/test';
import { signInAsGuest } from '../helpers';
import { LANDSCAPE, PORTRAIT, expectInViewport, expectNoHorizontalScroll, expectTouchTarget, phone } from './mobile-helpers';

for (const vp of [...PORTRAIT, LANDSCAPE]) {
  test.describe(`${vp.name} (${vp.width}×${vp.height})`, () => {
    test('landing, login, menu, settings and solo setup fit without horizontal scroll', async ({ browser }) => {
      const page = await phone(browser, vp);

      // Landing
      await page.goto('/');
      await expect(page.locator('.hero-title')).toBeVisible();
      await expectNoHorizontalScroll(page);
      const playOnline = page.getByRole('link', { name: 'Play Online', exact: true });
      await expectTouchTarget(playOnline, 'Play Online');

      // Login: inputs and the primary button stay reachable; focusing scrolls the field into view.
      await page.goto('/login');
      const login = page.getByRole('textbox', { name: /Username or email/ });
      await expect(login).toBeVisible();
      await login.tap();
      await expect(login).toBeInViewport();
      await expectTouchTarget(page.getByRole('button', { name: 'Sign in', exact: true }), 'Sign in');
      await expectNoHorizontalScroll(page);
      expect(await login.getAttribute('autocapitalize')).toBe('none');
      expect(await page.getByLabel('Password').getAttribute('type')).toBe('password');

      // Menu (signed in, so the top bar shows the user chip): primary actions, bottom nav, targets.
      await page.getByRole('button', { name: 'Continue as guest' }).tap();
      await expect(page).toHaveURL(//play$/);
      for (const name of ['Play Online', 'Play vs AI', 'Create Room', 'Join Room']) {
        await expectTouchTarget(page.getByRole('link', { name: new RegExp(name) }).first(), name);
      }
      if (vp.width <= 760) {
        const nav = page.getByRole('navigation', { name: 'App' });
        await expect(nav).toBeVisible();
        await expectInViewport(page, nav, 'bottom navigation');
        await expectTouchTarget(nav.getByRole('link', { name: /Settings/ }), 'bottom nav item');
      }
      await expectNoHorizontalScroll(page);

      // Settings: haptics, quality tiers incl. Ultra, install entry.
      await page.goto('/settings');
      await expect(page.getByRole('switch', { name: /Haptic feedback/ })).toBeAttached();
      await expect(page.getByRole('radio', { name: 'Ultra' })).toBeVisible();
      await expect(page.getByText('Install app')).toBeVisible();
      await expectNoHorizontalScroll(page);

      // Solo setup
      await page.goto('/solo');
      await expect(page.getByRole('button', { name: 'Start game' })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.context().close();
    });
  });
}

test('private room lobby on a 375px phone: code, player dots, rules sheet, sticky start', async ({ browser }) => {
  const page = await phone(browser, { width: 375, height: 812 });
  await signInAsGuest(page);
  await page.goto('/friends');
  await page.getByRole('button', { name: 'Create Private Room' }).tap();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{6}$/);
  await expect(page.locator('.room-code')).toBeVisible();
  await expect(page.locator('.seat-dots i')).toHaveCount(4);
  await expect(page.locator('.seat-dots i.is-filled')).toHaveCount(1);
  // Rules live in a bottom sheet on phones.
  await page.getByRole('button', { name: /Table rules/ }).tap();
  const sheet = page.getByRole('dialog', { name: 'Table rules' });
  await expect(sheet).toBeVisible();
  await expectInViewport(page, sheet, 'rules sheet');
  await expectTouchTarget(sheet.getByRole('button', { name: 'Close' }), 'sheet close button');
  // Android Back closes the sheet instead of leaving the room.
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/room\//);
  await expectInViewport(page, page.getByRole('button', { name: 'Start game' }), 'Start game');
  await expectNoHorizontalScroll(page);
  await page.context().close();
});
