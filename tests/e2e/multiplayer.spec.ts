import { expect, test } from '@playwright/test';
import {
  actViaUi,
  canAct,
  createRoom,
  expectSynchronised,
  gameState,
  joinRoom,
  newPlayer,
  playUntil,
  signInAsGuest,
} from './helpers';

test('two browsers: create, join, synchronised play, reconnect after refresh, anti-cheat, winner', async ({ browser }) => {
  const a = await newPlayer(browser);
  const b = await newPlayer(browser);
  await signInAsGuest(a.page);
  await signInAsGuest(b.page);

  // Browser A creates a room, Browser B joins with the code.
  const code = await createRoom(a.page, { players: 2, tokens: 1, quick: true });
  await joinRoom(b.page, code);
  await expect(a.page.locator('.lobby-count')).toContainText('2/2');
  await a.page.getByRole('button', { name: 'Start game' }).click();

  await expect(a.page).toHaveURL(/\/game\/game_/);
  await expect(b.page).toHaveURL(/\/game\/game_/);
  expect(a.page.url()).toBe(b.page.url());
  const pages = [a.page, b.page];
  await Promise.all(pages.map((p) => p.waitForFunction(() => !!window.__ludo?.game().state)));

  // Dice, turns and tokens synchronise across browsers.
  for (let i = 0; i < 6; i += 1) {
    await playUntil(pages, async () => false, 1).catch(() => undefined);
  }
  const synced = await expectSynchronised(pages);
  expect(synced.seq).toBeGreaterThan(0);

  // --- Anti-cheat: forged requests from the browser are rejected by the server ----------
  const current = synced.turn.playerId;
  const ids = await Promise.all(pages.map((p) => p.evaluate(() => window.__ludo!.game().myId)));
  const waiting = pages[ids.indexOf(current) === 0 ? 1 : 0]!;
  const results = await waiting.evaluate(async (gameId) => {
    const s = window.__ludo!.socket;
    const seq = window.__ludo!.game().state!.seq;
    const id = () => crypto.randomUUID();
    const wrongTurn = await s.emit('dice:roll', { gameId, actionId: id(), expectedSeq: seq });
    const fakeDice = await s.emit('dice:roll', { gameId, actionId: id(), expectedSeq: seq, value: 6 });
    const badGame = await s.emit('dice:roll', { gameId: 'game_forged', actionId: id(), expectedSeq: seq });
    const badToken = await s.emit('token:move', { gameId, actionId: id(), expectedSeq: seq, tokenIndex: 7 });
    const stale = await s.emit('dice:roll', { gameId, actionId: id(), expectedSeq: seq + 3 });
    return [wrongTurn, fakeDice, badGame, badToken, stale].map((r) => r.error?.code ?? 'OK');
  }, synced.id);
  // A dice value in the payload is a forgery: rejected before the turn is even checked.
  expect(results).toEqual(['NOT_YOUR_TURN', 'VALIDATION', 'GAME_NOT_FOUND', 'VALIDATION', 'STALE_STATE']);

  const currentPage = pages[ids.indexOf(current)]!;
  const dup = await currentPage.evaluate(async (gameId) => {
    const s = window.__ludo!.socket;
    const g = window.__ludo!.game();
    if (g.state!.turn.phase !== 'roll') return ['SKIP', 'SKIP'];
    const actionId = crypto.randomUUID();
    const first = await s.emit('dice:roll', { gameId, actionId, expectedSeq: g.state!.seq });
    const second = await s.emit('dice:roll', { gameId, actionId, expectedSeq: g.state!.seq });
    return [first.error?.code ?? 'OK', second.error?.code ?? 'OK'];
  }, synced.id);
  if (dup[0] !== 'SKIP') expect(dup).toEqual(['OK', 'DUPLICATE_ACTION']);

  // --- Reconnection: refresh browser B mid-game -------------------------------------------
  await expectSynchronised(pages);
  await b.page.reload();
  await expect(b.page).toHaveURL(/\/game\/game_/);
  await b.page.waitForFunction(() => !!window.__ludo?.game().state);
  const restored = await expectSynchronised(pages);
  expect(restored.id).toBe(synced.id);
  expect(restored.seq).toBeGreaterThanOrEqual(synced.seq);

  // --- Play to the end: the winner is synchronised -----------------------------------------
  await playUntil(pages, async () => (await canAct(a.page)).finished && (await canAct(b.page)).finished, 4_000);
  const final = await expectSynchronised(pages);
  expect(final.status).toBe('finished');
  const winnerId = final.rankings[0];
  for (const [i, p] of pages.entries()) {
    await expect(p.locator('.winner-title')).toBeVisible({ timeout: 30_000 });
    await expect(p.locator('.winner-title')).toHaveText(ids[i] === winnerId ? 'YOU WIN' : /wins/);
  }
  await a.context.close();
  await b.context.close();
});

test('room errors are friendly', async ({ browser }) => {
  const { page, context } = await newPlayer(browser);
  await signInAsGuest(page);
  await page.goto('/friends?join=1');
  await page.getByRole('textbox', { name: /Room code/ }).fill('ZZZZZZ');
  await page.getByRole('button', { name: 'Join Room' }).click();
  await expect(page.getByText('Room not found. Check the code and try again.')).toBeVisible();
  await context.close();
});

test('quick match pairs two browsers into the same game', async ({ browser }) => {
  const a = await newPlayer(browser);
  const b = await newPlayer(browser);
  await signInAsGuest(a.page);
  await signInAsGuest(b.page);
  for (const p of [a.page, b.page]) {
    await p.goto('/online');
    await p.getByRole('radio', { name: /^2\s*Players/ }).click();
    await p.getByRole('button', { name: 'Find Match' }).click();
  }
  await expect(a.page).toHaveURL(/\/game\/game_/, { timeout: 30_000 });
  await expect(b.page).toHaveURL(/\/game\/game_/, { timeout: 30_000 });
  expect(a.page.url()).toBe(b.page.url());
  await Promise.all([a.page, b.page].map((p) => p.waitForFunction(() => !!window.__ludo?.game().state)));
  await actViaUi(a.page).catch(() => undefined);
  await actViaUi(b.page).catch(() => undefined);
  await expectSynchronised([a.page, b.page]);
  const s = (await gameState(a.page))!;
  expect(s.players).toHaveLength(2);
  // Leave so the next spec starts clean.
  for (const p of [a.page, b.page]) {
    await p.evaluate((id) => window.__ludo!.socket.emit('game:leave', { gameId: id }), s.id);
  }
  await a.context.close();
  await b.context.close();
});
