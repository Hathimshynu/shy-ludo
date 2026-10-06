import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiErrorBody, AuthResponse, FriendInvite, FriendRequestResult, FriendsResponse, RoomView } from '@ludo/shared-types';
import { api, guest, startTestServer, TestClient, type TestServer, testSettings } from './harness';

let ctx: TestServer;
const open: TestClient[] = [];
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  open.forEach((c) => c.close());
  await ctx?.close();
});

let n = 0;
async function register(name: string): Promise<AuthResponse> {
  n += 1;
  const r = await api<AuthResponse>(ctx.url, '/api/auth/register', {
    body: { username: `${name}${n}`, password: 'friend-pass-123', email: `${name}${n}@example.com` },
  });
  expect(r.status).toBe(201);
  return r.body;
}
const list = (a: AuthResponse) => api<FriendsResponse>(ctx.url, '/api/friends', { token: a.accessToken });
const request = (a: AuthResponse, username: string) =>
  api<FriendRequestResult & ApiErrorBody>(ctx.url, '/api/friends/requests', { token: a.accessToken, body: { username } });

describe('friends', () => {
  it('request → accept → listed on both sides → remove', async () => {
    const ann = await register('ann');
    const bob = await register('bob');
    const sent = await request(ann, bob.user.username);
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe('pending');

    expect((await list(ann)).body.outgoing.map((e) => e.user.id)).toEqual([bob.user.id]);
    expect((await list(bob)).body.incoming.map((e) => e.user.id)).toEqual([ann.user.id]);

    const accepted = await api(ctx.url, `/api/friends/requests/${ann.user.id}/accept`, { method: 'POST', token: bob.accessToken });
    expect(accepted.status).toBe(204);
    expect((await list(ann)).body.friends.map((e) => e.user.id)).toEqual([bob.user.id]);
    expect((await list(bob)).body.friends.map((e) => e.user.id)).toEqual([ann.user.id]);

    // Private data never leaks: only public profile fields.
    const raw = JSON.stringify((await list(ann)).body);
    expect(raw).not.toContain('@example.com');
    expect(raw).not.toContain('passwordHash');

    const again = await request(ann, bob.user.username);
    expect(again.status).toBe(409);

    expect((await api(ctx.url, `/api/friends/${ann.user.id}`, { method: 'DELETE', token: bob.accessToken })).status).toBe(204);
    expect((await list(ann)).body.friends).toEqual([]);
  });

  it('a crossed request accepts instead of duplicating; reject and cancel work', async () => {
    const cat = await register('cat');
    const dan = await register('dan');
    await request(cat, dan.user.username);
    const crossed = await request(dan, cat.user.username);
    expect(crossed.body.status).toBe('accepted');
    expect((await list(cat)).body.friends).toHaveLength(1);

    const eve = await register('eve');
    await request(eve, cat.user.username);
    expect((await api(ctx.url, `/api/friends/requests/${eve.user.id}/reject`, { method: 'POST', token: cat.accessToken })).status).toBe(204);
    expect((await list(eve)).body.outgoing).toEqual([]);

    await request(eve, dan.user.username);
    expect((await api(ctx.url, `/api/friends/${dan.user.id}`, { method: 'DELETE', token: eve.accessToken })).status).toBe(204);
    expect((await list(dan)).body.incoming).toEqual([]);
  });

  it('enforces permissions server-side', async () => {
    const fay = await register('fay');
    const gus = await register('gus');
    const hal = await register('hal');
    await request(fay, gus.user.username);
    // Only the addressee can accept or reject; a third player cannot.
    expect((await api(ctx.url, `/api/friends/requests/${fay.user.id}/accept`, { method: 'POST', token: hal.accessToken })).status).toBe(404);
    expect((await api(ctx.url, `/api/friends/requests/${gus.user.id}/accept`, { method: 'POST', token: fay.accessToken })).status).toBe(404);
    // Unauthenticated, self, unknown, guest, malformed.
    expect((await api(ctx.url, '/api/friends')).status).toBe(401);
    expect((await request(fay, fay.user.username)).status).toBe(400);
    expect((await request(fay, 'nobody_by_that_name')).status).toBe(404);
    const g = await guest(ctx.url);
    expect((await request(g, fay.user.username)).status).toBe(403);
    expect((await request(fay, g.user.username)).status).toBe(404);
    expect((await api(ctx.url, '/api/friends/requests', { token: fay.accessToken, body: { username: '' } })).status).toBe(400);
    expect((await api(ctx.url, '/api/friends/../../etc', { method: 'DELETE', token: fay.accessToken })).status).toBe(404);
  });

  it('invites only friends to a private room, and the friend receives the room code', async () => {
    const ivy = await register('ivy');
    const jon = await register('jon');
    const kim = await register('kim');
    await request(ivy, jon.user.username);
    await api(ctx.url, `/api/friends/requests/${ivy.user.id}/accept`, { method: 'POST', token: jon.accessToken });

    const host = new TestClient(ctx.url, ivy);
    const friend = new TestClient(ctx.url, jon);
    const stranger = new TestClient(ctx.url, kim);
    open.push(host, friend, stranger);
    await Promise.all([host.connected(), friend.connected(), stranger.connected()]);

    // Not in a room yet.
    expect((await host.emit('friend:invite', { userId: jon.user.id })).error?.code).toBe('NOT_IN_ROOM');

    const { room } = (await host.emit('room:create', { settings: testSettings() })) as { room: RoomView };
    const invite = new Promise<FriendInvite>((resolve) => friend.socket.on('friend:invite', resolve));
    let strangerInvited = false;
    stranger.socket.on('friend:invite', () => (strangerInvited = true));

    expect((await host.emit('friend:invite', { userId: jon.user.id })).ok).toBe(true);
    const got = await invite;
    expect(got.code).toBe(room.code);
    expect(got.from.id).toBe(ivy.user.id);
    expect(JSON.stringify(got)).not.toContain('@example.com');

    // Not friends → refused, nothing delivered.
    expect((await host.emit('friend:invite', { userId: kim.user.id })).error?.code).toBe('FORBIDDEN');
    expect((await host.emit('friend:invite', { userId: 'not a valid id!' })).error?.code).toBe('VALIDATION');
    await new Promise((r) => setTimeout(r, 200));
    expect(strangerInvited).toBe(false);
  });
});
