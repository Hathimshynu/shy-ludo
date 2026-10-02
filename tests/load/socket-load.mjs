#!/usr/bin/env node
/**
 * Socket.IO load test for the Ludo Nova API.
 *
 *   LOAD_URL=http://localhost:4000 GAMES=25 PLAYERS=4 ACTIONS=80 node tests/load/socket-load.mjs
 *
 * Run it against a NON-production server started with RATE_LIMIT_DISABLED=true
 * (guest creation is rate limited per IP otherwise).
 *
 * Phases:
 *   1. many simultaneous Socket.IO connections (GAMES × PLAYERS guests)
 *   2. GAMES concurrent games, every player auto-playing (roll / first legal move)
 *   3. rapid dice requests + invalid payloads from abusive sockets (must be rejected, server stays up)
 *   4. reconnect storm: every socket drops and reconnects at once; time to session restore
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');

const BASE = process.env.LOAD_URL ?? 'http://localhost:4000';
const GAMES = Number(process.env.GAMES ?? 20);
const PLAYERS = Number(process.env.PLAYERS ?? 4);
const ACTIONS = Number(process.env.ACTIONS ?? 60);

const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (arr) => `p50 ${pct(arr, 50).toFixed(1)}ms · p95 ${pct(arr, 95).toFixed(1)}ms · p99 ${pct(arr, 99).toFixed(1)}ms · n=${arr.length}`;
const errors = new Map();
const countError = (code) => errors.set(code, (errors.get(code) ?? 0) + 1);

function emit(socket, event, payload, timeout = 10_000) {
  const started = performance.now();
  return new Promise((resolve) => {
    socket.timeout(timeout).emit(event, payload, (err, res) => {
      const ms = performance.now() - started;
      if (err) resolve({ ok: false, error: { code: 'TIMEOUT' }, ms });
      else resolve({ ...res, ms });
    });
  });
}

async function guest(i) {
  const res = await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: `Load ${i}` }),
  });
  if (!res.ok) throw new Error(`guest ${i} failed: ${res.status} (is RATE_LIMIT_DISABLED=true?)`);
  return res.json();
}

function connect(auth) {
  const started = performance.now();
  const socket = io(BASE, { auth: { token: auth.accessToken }, transports: ['websocket'], forceNew: true, reconnection: false });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({ socket, ms: performance.now() - started }));
    socket.once('connect_error', reject);
  });
}

// ---------------------------------------------------------------------------
console.log(`Target ${BASE} · ${GAMES} games × ${PLAYERS} players · ${ACTIONS} actions/game`);
const total = GAMES * PLAYERS;

// Phase 1 — connections
let t0 = performance.now();
const auths = await Promise.all(Array.from({ length: total }, (_, i) => guest(i)));
console.log(`\n[1] ${total} guest sessions in ${(performance.now() - t0).toFixed(0)}ms`);
t0 = performance.now();
const conns = await Promise.all(auths.map((a) => connect(a)));
console.log(`[1] ${total} sockets connected in ${(performance.now() - t0).toFixed(0)}ms · connect ${fmt(conns.map((c) => c.ms))}`);

// Phase 2 — concurrent games
const ackLatency = [];
let actions = 0;
const players = conns.map((c, i) => ({ socket: c.socket, id: auths[i].user.id, state: null }));
for (const p of players) {
  p.socket.on('game:start', (snap) => (p.state = snap.state));
  p.socket.on('game:state', (snap) => (p.state = snap.state));
  p.socket.on('game:events', ({ events }) => {
    if (!p.state) return;
    const last = events[events.length - 1];
    if (last && last.seq > p.state.seq) p.needsSync = true;
  });
}

async function playGame(group) {
  const [host, ...rest] = group;
  const settings = {
    maxPlayers: PLAYERS,
    turnTimeSeconds: 60,
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
  };
  const created = await emit(host.socket, 'room:create', { settings });
  if (!created.ok) return countError(`room:create ${created.error.code}`);
  for (const p of rest) {
    const j = await emit(p.socket, 'room:join', { code: created.room.code });
    if (!j.ok) return countError(`room:join ${j.error.code}`);
    await emit(p.socket, 'player:ready', { ready: true });
  }
  const started = await emit(host.socket, 'game:start', {});
  if (!started.ok) return countError(`game:start ${started.error.code}`);
  const gameId = started.gameId;
  let done = 0;
  while (done < ACTIONS) {
    // Ask the authority for the current snapshot (cheap) and let the current player act.
    // Rotate who syncs so no single socket exceeds its rate limit.
    const syncer = group[done % group.length];
    const sync = await emit(syncer.socket, 'game:sync', { gameId });
    if (!sync.ok) {
      if (sync.error.code === 'RATE_LIMITED') {
        await new Promise((res) => setTimeout(res, 250));
        continue;
      }
      return countError(`game:sync ${sync.error.code}`);
    }
    const s = sync.snapshot.state;
    if (s.status !== 'playing') return;
    const current = group.find((p) => p.id === s.turn.playerId);
    if (!current) return;
    const payload = { gameId, actionId: randomUUID(), expectedSeq: s.seq };
    const r =
      s.turn.phase === 'roll'
        ? await emit(current.socket, 'dice:roll', payload)
        : await emit(current.socket, 'token:move', { ...payload, tokenIndex: s.turn.legalMoves[0].tokenIndex });
    if (r.ok) {
      ackLatency.push(r.ms);
      actions += 1;
      done += 1;
    } else if (r.error.code === 'RATE_LIMITED') {
      await new Promise((res) => setTimeout(res, 250));
    } else if (r.error.code !== 'STALE_STATE') countError(`action ${r.error.code}`);
    // Stay under the per-socket rate limit like a fast human would.
    await new Promise((res) => setTimeout(res, 60));
  }
}

t0 = performance.now();
const groups = Array.from({ length: GAMES }, (_, g) => players.slice(g * PLAYERS, g * PLAYERS + PLAYERS));
await Promise.all(groups.map((grp) => playGame(grp)));
const playMs = performance.now() - t0;
console.log(`[2] ${GAMES} concurrent games · ${actions} authoritative actions in ${(playMs / 1000).toFixed(1)}s (${(actions / (playMs / 1000)).toFixed(0)} actions/s)`);
console.log(`[2] action ack latency ${fmt(ackLatency)}`);

// Phase 3 — abuse: rapid dice spam + invalid payloads
const abuser = players[0].socket;
const spam = await Promise.all(
  Array.from({ length: 300 }, () => emit(abuser, 'dice:roll', { gameId: 'game_x', actionId: randomUUID(), expectedSeq: 0 })),
);
const invalid = await Promise.all([
  emit(players[1].socket, 'dice:roll', { gameId: '../../etc', actionId: 'x', expectedSeq: -1 }),
  emit(players[1].socket, 'token:move', { gameId: 'g', actionId: randomUUID(), expectedSeq: 0, tokenIndex: 99 }),
  emit(players[1].socket, 'room:join', { code: 'DROP TABLE' }),
  emit(players[1].socket, 'matchmaking:join', { playerCount: 1000 }),
]);
const label = (r) => (r.error?.code === 'TIMEOUT' ? 'DROPPED(socket disconnected for abuse)' : (r.error?.code ?? 'OK'));
const spamCodes = spam.reduce((m, r) => m.set(label(r), (m.get(label(r)) ?? 0) + 1), new Map());
console.log(`[3] 300 rapid dice requests → ${[...spamCodes].map(([k, v]) => `${k}:${v}`).join(' ')}`);
console.log(`[3] invalid payloads → ${invalid.map((r) => r.error?.code ?? 'OK').join(', ')}`);
const memHint = ''; void memHint;
const health = await fetch(`${BASE}/health`).then((r) => r.json());
console.log(`[3] server health after abuse: ${health.status}`);

// Phase 4 — reconnect storm
for (const p of players) p.socket.disconnect();
await new Promise((r) => setTimeout(r, 300));
t0 = performance.now();
const restoreTimes = await Promise.all(
  auths.map(
    (a) =>
      new Promise((resolve) => {
        const started = performance.now();
        const s = io(BASE, { auth: { token: a.accessToken }, transports: ['websocket'], forceNew: true, reconnection: false });
        s.once('session:restore', () => {
          resolve(performance.now() - started);
          s.disconnect();
        });
        s.once('connect_error', () => resolve(Number.NaN));
      }),
  ),
);
const okRestores = restoreTimes.filter((x) => !Number.isNaN(x));
console.log(`[4] reconnect storm: ${okRestores.length}/${total} sessions restored in ${(performance.now() - t0).toFixed(0)}ms · ${fmt(okRestores)}`);

console.log(`\nErrors: ${errors.size === 0 ? 'none' : [...errors].map(([k, v]) => `${k}×${v}`).join(', ')}`);
process.exit(0);
