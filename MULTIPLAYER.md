# Multiplayer

Typed contracts: `packages/shared-types/src/socket.ts`.
Payload schemas: `packages/validation/src/socket.ts`.

## Connection

* The client connects to `VITE_SOCKET_URL` with `auth: (cb) => cb({ token })`,
  where `token` is a short-lived access JWT. The `auth` callback runs again on
  every reconnect attempt, so a refreshed token is always used.
* The server verifies the JWT in a Socket.IO middleware and stores `userId`
  on `socket.data`. **No handler ever reads a player id from a payload.**
* Each user also joins a private room `user:{userId}` so the server can reach
  all of their tabs.

## Rooms

| Socket.IO room | Members |
| --- | --- |
| `room:{roomId}` | everyone in a lobby (private room or matched room) |
| `game:{gameId}` | every participant (and their tabs) of a running game |
| `user:{userId}` | all sockets of one user |

## Events

Client → server (every call takes an acknowledgement callback returning
`{ ok: true, ... } | { ok: false, error: { code, message } }`):

| Event | Payload | Notes |
| --- | --- | --- |
| `room:create` | `{ settings }` | creates a private room; caller becomes host |
| `room:join` | `{ code }` | joins by 6-character code |
| `room:leave` | `{}` | leaves the lobby |
| `room:kick` | `{ userId }` | host only |
| `room:settings` | `{ settings }` | host only, lobby only |
| `room:addBot` / `room:removeBot` | `{ difficulty }` / `{ botId }` | host only |
| `player:ready` | `{ ready }` | toggles ready flag |
| `game:start` | `{}` | host only; needs ≥ 2 seats, all humans ready |
| `matchmaking:join` | `{ playerCount }` | 2 / 4 / 6 / 8 |
| `matchmaking:leave` | `{}` | |
| `dice:roll` | `{ gameId, actionId, expectedSeq }` | |
| `token:move` | `{ gameId, actionId, expectedSeq, tokenIndex }` | |
| `game:sync` | `{ gameId }` | returns full authoritative snapshot |
| `game:leave` | `{ gameId }` | forfeits |
| `game:emote` | `{ gameId, emote }` | whitelisted emotes, rate limited |

Server → client:

| Event | Payload |
| --- | --- |
| `room:update` | full lobby view (seats, settings, host, code) |
| `room:kicked` | `{ roomId }` |
| `matchmaking:status` | queue position / matched |
| `game:start` | `{ gameId, state }` |
| `game:state` | `{ gameId, state, serverTime }` — snapshot (join, reconnect, resync) |
| `game:events` | `{ gameId, events: GameEvent[], serverTime }` — ordered batch |
| `game:finish` | `{ gameId, rankings }` |
| `player:disconnect` / `player:reconnect` | `{ gameId, playerId }` |
| `game:pause` / `game:resume` | `{ gameId, reason }` |
| `game:emote` | `{ gameId, playerId, emote }` |
| `session:restore` | `{ room?, game? }` — sent on connect if the user has an active session |

### Why a single ordered `game:events` stream?

Engine events (`DICE_ROLLED`, `TOKEN_MOVED`, `TOKEN_CAPTURED`, `EXTRA_TURN`,
`TURN_CHANGED`, `PLAYER_FINISHED`, `GAME_FINISHED`, …) are emitted as one batch
per action. Every event carries a per-game `seq`. The client can therefore:

1. detect gaps (`seq !== lastSeq + 1`) and resync with `game:sync`;
2. animate in exact authoritative order;
3. ignore duplicates after a reconnect (`seq <= lastSeq`).

Animation frames are **never** sent. `TOKEN_MOVED` carries `from`, `to` and
the step `path`; the client interpolates locally.

## Anti-cheat on actions

Every action carries:

* `actionId` — a client-generated UUID. The session remembers the last 256
  ids; a repeated id is rejected with `DUPLICATE_ACTION` (replay protection).
* `expectedSeq` — the `seq` of the state the client acted on. A mismatch is
  rejected with `STALE_STATE` and the client resyncs.

Socket events are also rate limited per socket (token bucket). Sustained
abuse disconnects the socket.

## Reconnection

1. Browser refresh → the web app calls `POST /api/auth/refresh` (httpOnly
   cookie) → receives a new access token.
2. Socket connects; the server finds the user's active room/game and emits
   `session:restore` with the authoritative snapshot.
3. The web app navigates to `/game/:id` and the GameDirector snaps the board
   to the snapshot. No game state is restarted.
4. The seat was kept while the player was away (`player:disconnect` shows a
   badge to others). Turns that expired were auto-played by the server.

## Matchmaking

* Queues per player count (2, 4, 6, 8). A user can be in only one queue and
  cannot queue while seated in a running game.
* When a queue reaches its size, the matcher atomically removes exactly that
  many users (Redis lock or in-process mutex), creates one room, seats them
  and starts the game. Duplicate matches are impossible because removal and
  match creation happen under the same lock.

## Bots in online rooms

Private-room hosts can add AI seats. Bots are driven by the server with the
same engine and AI as solo mode, with a short human-like delay.

## Solo mode

Solo games run entirely in a Web Worker (`apps/web/src/workers/soloGame.worker.ts`)
using the same engine, AI and event format. They work offline and never
affect ranked statistics.
