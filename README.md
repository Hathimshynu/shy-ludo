# Ludo Nova

**Play. Roll. Conquer.** — an original, server-authoritative 3D Ludo game for 2–8 players.
Online quick match, private rooms with friends, and solo play against four levels of AI.

> "Ludo Nova" is a temporary original brand. Every brand string lives in
> [`packages/config/src/brand.ts`](packages/config/src/brand.ts); the logo/favicon in
> `apps/web/public/favicon.svg` and `apps/web/src/components/ui.tsx`. All artwork, 3D models
> (procedural), sounds and music (synthesised at runtime) are original.

| | |
| --- | --- |
| Frontend | React 19, Vite, React Three Fiber, Drei, postprocessing, Zustand — deployed to **Vercel** |
| Backend | Node 24, Express 5, Socket.IO 4, Prisma 6 — deployed to **Render** |
| Data | PostgreSQL (Render PostgreSQL), Redis (Render Key Value, optional) |
| Tests | Vitest (engine, validation, web, server integration), Playwright (E2E) |

Further reading: [ARCHITECTURE.md](ARCHITECTURE.md) · [GAME_RULES.md](GAME_RULES.md) ·
[MULTIPLAYER.md](MULTIPLAYER.md) · [DEPLOYMENT.md](DEPLOYMENT.md)

---

## 1. Architecture

```text
apps/web  ──HTTPS /api──▶  apps/server (Express) ──▶ PostgreSQL (events, snapshots, users, stats)
   │                         │
   └──── Socket.IO (WSS) ────┘  GameSessionManager → @ludo/game-engine (authoritative rules)
                                RoomManager · Matchmaker ──▶ Redis (queue, room codes, adapter)
```

* **`packages/game-engine`** — pure TypeScript rules engine (`applyAction`), event
  projection (`applyEvent`), board geometry for 4/6/8-arm boards, AI. No I/O, injectable dice.
* **Server authority** — the client sends *intents* (`dice:roll`, `token:move` with
  `actionId` + `expectedSeq`); the server validates, applies the engine, persists events +
  snapshot, then broadcasts ordered `game:events`. Clients only animate.
* **Solo mode** runs the same engine and AI in a Web Worker.

Details: [ARCHITECTURE.md](ARCHITECTURE.md).

```text
apps/
  server/    Express API, Socket.IO gateway, rooms, matchmaking, sessions, auth
  web/       React SPA, 3D scene (src/three), GameDirector (src/game), stores
packages/
  game-engine/   rules, board, dice, AI, projection (+ tests)
  shared-types/  types & socket contracts
  validation/    zod schemas (+ tests)
  config/        brand & limits
prisma/          schema.prisma + migrations
tests/e2e/       Playwright end-to-end tests
tests/load/      Socket.IO load test
scripts/         local PostgreSQL without Docker
```

## 2. Local installation

Requirements: **Node 22+** (24 recommended), npm 10+. Docker is optional.

```bash
npm install                 # installs all workspaces and generates the Prisma client
cp .env.example .env        # then set JWT_SECRET / JWT_REFRESH_SECRET
```

Generate secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

## 3. Environment variables

Documented in [.env.example](.env.example). Summary:

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | server | PostgreSQL connection string |
| `REDIS_URL` | server | optional; Redis adapter + matchmaking queue + room codes |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | server | access-token signing, refresh-token hashing (≥ 32 chars, distinct) |
| `CLIENT_URL` | server | comma-separated allowed origins |
| `PORT`, `NODE_ENV`, `LOG_LEVEL`, `COOKIE_SAMESITE`, `TRUST_PROXY`, `DISCONNECT_GRACE_SECONDS` | server | runtime tuning |
| `VITE_API_URL` | web (public) | API base, default `/api` |
| `VITE_SOCKET_URL` | web (public) | Socket.IO origin; empty = same origin |
| `VITE_SITE_URL` | web (public) | canonical / OG / sitemap base URL |

