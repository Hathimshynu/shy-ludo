# Architecture — Ludo Nova

> "Ludo Nova" is a temporary, original brand. All brand strings live in
> `packages/config/src/brand.ts` so it can be replaced in one place.

## 1. High-level picture

```text
┌────────────────────────────┐        HTTPS (REST, /api/*)        ┌──────────────────────────────┐
│  apps/web  (Vercel)        │ ─────────────────────────────────▶ │  apps/server  (Render)       │
│  React 19 + Vite           │                                    │  Node 24 + Express 5         │
│  React Three Fiber / Drei  │ ◀════════ Socket.IO (WSS) ═══════▶ │  Socket.IO 4                 │
│  Zustand stores            │                                    │  GameSessionManager          │
│  Web Worker (solo + AI)    │                                    │   └─ @ludo/game-engine       │
└────────────────────────────┘                                    │  RoomManager / Matchmaker    │
                                                                  │  Auth (JWT + refresh cookie) │
                                                                  └───────┬──────────────┬───────┘
                                                                          │              │
                                                                  ┌───────▼──────┐ ┌─────▼───────┐
                                                                  │ PostgreSQL   │ │ Redis       │
                                                                  │ (Prisma)     │ │ (optional)  │
                                                                  └──────────────┘ └─────────────┘
```

## 2. Monorepo layout

| Path | Purpose |
| --- | --- |
| `packages/shared-types` | Framework-free TypeScript types: game state, actions, events, rules, socket contracts, REST DTOs, error codes. |
| `packages/game-engine` | The authoritative rules engine. Pure functions, no I/O, injectable dice. Also contains board geometry and the AI. Runs on the server (online games) and in a browser Web Worker (solo games). |
| `packages/validation` | Zod schemas for every REST body and every socket payload. |
| `packages/config` | Brand identity, shared limits/constants. |
| `apps/server` | Express API, Socket.IO gateway, rooms, matchmaking, game sessions, persistence. |
| `apps/web` | React SPA: landing page, menus, lobby, 3D game. |
| `prisma/` | Prisma schema + migrations (PostgreSQL). |
| `tests/` | Cross-app tests: Playwright end-to-end and load tests. |

Internal packages are consumed as TypeScript source (`"main": "src/index.ts"`).
Vite compiles them for the web app; `tsup` bundles them into the server build.

## 3. Game engine (`@ludo/game-engine`)

```text
GameEngine (engine.ts)        createGame / applyAction — the only entry point that changes state
 ├── GameState                (shared-types) plain JSON, serialisable, versioned
 ├── TurnManager  (turn.ts)   next active seat, deadlines, extra turns, consecutive sixes
 ├── DiceEngine   (dice.ts)   createDiceEngine({ random }) — injectable for deterministic tests
 ├── MovementEngine (movement.ts)  legal-move generation, paths, exact-home, blockades
 ├── CaptureEngine (capture.ts)    who gets captured on a landing square
 ├── WinEngine    (win.ts)    finishing, rankings, game end
 ├── RuleEngine   (rules.ts)  GameRules defaults + normalisation
 ├── ValidationEngine (validation.ts) turn/phase/token ownership checks
 ├── Board        (board.ts)  canonical coordinates → world positions
 └── AI           (ai.ts)     Easy / Medium / Hard / Expert move selection
```

`applyAction(state, action, ctx)` returns `{ ok: true, state, events }` or
`{ ok: false, error }`. It never mutates its input. `ctx` supplies `now` and the
dice engine, which makes the engine fully deterministic under test.

### Board coordinate pipeline

```text
token progress (game position, per player)
      ↓  progressToCoord(board, arm, progress)
canonical board coordinate  { kind: 'track' | 'lane' | 'home' | 'base', arm, lane, depth, slot }
      ↓  coordToWorld(board, coord)
world position  { x, z }  (cell units, board centred on origin)
      ↓  apps/web/src/three  (× cell size, + height, stacking offsets)
screen rendering
```

The board is made of *arms*. Each arm is a 3×6 strip: the outgoing lane, the
centre lane (home column + tip), and the incoming lane. Arms are rotated
around the centre, so the same code generates:

