import { type Page, expect, test } from '@playwright/test';
import { newPlayer } from './helpers';

async function registerViaUi(page: Page, username: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('friends-e2e-pass-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/play$/);
  await page.waitForFunction(() => !!window.__ludo && (window.__ludo.socket as unknown as { connected: boolean }).connected, null, {
    timeout: 30_000,
  });
}

test('friends: request, accept, invite to a private room, join from the invite', async ({ browser }) => {
  const stamp = Date.now().toString(36).slice(-5);
  const a = await newPlayer(browser);
  const b = await newPlayer(browser, { width: 390, height: 844 }); // phone-sized
  const nameA = `amy_${stamp}`;
  const nameB = `ben_${stamp}`;
  await registerViaUi(a.page, nameA);
  await registerViaUi(b.page, nameB);

  // A sends a request by username.
  await a.page.goto('/profile');
  await a.page.getByLabel('Add a friend by username').fill(nameB);
  await a.page.getByRole('button', { name: 'Send request' }).click();
  await expect(a.page.getByText(`Friend request sent to ${nameB}.`)).toBeVisible();
  await expect(a.page.getByRole('heading', { name: 'Sent requests' })).toBeVisible();

  // B accepts it from their profile (phone layout: no horizontal overflow).
  await b.page.goto('/profile');
  await expect(b.page.getByRole('heading', { name: 'Requests' })).toBeVisible();
  const scroll = await b.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(scroll).toBeLessThanOrEqual(1);
  await b.page.getByRole('button', { name: 'Accept' }).click();
  await expect(b.page.getByText(`You and ${nameA} are now friends.`)).toBeVisible();

  // A creates a private room and invites B.
  await a.page.goto('/friends');
  await a.page.getByRole('button', { name: 'Create Private Room' }).click();
  await expect(a.page).toHaveURL(/\/room\/[A-Z0-9]{6}$/);
  const code = a.page.url().split('/').pop()!;
  await b.page.goto('/play');
  await a.page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(a.page.getByRole('button', { name: 'Invited' })).toBeDisabled();

  // B gets the invite and joins with one tap.
  const banner = b.page.locator('.invite-banner');
  await expect(banner).toContainText(nameA);
  await expect(banner).toContainText(code);
  await banner.getByRole('button', { name: 'Join' }).click();
  await expect(b.page).toHaveURL(new RegExp(`/room/${code}$`));
  await expect(a.page.locator('.lobby-count')).toContainText('2/');

  await a.context.close();
  await b.context.close();
});
