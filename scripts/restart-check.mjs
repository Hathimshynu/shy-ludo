#!/usr/bin/env node
/**
 * Hard server-restart check against a real process and real PostgreSQL:
 * start the built API, play part of a game, SIGKILL the process, start it again, reconnect
 * both players and finish the game. Verifies the game, turn, tokens and event sequence
 * survive and that play continues.
 *
 *   npm run build:server && npm run db:local   # in another terminal
 *   node scripts/restart-check.mjs             # uses .env DATABASE_URL, port 4401
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const PORT = Number(process.env.PORT ?? 4401);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function startServer() {
  const child = spawn(process.execPath, ['--env-file=.env', 'apps/server/dist/index.js'], {
    env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), RATE_LIMIT_DISABLED: 'true', LOG_LEVEL: 'warn', REDIS_URL: '' },
    stdio: 'ignore',
  });
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) return;
    await sleep(500);
  }
  throw new Error('server did not start');
}
function connect(token, restore) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('session:restore', (p) => restore?.(p));
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}
const emit = (s, e, p) => new Promise((r) => s.timeout(10_000).emit(e, p, (err, res) => r(err ? { ok: false, error: { code: 'TIMEOUT' } } : res)));

/** Snapshot with back-off: the per-socket rate limiter throttles a tight loop of syncs. */
async function syncState(socket, gameId) {
  for (let i = 0; i < 20; i += 1) {
    const r = await emit(socket, 'game:sync', { gameId });
    if (r.ok) return r.snapshot.state;
    if (r.error?.code !== 'RATE_LIMITED') return null;
    await sleep(400);
  }
  return null;
}

async function play(sockets, ids, gameId, maxActions) {
  let n = 0;
  for (; n < maxActions; n += 1) {
    const s = await syncState(sockets[n % 2], gameId);
    if (!s) return { state: null, n };
    if (s.status !== 'playing') return { state: s, n };
    const me = sockets[ids.indexOf(s.turn.playerId)];
    const base = { gameId, actionId: randomUUID(), expectedSeq: s.seq };
    if (s.turn.phase === 'roll') await emit(me, 'dice:roll', base);
    else await emit(me, 'token:move', { ...base, tokenIndex: s.turn.legalMoves[0].tokenIndex });
  }
  return { state: await syncState(sockets[0], gameId), n };
}

let server = startServer();
await waitHealthy();
const auths = [];
for (let i = 0; i < 2; i += 1) {
  const r = await fetch(`${BASE}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: `Restart ${i}` }) });
  auths.push(await r.json());
}
const ids = auths.map((a) => a.user.id);
let sockets = await Promise.all(auths.map((a) => connect(a.accessToken)));
const settings = { maxPlayers: 2, turnTimeSeconds: 60, tokensPerPlayer: 2, variants: { requireSixToStart: false, extraTurnOnSix: true, extraTurnOnCapture: true, extraTurnOnHome: true, threeSixPenalty: true, exactHomeEntry: true, allowBlockades: false, continueAfterWinner: false } };
const room = await emit(sockets[0], 'room:create', { settings });
await emit(sockets[1], 'room:join', { code: room.room.code });
await emit(sockets[1], 'player:ready', { ready: true });
const { gameId } = await emit(sockets[0], 'game:start', {});
const before = (await play(sockets, ids, gameId, 12)).state;
check('game in progress before the crash', before?.status === 'playing', `seq ${before?.seq}`);
await sleep(300); // let the last snapshot be persisted

server.kill('SIGKILL');
await sleep(1000);
check('server process killed', server.killed || server.exitCode !== null);
server = startServer();
await waitHealthy();

const restored = [];
sockets = await Promise.all(auths.map((a, i) => connect(a.accessToken, (p) => (restored[i] = p))));
await sleep(1000);
const r0 = restored[0]?.game?.state;
check('both players get the running game back after the restart', restored.every((p) => p?.game?.state.id === gameId), restored.map((p) => p?.game?.state.id ?? 'none').join(','));
check('sequence preserved', r0?.seq === before?.seq, `${before?.seq} → ${r0?.seq}`);
check('turn preserved', r0?.turn.playerId === before?.turn.playerId && r0?.turn.phase === before?.turn.phase, `${before?.turn.phase} → ${r0?.turn.phase}`);
check('tokens preserved', JSON.stringify(r0?.players.map((p) => p.tokens)) === JSON.stringify(before?.players.map((p) => p.tokens)));
const after = await play(sockets, ids, gameId, 3000);
check('play continues to the finish after the restart', after.state === null || after.state.status === 'finished', `${after.n} more actions`);
sockets.forEach((s) => s.disconnect());
server.kill();
console.log(failed ? `\n${failed} check(s) failed` : '\nall restart checks passed');
process.exit(failed ? 1 : 0);
