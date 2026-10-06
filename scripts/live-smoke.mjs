#!/usr/bin/env node
/**
 * Live end-to-end smoke test for a deployed Ludo Nova (or a local stack).
 *
 * It behaves exactly like browsers on the web origin: REST goes through `${WEB_URL}/api`
 * (the Vercel → Render rewrite) with the web Origin and the CSRF header, each client keeps
 * its own refresh-cookie jar, and Socket.IO connects to SOCKET_URL with the web Origin.
 *
 *   WEB_URL=https://shy-ludo-seven.vercel.app SOCKET_URL=https://ludo-nova-api.onrender.com \
 *   PLAYERS=2 node scripts/live-smoke.mjs
 *
 * Checks: health, guest / register / login / me / refresh rotation / logout, CSRF + origin
 * rejection, socket auth (valid + forged token), private room create/join/ready/start, a full
 * game played to the winner by PLAYERS clients, gap-free ordered events on every client,
 * anti-cheat (fake dice, wrong turn, bad token, stale seq, duplicate action, forged game,
 * forged player id), mid-game reconnect with session restore, identical final state on every
 * client, actions rejected after the finish, and Quick Match pairing.
 *
 * Creates real guest accounts and one `smoke_*` registered account on the target.
 * Guest creation is rate limited per IP (30/hour) — keep PLAYERS modest against production.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');

const WEB = (process.env.WEB_URL ?? 'https://shy-ludo-seven.vercel.app').replace(/\/$/, '');
const SOCKET = (process.env.SOCKET_URL ?? 'https://ludo-nova-api.onrender.com').replace(/\/$/, '');
const API = process.env.API_URL ?? `${WEB}/api`;
const PLAYERS = Number(process.env.PLAYERS ?? 2);
const QUICK = Number(process.env.QUICK ?? 2);
const TRANSPORTS = (process.env.TRANSPORTS ?? 'websocket,polling').split(',');
const ORIGIN = process.env.ORIGIN ?? WEB;

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- REST with a per-client cookie jar ---------------------------------------------------

class Client {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
    this.token = null;
    this.user = null;
    this.socket = null;
    this.seqs = [];
    this.gaps = 0;
    this.dupes = 0;
    this.lastSeq = null;
    this.finish = null;
    this.restored = null;
    this.started = null;
  }

  async rest(method, path, body, extra = {}) {
    const headers = {
      'content-type': 'application/json',
      origin: extra.origin ?? ORIGIN,
      ...(extra.noCsrf ? {} : { 'x-requested-with': 'ludo' }),
      ...(this.token && !extra.noAuth ? { authorization: `Bearer ${extra.badToken ?? this.token}` } : {}),
      ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    };
    const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty */
    }
    return { status: res.status, json };
  }

  adopt(session) {
    this.token = session.accessToken;
    this.user = session.user;
  }

  connect(token = this.token) {
    return new Promise((resolve, reject) => {
      const socket = io(SOCKET, {
        auth: { token },
        transports: TRANSPORTS,
        forceNew: true,
        reconnection: false,
        extraHeaders: { origin: ORIGIN },
        timeout: 20_000,
      });
      socket.on('game:start', (snap) => {
        this.started = snap;
        this.lastSeq = snap.state.seq;
      });
      socket.on('session:restore', (p) => {
        this.restored = p;
        if (p.game) this.lastSeq = p.game.state.seq;
      });
      socket.on('game:state', (snap) => {
        this.lastSeq = snap.state.seq;
      });
      socket.on('game:events', ({ events }) => {
        for (const e of events) {
          if (this.lastSeq !== null) {
            if (e.seq <= this.lastSeq) this.dupes += 1;
            else if (e.seq !== this.lastSeq + 1) this.gaps += 1;
          }
          if (this.lastSeq === null || e.seq > this.lastSeq) this.lastSeq = e.seq;
          this.seqs.push(e.seq);
        }
      });
      socket.on('game:finish', (p) => (this.finish = p));
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (err) => reject(err));
    });
  }

  emit(event, payload, timeout = 15_000) {
    return new Promise((resolve) => {
      this.socket.timeout(timeout).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: { code: 'TIMEOUT' } } : res));
    });
  }
}

async function sync(client, gameId) {
  const r = await client.emit('game:sync', { gameId });
  return r.ok ? r.snapshot.state : null;
}

