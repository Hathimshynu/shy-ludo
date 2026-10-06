# Production QA — Ludo Nova

Tracker for the production-readiness pass (October 2026). Every issue lists how it was
found, the root cause, the fix and the test that proves it. Nothing is marked **Fixed**
without a passing test.

Environment under test:

* Web: `https://shy-ludo-seven.vercel.app` (Vercel, `apps/web/vercel.json` rewrites `/api` → Render)
* API / Socket.IO: `https://ludo-nova-api.onrender.com` (Render free web service, PostgreSQL, Key Value/Redis)
* Local: built server (`apps/server/dist`) + embedded PostgreSQL; Playwright E2E harness

Severity: **P0** game cannot be played · **P1** major gameplay/connectivity failure ·
**P2** important UX/feature bug · **P3** minor.

## Issues

| ID | Category | Sev | Description | Reproduction | Root cause | Fix | Test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PQ-01 | Connectivity | P0 | Sign-up/login returned 404 on Vercel | `POST https://shy-ludo-seven.vercel.app/api/auth/register` → 404 | Stray space in the Vercel rewrite destination (`onrender.com /api/...`) | Removed the space (`dd5499e`) | Live: `scripts/live-smoke.mjs` register/login/refresh/logout all pass through the rewrite | Fixed |
| PQ-02 | Multiplayer | **P0** | Online games never started in production: players stayed in the lobby after the host pressed Start (private rooms and Quick Match) | Live smoke test: `game:start` received by 0/2 clients; debug script showed `room:update` arriving but never `game:start` | With `@socket.io/redis-adapter`, `io.in(user).socketsJoin()` only publishes a request; this instance's sockets join after the Redis round trip. `startFromRoom` emitted `game:start` immediately after seating players → event lost. Local/CI runs have no Redis, so tests never saw it | Broadcaster joins/leaves this instance's sockets synchronously (`io.local`) and then broadcasts to the cluster; web client falls back to `game:sync` once if the room is playing but `game:start` never arrived (`02edb28`) | `apps/server/test/broadcaster.test.ts` (Redis-style async adapter; fails without the fix); live smoke: 4/4 clients receive `game:start` | Fixed |
| PQ-03 | Security | P2 | Forged fields on game actions were silently ignored instead of rejected | `dice:roll` with `value: 6` → accepted (value stripped, real roll happened) | Non-strict zod schema stripped unknown keys | `dice:roll` / `token:move` schemas are strict → `VALIDATION` (`f02e913`) | validation + server integration tests; live: values 0, 7, −1, "6", 999, 6 and a forged `playerId` all rejected | Fixed |
| PQ-04 | Tests | P1 | 3 E2E tests timed out (two-browser, winner screen, phone+phone+desktop+tablet) | Full E2E run: 3 × timeout; individual reruns sometimes passed | Random dice make game length vary ~4× (2 players, 1 token: 21–90 actions; simulated over 3000 seeds); test budgets sat near the median | Per-game seeded dice + fixed first seat when the test-only `DICE_SEED` is set (refused in production); E2E-only solo seed (compiled out of production builds); seed 2216 chosen by simulation (`9621070`) | All three pass: 2.3 / 1.7 / 4.0 min (the 4-device test had never passed before) | Fixed |
| PQ-05 | Sync | P1 | A resync snapshot arriving during an animation was overwritten by the stale animation | Unit test: push events, snapshot mid-animation → `visual ≠ snapshot` | `GameDirector.play()` wrote its pre-snapshot state after its awaits | Snapshot epoch: animations from an older epoch stop writing (`6679097`) | `apps/web/test/sequence.test.ts` (fails without the fix) | Fixed |
| PQ-06 | Tooling | P3 | Smoke driver was disconnected as abusive on fast (local) servers | 6/8-player local runs stopped after ~79 actions | One socket issued a `game:sync` per action → per-socket token bucket → strikes → disconnect (server behaving correctly) | Driver spreads reads over all sockets and backs off on `RATE_LIMITED` | 6- and 8-player local runs pass 63/63 and 71/71 | Fixed |
| PQ-07 | Ops | P2 | First request after idle takes ~68 s | Live: `/health` 67.7 s on first call | Render free instance sleeps after 15 min idle | Not a code bug; documented in DEPLOYMENT.md. A paid instance (or an external keep-alive ping) removes it | — | Known limitation |
| PQ-08 | Feature | P2 | Replay endpoint had no UI | — | Not implemented | Replay viewer (`718d71c`) | `apps/web/test/replay.test.ts`; two-browser E2E watches its game's replay and checks the result | Done |
| PQ-09 | Feature | P2 | Friend table had no API/UI | — | Not implemented | Friends + room invites (`704eb81`) | `apps/server/test/friends.test.ts`; `tests/e2e/friends.spec.ts` | Done |

## Verification matrix