`VITE_*` values are bundled into public JavaScript — **never** put secrets in them.
Do not set `NODE_ENV` in `.env` (Vite would read it and ship development React).

## 4. Database setup

Pick one:

```bash
npm run db:local            # embedded PostgreSQL, no Docker (data in ./.local-pg, port 5433)
# or
docker compose up postgres redis -d    # set POSTGRES_PASSWORD in .env, use port 5432
```

## 5. Prisma migration

```bash
npm run db:migrate          # development: create/apply migrations (prisma migrate dev)
npm run db:deploy           # production/CI: apply committed migrations
npm run db:generate         # regenerate the client after schema changes
```

Achievement definitions are seeded automatically when the server starts.

## 6. Running the frontend

```bash
npm run dev:web             # http://localhost:5173 (proxies /api and /socket.io to :4000)
```

## 7. Running the backend

```bash
npm run dev:server          # http://localhost:4000 · GET /health → {"status":"ok"}
```

Both at once: `npm run dev`.

## 8. Running tests

```bash
npm run lint                # ESLint (zero warnings)
npm run typecheck           # tsc in every workspace
npm run test:unit           # engine + validation + web unit tests
npm run test:integration    # API + Socket.IO + real PostgreSQL (embedded, auto-started)
npm run test:e2e            # Playwright: boots PostgreSQL, API and a production web build
npx playwright install chromium   # once, before the first E2E run
```

* Integration tests start an embedded PostgreSQL and clone a migrated template DB per
  test file. Set `TEST_DATABASE_ADMIN_URL` to use an existing server (CI does).
* The engine's dice are injectable (`createDiceEngine({ random })`, `createSequenceDice([...])`),
  so rule tests are fully deterministic.
* E2E projects: `desktop-chromium` (smoke, solo, multiplayer, quick match, 8 sessions, PWA)
  and `mobile-chromium` (`tests/e2e/mobile/`: 320–768 px portrait + landscape layouts, touch
  dice and token selection, double-tap guard, safe areas, orientation changes, Back button,
  audio hint, haptics, winner screen, phone + phone + desktop + tablet multiplayer).
  Run one project with `npm run test:e2e -- --project mobile-chromium`.

### Load testing

```bash
# terminal 1: a non-production server with HTTP rate limits off
RATE_LIMIT_DISABLED=true PORT=4400 npm run dev:server
# terminal 2
LOAD_URL=http://localhost:4400 GAMES=25 PLAYERS=4 ACTIONS=60 npm run test:load
```

Covers many simultaneous sockets, concurrent games, rapid dice requests, invalid
payloads and a reconnect storm, and prints latency percentiles.

## 9. Docker setup

```bash
cp .env.example .env        # set POSTGRES_PASSWORD, JWT_SECRET, JWT_REFRESH_SECRET
docker compose up --build   # web :8080 (nginx, proxies API) · api :4000 · postgres · redis
```

## 10. Vercel deployment

