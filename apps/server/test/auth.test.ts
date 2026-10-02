import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiErrorBody, AuthResponse, LeaderboardResponse, ProfileView } from '@ludo/shared-types';
import { api, guest, startTestServer, type TestServer } from './harness';

const CSRF = { 'x-requested-with': 'ludo', origin: 'http://localhost:5173' };

let ctx: TestServer;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  await ctx?.close();
});

describe('health', () => {
  it('reports ok', async () => {
    expect((await api(ctx.url, '/health')).body).toEqual({ status: 'ok' });
    expect((await api(ctx.url, '/health/ready')).body).toEqual({ status: 'ok' });
  });

  it('sets security headers and a request id', async () => {
    const res = await fetch(`${ctx.url}/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('registration and login', () => {
  it('registers, rejects duplicates and logs in', async () => {
    const reg = await api<AuthResponse>(ctx.url, '/api/auth/register', {
      body: { username: 'NovaPilot', password: 'correct-horse-1', email: 'pilot@example.com' },
    });
    expect(reg.status).toBe(201);
    expect(reg.body.user).toMatchObject({ username: 'novapilot', displayName: 'NovaPilot', isGuest: false });
    expect(reg.cookie).toMatch(/^ln_rt=/);
    expect(JSON.stringify(reg.body)).not.toContain('passwordHash');

    const dup = await api<ApiErrorBody>(ctx.url, '/api/auth/register', {
      body: { username: 'novapilot', password: 'another-pass-1' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('USERNAME_TAKEN');

    const bad = await api<ApiErrorBody>(ctx.url, '/api/auth/login', { body: { login: 'novapilot', password: 'nope-nope' } });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Incorrect username or password.' });

    const unknown = await api<ApiErrorBody>(ctx.url, '/api/auth/login', { body: { login: 'ghost', password: 'whatever1' } });
    expect(unknown.status).toBe(401);

    const ok = await api<AuthResponse>(ctx.url, '/api/auth/login', { body: { login: 'pilot@example.com', password: 'correct-horse-1' } });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
  });

  it('returns friendly field errors', async () => {
    const r = await api<ApiErrorBody>(ctx.url, '/api/auth/register', { body: { username: 'x', password: '1' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION');
    expect(r.body.error.fields).toHaveProperty('username');
    expect(r.body.error.fields).toHaveProperty('password');
  });

  it('upgrades a guest account in place, keeping its id', async () => {
    const g = await guest(ctx.url);
    const r = await api<AuthResponse>(ctx.url, '/api/auth/register', {
      token: g.accessToken,
      body: { username: 'upgraded_guest', password: 'password-123' },
    });
    expect(r.status).toBe(201);
    expect(r.body.user.id).toBe(g.user.id);
    expect(r.body.user.isGuest).toBe(false);
  });
});

describe('sessions', () => {
  it('serves /me only with a valid token', async () => {
    const g = await guest(ctx.url, 'Comet');
    expect((await api(ctx.url, '/api/auth/me')).status).toBe(401);
    expect((await api(ctx.url, '/api/auth/me', { token: 'garbage' })).status).toBe(401);
    const me = await api<{ user: { displayName: string } }>(ctx.url, '/api/auth/me', { token: g.accessToken });
    expect(me.body.user.displayName).toBe('Comet');
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const g = await guest(ctx.url);
    const first = await api<AuthResponse>(ctx.url, '/api/auth/refresh', { method: 'POST', cookie: g.cookie, headers: CSRF });
    expect(first.status).toBe(200);
    expect(first.cookie).not.toBe(g.cookie);

    // Re-using the old (rotated) token is treated as theft…
    const reuse = await api(ctx.url, '/api/auth/refresh', { method: 'POST', cookie: g.cookie, headers: CSRF });
    expect(reuse.status).toBe(401);
    // …and the newer token in the same family is revoked too.
    const after = await api(ctx.url, '/api/auth/refresh', { method: 'POST', cookie: first.cookie!, headers: CSRF });
    expect(after.status).toBe(401);
  });

  it('requires CSRF protections on cookie endpoints', async () => {
    const g = await guest(ctx.url);
    const noHeader = await api(ctx.url, '/api/auth/refresh', { method: 'POST', cookie: g.cookie });
    expect(noHeader.status).toBe(403);
    const badOrigin = await api(ctx.url, '/api/auth/refresh', {
      method: 'POST',
      cookie: g.cookie,
      headers: { 'x-requested-with': 'ludo', origin: 'https://evil.example' },
    });
    expect(badOrigin.status).toBe(403);
  });

  it('logs out by revoking the refresh session', async () => {
    const g = await guest(ctx.url);
    expect((await api(ctx.url, '/api/auth/logout', { method: 'POST', cookie: g.cookie, headers: CSRF })).status).toBe(204);
    expect((await api(ctx.url, '/api/auth/refresh', { method: 'POST', cookie: g.cookie, headers: CSRF })).status).toBe(401);
  });
});

describe('profile and leaderboard', () => {
  it('only allows cosmetic profile changes', async () => {
    const g = await guest(ctx.url);
    const r = await api<ProfileView>(ctx.url, '/api/profile/me', {
      method: 'PATCH',
      token: g.accessToken,
      body: { displayName: 'Stardust', avatar: 'saturn', gamesWon: 999, rating: 5000 },
    });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ displayName: 'Stardust', avatar: 'saturn' });
    expect(r.body.stats.gamesWon).toBe(0);
    expect(r.body.stats.rating).toBe(1200);
    expect(r.body.achievements.length).toBeGreaterThan(5);

    const bad = await api<ApiErrorBody>(ctx.url, '/api/profile/me', {
      method: 'PATCH',
      token: g.accessToken,
      body: { avatar: 'not-an-avatar' },
    });
    expect(bad.status).toBe(400);
  });

  it('serves leaderboards per category', async () => {
    for (const category of ['wins', 'games', 'captures', 'rating']) {
      const r = await api<LeaderboardResponse>(ctx.url, `/api/leaderboard?category=${category}`);
      expect(r.status).toBe(200);
      expect(r.body.category).toBe(category);
      expect(Array.isArray(r.body.entries)).toBe(true);
    }
    expect((await api(ctx.url, '/api/leaderboard?category=hacks')).status).toBe(400);
  });

  it('hides unknown games and players behind friendly 404s', async () => {
    const g = await guest(ctx.url);
    const r = await api<ApiErrorBody>(ctx.url, '/api/games/game_nope/replay', { token: g.accessToken });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('GAME_NOT_FOUND');
    expect((await api(ctx.url, '/api/profile/does-not-exist')).status).toBe(404);
  });
});