* 4 arms: the classic 15×15 cross. `coordToGrid()` exposes the classic
  `(row, column)` for tests.
* 6 arms: a hexagonal star for 5–6 players.
* 8 arms: an octagonal star for 7–8 players.

Track length is `13 × arms` (52 / 78 / 104).

## 4. Server (`apps/server`)

```text
src/
  index.ts            bootstrap (config → db → redis → http → socket → recover games)
  config.ts           env parsing (zod) — fails fast on missing secrets
  api/                REST routers (auth, profile, leaderboard, games, health)
  auth/               password hashing (scrypt), JWT, refresh-token rotation, middleware
  socket/             Socket.IO gateway, typed handlers, per-socket rate limiter
  game/               GameSession (one per live game), GameSessionManager, bot driver
  matchmaking/        Matchmaker (Redis or in-memory queue)
  rooms/              RoomManager (private rooms, codes, host controls)
  services/           persistence (Prisma), stats & achievements, KV store abstraction
  middleware/         request id, error handler, rate limiting
```

### Request flow for a game action

```text
socket 'dice:roll' { gameId, actionId, expectedSeq }
   ↓ zod validation + per-socket rate limit
   ↓ identity from the authenticated socket (never from the payload)
   ↓ GameSession: membership, duplicate actionId, stale expectedSeq
   ↓ engine.applyAction(state, { type: 'ROLL', playerId })
   ↓ persist events + snapshot (Postgres, single transaction, ordered queue)
   ↓ broadcast 'game:events' { gameId, events[] } to room game:{gameId}
   ↓ clients animate
```

### Persistence model

* Every engine event is stored in `GameEvent` with a per-game `sequenceNumber`.
* `Game.snapshot` holds the latest full state. On boot, the server reloads
  every game whose status is `ACTIVE` and re-arms its timers, so a redeploy
  does not destroy games in progress.
* Final results update `Profile` statistics, `GameResult` rows and
  achievements, all computed server-side.

### Redis (optional)

When `REDIS_URL` is set:

* `@socket.io/redis-adapter` is used for broadcasting.
* The matchmaking queue and the room-code registry live in Redis.

Without Redis, in-memory equivalents are used (single instance). Game
sessions are owned by the instance that created them, so the recommended
deployment is **one** web service instance scaled vertically (see
`DEPLOYMENT.md`).

## 5. Web client (`apps/web`)

```text
src/
  pages/        route components (Landing, Menu, Online, Room, Solo, Game, Profile, …)
  components/   UI kit (Button, Panel, PlayerCard, Toasts, ConnectionBadge, …)
  three/        R3F scene: Board, Tokens, Dice, Effects, CameraRig
  game/         GameDirector (event queue → animations), transports, layout maths,
                framing (exact board fit), motion (event animation curves)
  store/        zustand stores: auth, lobby, game, ui, settings/audio, presentation
  services/     api client, socket client, sound manager, music
  workers/      solo-game worker (engine + AI off the main thread)
  hooks/        small hooks
```

### State separation

| Store | Contains |
| --- | --- |
| `authStore` | user, access token (memory only), status |
| `lobbyStore` | current room, matchmaking status |
| `gameStore` | latest authoritative snapshot, `lastSeq`, my seat |
| `presentationStore` | what the 3D scene is *currently showing* (lags behind authority while animating) |
| `uiStore` | toasts, modals, connection status |
| `settingsStore` | sound, music, volume, reduce animations, quality (persisted to localStorage) |

The **GameDirector** consumes ordered event batches from a transport (Socket.IO
for online games, a Web Worker for solo games), updates `gameStore`
immediately, and plays the events through `presentationStore` one at a time
(dice → step-by-step hop → capture → turn change). The 3D components read
`presentationStore` inside `useFrame` without React re-renders.

If a sequence gap is detected (`event.seq !== lastSeq + 1`), the client
requests `game:sync` and snaps to the authoritative snapshot.

## 6. Security summary