Root directory `apps/web`; `apps/web/vercel.json` handles install/build, SPA routing,
headers and the `/api` rewrite to Render. Set `VITE_API_URL=/api`,
`VITE_SOCKET_URL=https://<api>.onrender.com`, `VITE_SITE_URL`. Full steps:
[DEPLOYMENT.md](DEPLOYMENT.md#2-vercel-web).

## 11. Render deployment

`render.yaml` Blueprint creates free-tier API, PostgreSQL and Key Value services, wires
`DATABASE_URL`/`REDIS_URL`, generates JWT secrets, applies migrations at API startup and
uses `/health` as the health check. Set `CLIENT_URL`. The free database expires after
30 days; see limitations and full steps:
[DEPLOYMENT.md](DEPLOYMENT.md#1-render-api--postgresql--key-value).

## 12. Socket.IO architecture

* Authenticated handshake (`auth.token` = access JWT); identity is taken from the socket only.
* Rooms: `room:{id}` (lobby), `game:{id}` (players), `user:{id}` (all tabs of a user).
* Every client event is zod-validated, rate-limited per socket (token bucket) and acked with
  `{ ok, ... } | { ok: false, error: { code, message } }`.
* Game updates are one ordered `game:events` stream with gap-free `seq`; clients detect
  gaps and resync with `game:sync`. On reconnect the server sends `session:restore`.

Full event list: [MULTIPLAYER.md](MULTIPLAYER.md).

## Mobile & installable app (PWA)

Ludo Nova is mobile-first and installable. Details: [ARCHITECTURE.md §7](ARCHITECTURE.md#7-mobile--pwa-architecture),
[MOBILE_IMPLEMENTATION_SUMMARY.md](MOBILE_IMPLEMENTATION_SUMMARY.md).

* **Layouts:** portrait phones (top bar · board · action dock · player strip), landscape
  phones/tablets (board + side panel) and desktop (player rail + dice tray). The 3D camera
  frames the board in whatever space the HUD leaves, at any size from 320 px.
* **Breakpoints:** ≤ 480 (small phones), ≤ 640 (bottom sheets), ≤ 760 (bottom navigation),
  ≤ 899 (single-column lobby); game layout by aspect ratio/height (see `computeGameLayout`).
* **Touch:** tap the die (double taps are ignored), tap a highlighted token **or** a move chip
  ("Capture!", "Release", "Move 4 · Front token"). Hover, keyboard and right click are never required.
* **Graphics quality:** Auto / Low / Medium / High / Ultra (Settings). Auto uses a capability
  probe (WebGL, memory, cores, data-saver); LOW drops shadows and reflections, uses fewer
  effect particles and caps at 30 fps. Bloom is only used (subtly) on HIGH/ULTRA.
* **Calm board:** the board, lights and camera are static. Only the die, the token you can
  move, moving/captured tokens, the home-entry celebration and the winner celebration
  animate — each for a fixed, short time.
* **Install:** Android/desktop Chromium get an in-app "Install" prompt (from
  `beforeinstallprompt`, snoozed 14 days on "Later"); iPhone/iPad get "Share → Add to Home
  Screen" instructions. Settings → Install app shows the state ("Installed").
* **Offline:** the app shell and solo games work offline; online play shows
  "You're offline. Reconnect to the internet to play online." The service worker never caches
  API, Socket.IO or authenticated data.
* **Updates:** a "new version" banner appears when a deployment is detected — never during an
  active online game; it reloads only when the player taps **Update**.
* **Haptics** (Android), **"Tap to enable sound"** hint, **Back button** closes sheets / asks
  before leaving a game, safe areas for notches and home indicators.

Regenerate the app icons (original artwork, SVG master in the script):
`node scripts/generate-icons.mjs`.

## 13. Game rules

Classic Ludo with configurable variants (six to start, extra rolls, three-sixes penalty,
exact home entry, blockades, play-on ranking, turn timer). 2–4 players use the classic
cross board; 5–6 a 6-arm star; 7–8 an 8-arm star. Full rules: [GAME_RULES.md](GAME_RULES.md).

## 14. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Invalid server configuration` on start | A required env var is missing/short — the message lists which. |
| `P1001 Can't reach database server` | Start PostgreSQL (`npm run db:local` or compose) and check `DATABASE_URL`. |
| Web shows "Connection lost. Reconnecting…" | API not running, or `VITE_SOCKET_URL`/proxy wrong; check `CLIENT_URL` includes the web origin (CORS). |
| Signed out after every reload in production | Use the Vercel `/api` rewrite (first-party cookie) or set `COOKIE_SAMESITE=none` for cross-site. |
| 403 on `/api/auth/refresh` | Origin not in `CLIENT_URL`, or the `X-Requested-With: ludo` header is stripped by a proxy. |
| Huge JS bundle / React dev warnings in a build | `NODE_ENV` set in `.env` — remove it. |
| E2E tests time out on a slow machine | WebGL runs in software in headless Chromium; run one spec at a time, or `E2E_DEBUG=1` to see server logs. |
| `prisma generate` fails after pulling | `npm install` (the client is generated in `postinstall`). |