### Live production (`scripts/live-smoke.mjs`, real Vercel + Render + PostgreSQL + Redis)

| Check | 2 players | 4 players |
| --- | --- | --- |
| `/health`, `/health/ready` (DB + Redis) | PASS | PASS |
| Guest via `/api` rewrite, refresh cookie set | PASS | PASS |
| Refresh rotates token; reused token rejected | PASS | PASS |
| CSRF header missing → 403; foreign Origin → 403 | PASS | PASS |
| Register / duplicate / invalid username / login / wrong password / logout / refresh after logout | PASS | PASS |
| Socket: forged token refused; authenticated connect over WebSocket from the Vercel origin | PASS | PASS |
| Private room create → join → ready → start; every client gets `game:start` | PASS | PASS |
| Anti-cheat: wrong turn, forged playerId, fake dice (0/7/−1/"6"/999/6), bad token, stale seq, foreign game, duplicate actionId | PASS | PASS |
| Mid-game disconnect → refresh → new socket → `session:restore` at the server's seq | PASS | PASS |
| Game played to the winner; identical event stream on every client (no gaps/duplicates) | PASS | PASS (615 events compared, 0 differ) |
| Actions after the finish rejected | PASS | PASS |
| Quick Match: N players join simultaneously → one game, everyone seated once | PASS (2) | PASS (4) |

6- and 8-player games were verified against a local production build (same code, no rate
limit on guest creation — production allows 30 guests/hour/IP): 63/63 and 71/71 checks,
2 193 and 6 267 events compared with 0 differences, Quick Match with 6 and 8 simultaneous
joins → one game each.

### Local

| Area | Result |
| --- | --- |
| Hard restart: SIGKILL the API mid-game, restart, reconnect (`scripts/restart-check.mjs`) | PASS — game, seq, turn, tokens preserved; 84 more actions to the finish |
| Client sequence handling: in-order, duplicates ignored, gap → resync, mid-animation snapshot | PASS (`apps/web/test/sequence.test.ts`) |
| Load test, 400 sockets / 100 four-player games (`tests/load/socket-load.mjs`) | PASS — 334–358 actions/s, ack p95 127–159 ms, 0 errors, reconnect storm 400/400 |
| Memory after load (3 runs on one instance) | Returns to ~101 MB once abandoned games pass the 120 s grace — no leak |
| Engine: full simulated games for 2–8 players, AI legal moves at every difficulty | PASS (engine test suite) |

### Not verified

| Item | Why |
| --- | --- |
| Real Android / iPhone devices | No physical devices in this environment; mobile coverage is Playwright emulation (Pixel 7, touch, 320–768 px). Manual check on a real phone recommended. |
| Live 8-player game on production | Production rate limit: 30 guest accounts per hour per IP; 6/8-player runs were done against a local production build |
| Render logs / dashboard, Vercel dashboard | No credentials; deployments were confirmed from the outside (new server behaviour observed live, new bundle served) |
| Multi-instance (horizontal) Socket.IO routing | Single instance by design; see README "Known limitations" |
| Text chat | Not implemented (lowest priority; would need moderation + reporting) |

## Production environment checklist

| Variable | Where | Expected |
| --- | --- | --- |
| `NODE_ENV` | Render | `production` (refuses `DICE_SEED`, `TEST_TURN_SECONDS`, `RATE_LIMIT_DISABLED`) |
| `DATABASE_URL` | Render | from the Render database |
| `REDIS_URL` | Render | from Render Key Value (optional; see below) |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Render | generated, ≥ 32 chars, different |
| `CLIENT_URL` | Render | `https://shy-ludo-seven.vercel.app` exactly (verified live: that origin is accepted, a foreign origin is refused) |
| `PORT` | Render | injected |
| `VITE_API_URL` | Vercel | `/api` |
| `VITE_SOCKET_URL` | Vercel | `https://ludo-nova-api.onrender.com` (verified in the live bundle; no localhost endpoints) |
| `VITE_SITE_URL` | Vercel | `https://shy-ludo-seven.vercel.app` |

No server secret is referenced from `apps/web` (only `VITE_*` values reach the bundle).

### What Redis is used for

With `REDIS_URL`: Socket.IO Redis adapter, matchmaking queue, room-code registry. Without
it, in-memory equivalents are used — correct for a single instance. Redis is required only
to run more than one API instance (which also needs sticky game ownership — not done).
If Redis becomes unreachable, ioredis keeps reconnecting in the background; commands
give up after 3 retries (`maxRetriesPerRequest: 3`), so creating rooms / Quick Match fail
with a friendly "Something went wrong" instead of hanging, and `/health/ready` reports the
failure. Games already running continue (their state lives in memory and PostgreSQL).
Render's health check uses `/health`, so the instance is not restarted for a Redis blip.
(Not tested against a real Redis outage — reasoned from the configuration.)