const settings = (maxPlayers) => ({
  maxPlayers,
  turnTimeSeconds: 30,
  tokensPerPlayer: 1,
  variants: {
    requireSixToStart: false,
    extraTurnOnSix: true,
    extraTurnOnCapture: true,
    extraTurnOnHome: true,
    threeSixPenalty: true,
    exactHomeEntry: true,
    allowBlockades: false,
    continueAfterWinner: false,
  },
});

/** One action for whoever's turn it is (via that player's own socket). */
async function act(clients, gameId) {
  const s = await sync(clients[0], gameId);
  if (!s || s.status !== 'playing') return s;
  const me = clients.find((c) => c.user.id === s.turn.playerId);
  if (!me) throw new Error(`turn belongs to unknown player ${s.turn.playerId}`);
  const base = { gameId, actionId: randomUUID(), expectedSeq: s.seq };
  const r =
    s.turn.phase === 'roll'
      ? await me.emit('dice:roll', base)
      : await me.emit('token:move', { ...base, tokenIndex: s.turn.legalMoves[0].tokenIndex });
  if (!r.ok && !['STALE_STATE', 'WRONG_PHASE', 'RATE_LIMITED'].includes(r.error.code)) throw new Error(`action failed: ${r.error.code}`);
  if (!r.ok && r.error.code === 'RATE_LIMITED') await sleep(500);
  return s;
}

// ---------------------------------------------------------------------------------------

console.log(`Web ${WEB} · API ${API} · Socket ${SOCKET} · ${PLAYERS} players · transports ${TRANSPORTS.join('+')}\n`);