* Identity comes only from the verified JWT on the socket / request.
* All payloads are zod-validated; unknown fields are stripped.
* Dice are generated with `crypto.randomInt` on the server.
* Actions carry `actionId` (deduplicated) and `expectedSeq` (stale rejection).
* Helmet, CORS whitelist, rate limits (HTTP + socket), httpOnly refresh cookie
  with rotation and reuse detection, scrypt password hashing.
* Secrets are only read on the server; the web app only knows
  `VITE_API_URL`, `VITE_SOCKET_URL` and `VITE_SITE_URL`.

## 7. Mobile & PWA architecture

The mobile client is **the same app** — same engine, transports, director and server.
Only the composition, input affordances and rendering budget adapt.

```text
viewport ──▶ computeGameLayout(w, h)          (hooks/useMedia.ts)
              portrait  │ landscape │ desktop
                        ▼
GameView renders the HUD for that layout and measures it (ResizeObserver)
                        ▼
presentation.insets {top,right,bottom,left} + obstacles (desktop rail, dock footprint)
                        ▼
CameraRig (only when these change): project the board's real outline and solve the
camera distance so it fits the free rect, clears the obstacles and is centred
(game/framing.ts) → camera distance + camera.setViewOffset() shift
```

### Animation model: "nothing moves until something important happens"

| Class | Examples | Rule |
| --- | --- | --- |
| Persistent visual state | board, lighting, materials, camera | **static** — no time uniforms, no animated lights, no idle motion |
| Interaction | legal-token breathing (±4 %, 1.6 s), selection pop, hover, dice tray entrance | only on the object that needs attention |
| Gameplay event | dice roll, token hop, capture burst, home entry | started by an engine event in `GameDirector`, fixed duration, then unmounted |
| Celebration | confetti, fireworks, winner hop | hard limit (7.5 s / 4.5 s), then unmounted |

Animations never change game state: the engine's events (e.g. `TOKEN_MOVED` to the
finish) trigger them, and `useGame.state` is already authoritative before they start.
Curves live in `game/motion.ts` (pure, unit-tested); effects in `three/Effects.tsx`
remove themselves from the store when they end. "Reduce animations" shortens or drops
the decorative parts but keeps essential feedback (token moves, a small home lift).

| Concern | Where |
| --- | --- |
| Layout selection | `hooks/useMedia.ts` (`computeGameLayout`): portrait (w/h < 0.9), landscape (h < 640 or w < 1024), desktop |
| HUD → camera framing | `pages/GameView.tsx` (`useHudInsets`) → `three/GameScene.tsx` (`CameraRig`) → `game/framing.ts` (`fitBoard`) |
| Safe areas | `--sat/--sar/--sab/--sal` CSS variables on `:root` (from `env(safe-area-inset-*)`) |
| Quality tiers | `services/device.ts` (capability probe) → `TIERS` table in `three/GameScene.tsx` |
| Touch selection | 3D tokens (enlarged hit area on coarse pointers) **and** on-screen move chips (`game/moves.ts`) |
| Double-tap guard | 350 ms input debounce + director `pending` lock + server `actionId` dedupe |
| Back button | `hooks/useBackGuard.ts` (stacked history guards: sheets close, games ask) |
| Haptics / audio unlock | `services/haptics.ts`, `services/audio.ts` (`onUnlockChange`) |
| PWA | `vite-plugin-pwa` (prompt mode) + `services/pwa.ts` (install, iOS help, updates, standalone) |

### Service worker strategy

* **Precache only** the versioned static build: JS, CSS, Latin fonts, icons, the solo
  game worker and the lazy 3D chunk (so solo games work offline). Non-Latin font
  subsets, the OG image, robots and sitemap are excluded.
* **No runtime caching.** `/api/*`, `/socket.io/*`, `/health` and every authenticated
  response always go to the network and are denylisted from the navigation fallback.
* Navigations fall back to the precached `index.html` (SPA shell offline).
* Revisioned precache entries + `cleanupOutdatedCaches` make stale assets impossible
  after a deploy; `sw.js` is served with `no-cache` so updates are detected.
* `registerType: 'prompt'`: a new worker waits; the "new version" banner is hidden
  during an active online game and applies only when the player taps **Update**.