// 1. Health (direct to the API host — it is not under /api)
{
  const t = performance.now();
  const h = await fetch(`${SOCKET}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  check('API /health', h.status === 'ok', `${Math.round(performance.now() - t)} ms (includes cold start)`);
  const ready = await fetch(`${SOCKET}/health/ready`).then(async (r) => ({ status: r.status, body: await r.json() })).catch(() => null);
  check('API /health/ready (PostgreSQL + Redis)', ready?.status === 200, JSON.stringify(ready?.body ?? null));
}

// 2. Auth through the Vercel rewrite
const clients = Array.from({ length: PLAYERS }, (_, i) => new Client(`P${i + 1}`));
for (const [i, c] of clients.entries()) {
  const r = await c.rest('POST', '/auth/guest', { displayName: `Smoke ${i + 1}` });
  check(`guest session ${c.label} via ${new URL(API).host}`, (r.status === 200 || r.status === 201) && !!r.json?.accessToken && c.cookies.has('ln_rt'), `status ${r.status}, refresh cookie ${c.cookies.has('ln_rt')}`);
  if (r.status !== 200 && r.status !== 201) {
    console.log('Cannot continue without sessions.', r.json);
    process.exit(1);
  }
  c.adopt(r.json);
}
{
  const c = clients[0];
  const before = c.cookies.get('ln_rt');
  const r = await c.rest('POST', '/auth/refresh', undefined, { noAuth: true });
  check('refresh with cookie (first-party via rewrite) rotates the token', r.status === 200 && c.cookies.get('ln_rt') !== before, `status ${r.status}`);
  if (r.status === 200) c.adopt(r.json);
  const stale = new Client('stale');
  stale.cookies.set('ln_rt', before);
  const reuse = await stale.rest('POST', '/auth/refresh', undefined, { noAuth: true });
  check('rotated (old) refresh token is rejected', reuse.status === 401, `status ${reuse.status}`);
  const noCsrf = await c.rest('POST', '/auth/refresh', undefined, { noAuth: true, noCsrf: true });
  check('refresh without X-Requested-With is rejected (CSRF)', noCsrf.status === 403, `status ${noCsrf.status}`);
  const evil = await c.rest('POST', '/auth/refresh', undefined, { noAuth: true, origin: 'https://evil.example' });
  check('refresh from a foreign Origin is rejected', evil.status === 403, `status ${evil.status}`);
  const me = await c.rest('GET', '/auth/me');
  check('/auth/me with access token', me.status === 200 && me.json?.user?.id === c.user.id, `status ${me.status}`);
  const bad = await c.rest('GET', '/auth/me', undefined, { badToken: 'not.a.jwt' });
  check('/auth/me with a forged token is rejected', bad.status === 401, `status ${bad.status}`);
}
{
  const u = new Client('reg');
  const username = `smoke_${randomUUID().slice(0, 8)}`;
  const password = `Pw-${randomUUID()}`;
  const reg = await u.rest('POST', '/auth/register', { username, password });
  check(`register (${username})`, reg.status === 201 && !!reg.json?.accessToken, `status ${reg.status} ${reg.status >= 400 ? JSON.stringify(reg.json) : ''}`);
  const dup = await new Client('dup').rest('POST', '/auth/register', { username, password });
  check('duplicate username is rejected', dup.status === 409 || dup.status === 400, `status ${dup.status}`);
  const badName = await new Client('bad').rest('POST', '/auth/register', { username: 'a@b.c', password });
  check('invalid username gets a field error (not a 404/500)', badName.status === 400 && !!badName.json?.error?.fields?.username, `status ${badName.status}`);
  const login = new Client('login');
  const li = await login.rest('POST', '/auth/login', { login: username, password });
  check('login', li.status === 200 && li.json?.user?.username === username && login.cookies.has('ln_rt'), `status ${li.status}`);
  const wrong = await new Client('wrong').rest('POST', '/auth/login', { login: username, password: 'wrong-password' });
  check('wrong password is rejected', wrong.status === 401, `status ${wrong.status}`);
  login.adopt(li.json);
  const out = await login.rest('POST', '/auth/logout');
  check('logout', out.status === 200 || out.status === 204, `status ${out.status}`);
  const after = await login.rest('POST', '/auth/refresh', undefined, { noAuth: true });
  check('refresh after logout is rejected', after.status === 401, `status ${after.status}`);
}

// 3. Socket auth
{
  const forged = await new Client('forged').connect('forged.token.value').then(
    (s) => (s.disconnect(), 'connected'),
    (e) => e.message,
  );
  check('socket with a forged token is refused', forged !== 'connected', forged);
  for (const c of clients) {
    const t = performance.now();
    c.socket = await c.connect();
    check(`socket ${c.label} connected (${c.socket.io.engine.transport.name})`, c.socket.connected, `${Math.round(performance.now() - t)} ms`);
  }
  const ping = await clients[0].emit('time:ping', { clientTime: Date.now() });
  check('authenticated socket round trip (time:ping)', ping.ok === true);
}

// 4. Private room
const [host, ...guests] = clients;
const created = await host.emit('room:create', { settings: settings(PLAYERS) });
check('room:create returns a code', created.ok && /^[A-Z0-9]{4,8}$/.test(created.room?.code ?? ''), created.ok ? created.room.code : created.error?.code);
for (const g of guests) {
  const j = await g.emit('room:join', { code: created.room.code });
  check(`${g.label} joins room ${created.room?.code}`, j.ok, j.ok ? '' : j.error.code);
  const r = await g.emit('player:ready', { ready: true });
  check(`${g.label} ready`, r.ok, r.ok ? '' : r.error.code);
}
const started = await host.emit('game:start', {});
check('host starts the game', started.ok, started.ok ? started.gameId : started.error?.code);
const gameId = started.gameId;
await sleep(1500);
check('every client received game:start for the same game', clients.every((c) => c.started?.state.id === gameId), clients.map((c) => c.started?.state.id ?? 'none').join(','));

// 5. Play, with anti-cheat probes and a reconnect in the middle
let actions = 0;
let probed = false;
let reconnected = false;
const t0 = performance.now();
for (;;) {
  const s = await act(clients, gameId);
  actions += 1;
  if (!s || s.status !== 'playing') break;
  if (!probed && actions >= 6) {
    probed = true;
    const cur = await sync(host, gameId);
    const turn = clients.find((c) => c.user.id === cur.turn.playerId);
    const other = clients.find((c) => c !== turn);
    const id = () => randomUUID();
    const base = { gameId, expectedSeq: cur.seq };
    const wrongTurn = await other.emit('dice:roll', { ...base, actionId: id() });
    check('dice roll on someone else’s turn is rejected', wrongTurn.error?.code === 'NOT_YOUR_TURN', wrongTurn.error?.code);
    const forgedPlayer = await other.emit('dice:roll', { ...base, actionId: id(), playerId: turn.user.id });
    check('forged playerId in payload is rejected', !forgedPlayer.ok, forgedPlayer.error?.code);
    for (const value of [0, 7, -1, '6', 999, 6]) {
      const r = await turn.emit('dice:roll', { ...base, actionId: id(), value });
      check(`client-chosen dice value ${JSON.stringify(value)} is rejected`, !r.ok && r.error.code === 'VALIDATION', r.ok ? 'ACCEPTED' : r.error.code);
    }
    const badToken = await turn.emit('token:move', { ...base, actionId: id(), tokenIndex: 7 });
    check('move of a non-existent token is rejected', !badToken.ok, badToken.error?.code);
    const stale = await turn.emit('dice:roll', { ...base, actionId: id(), expectedSeq: cur.seq + 5 });
    check('stale expectedSeq is rejected', stale.error?.code === 'STALE_STATE', stale.error?.code);
    const forgedGame = await turn.emit('dice:roll', { ...base, actionId: id(), gameId: 'game_forged' });
    check('action on a game the player is not in is rejected', !forgedGame.ok, forgedGame.error?.code);
    if (cur.turn.phase === 'roll') {
      const actionId = id();
      const first = await turn.emit('dice:roll', { ...base, actionId });
      const second = await turn.emit('dice:roll', { ...base, actionId });
      check('duplicate actionId is applied once', first.ok && second.error?.code === 'DUPLICATE_ACTION', `${first.ok ? 'OK' : first.error.code} / ${second.ok ? 'OK' : second.error?.code}`);
    }
  }
  if (!reconnected && actions >= 14) {
    reconnected = true;
    const c = clients[clients.length - 1];
    c.socket.disconnect();
    await sleep(1500);
    // Like a page reload: refresh the session from the cookie, open a new socket.
    const r = await c.rest('POST', '/auth/refresh', undefined, { noAuth: true });
    if (r.status === 200) c.adopt(r.json);
    c.restored = null;
    c.lastSeq = null;
    c.socket = await c.connect();
    await sleep(1500);
    const server = await sync(host, gameId);
    check(
      'reconnect restores the running game (session:restore)',
      c.restored?.game?.state.id === gameId && c.restored.game.state.seq <= server.seq,
      `restored seq ${c.restored?.game?.state.seq ?? 'none'} / server ${server.seq}`,
    );
  }
  if (actions > 3000) {
    check('game finishes', false, 'gave up after 3000 actions');
    break;
  }
}
const ms = performance.now() - t0;
await sleep(2000);
const finals = await Promise.all(clients.map((c) => sync(c, gameId)));
check(`game finished after ${actions} actions`, finals.every((s) => s?.status === 'finished'), `${(ms / 1000).toFixed(1)} s, ${(ms / actions).toFixed(0)} ms/action`);
const ref = JSON.stringify(finals[0]);
check('every client sees an identical final state', finals.every((s) => JSON.stringify(s) === ref), `winner ${finals[0]?.rankings?.[0]}`);
check('every client received game:finish with the same rankings', clients.every((c) => JSON.stringify(c.finish?.rankings) === JSON.stringify(finals[0]?.rankings)));
check('no client saw a sequence gap or duplicate', clients.every((c) => c.gaps === 0 && c.dupes === 0), clients.map((c) => `${c.label}:${c.seqs.length}ev/${c.gaps}gap/${c.dupes}dup`).join(' '));
{
  const s = finals[0];
  const r = await host.emit('dice:roll', { gameId, actionId: randomUUID(), expectedSeq: s.seq });
  check('actions after the game finished are rejected', !r.ok, r.error?.code);
}
for (const c of clients) c.socket.disconnect();

// 6. Quick Match
if (QUICK >= 2) {
  const q = Array.from({ length: QUICK }, (_, i) => new Client(`Q${i + 1}`));
  for (const [i, c] of q.entries()) {
    const r = await c.rest('POST', '/auth/guest', { displayName: `Quick ${i + 1}` });
    if (r.status !== 200 && r.status !== 201) {
      check('quick match guests', false, `guest status ${r.status}`);
      break;
    }
    c.adopt(r.json);
    c.socket = await c.connect();
  }
  if (q.every((c) => c.socket)) {
    // Join at (almost) the same moment to exercise the matchmaking race.
    const joins = await Promise.all(q.map((c) => c.emit('matchmaking:join', { playerCount: QUICK })));
    check(`${QUICK} players join quick match simultaneously`, joins.every((j) => j.ok), joins.map((j) => (j.ok ? 'ok' : j.error.code)).join(','));
    for (let i = 0; i < 40 && !q.every((c) => c.started); i += 1) await sleep(500);
    const ids = new Set(q.map((c) => c.started?.state.id));
    check('quick match puts everyone in one game', ids.size === 1 && !ids.has(undefined), [...ids].join(','));
    const seated = q.map((c) => c.started?.state.players.map((p) => p.id).sort().join(','));
    check('every player is seated exactly once', new Set(seated).size === 1 && q.every((c) => seated[0]?.includes(c.user.id)));
    const qid = q[0].started?.state.id;
    if (qid) for (const c of q) await c.emit('game:leave', { gameId: qid });
  }
  for (const c of q) c.socket?.disconnect();
}

console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
