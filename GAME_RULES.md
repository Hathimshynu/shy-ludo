# Game Rules

The rules engine lives in `packages/game-engine`. Every behaviour below that
has a variant is controlled by `GameRules` (see `packages/shared-types/src/rules.ts`)
— nothing is hard-coded elsewhere in the application.

## Default rule set

| Rule | Field | Default |
| --- | --- | --- |
| Players | `maxPlayers` | 4 (2–8 supported) |
| Tokens per player | `tokensPerPlayer` | 4 (1–4) |
| Release a token only on a 6 | `requireSixToStart` | `true` (when `false`, a 1 or a 6 releases) |
| Extra roll after a 6 | `extraTurnOnSix` | `true` |
| Extra roll after a capture | `extraTurnOnCapture` | `true` |
| Extra roll when a token reaches home | `extraTurnOnHome` | `true` |
| Three consecutive sixes forfeit the turn | `threeSixPenalty` | `true` |
| Tokens must reach home with an exact count | `exactHomeEntry` | `true` |
| Two+ tokens of one colour form an impassable block | `allowBlockades` | `false` |
| Auto-move when every legal move is equivalent | `autoMoveSingleOption` | `true` |
| Turn timer (seconds) | `turnTimeSeconds` | 30 |
| Consecutive timeouts before forfeit | `maxConsecutiveTimeouts` | 3 |
| Keep playing after the first winner to rank everyone | `continueAfterWinner` | `true` |

## Board

* Players 2–4 play on the classic **4-arm** cross (52 track squares).
* Players 5–6 play on a **6-arm** star (78 track squares).
* Players 7–8 play on an **8-arm** star (104 track squares).

Each arm is a 3-wide, 6-long strip. Moving clockwise, a token goes out along
the arm's left lane, crosses the tip, and comes back along the right lane,
then steps diagonally onto the next arm.

Every arm has a colour, a base (yard), a start square, a star square and a
five-square home column leading to the centre.

Seat → arm assignment spreads players around the board (for example, 2 players
sit on opposite arms).

## Token journey

A token's position is its **progress**:

| progress | meaning |
| --- | --- |
| `-1` | in base |
| `0` | start square (lane 2, depth 4 of the player's own arm) |
| `1 … L-2` | main track (`L` = track length) |
| `L-1 … L+3` | home column (5 squares, safe) |
| `L+4` | finished (centre) |

On the 4-arm board that is the classic 57 positions (0–56).

## Turn flow

1. **Roll.** Only the current player may roll. The server generates the value
   (1–6) with `crypto.randomInt`.
2. **Three sixes.** If `threeSixPenalty` is on and this is the third
   consecutive 6 in the same turn, the roll is void and the turn passes.
3. **Legal moves.** The engine lists every legal token move:
   * a base token may be released on a 6 (or 1/6) to the start square;
   * a track token moves forward exactly the rolled value;
   * with `exactHomeEntry`, a token may not overshoot the centre;
   * with `allowBlockades`, a token may not pass or land on an opponent block.
4. **No legal move.** If the roll was a 6 and `extraTurnOnSix` is on, the
   player rolls again; otherwise the turn passes.
5. **Choose.** If there are several distinct moves the player chooses one;
   illegal selections are rejected. If every legal move is equivalent (for
   example, all tokens are in base) and `autoMoveSingleOption` is on, the
   server moves automatically.
6. **Capture.** Landing on a non-safe track square occupied by opponents sends
   every opponent token there back to base. Start squares and star squares
   are safe; home columns are private.
7. **Extra turn.** Granted for a 6, a capture, or a token reaching home
   (each configurable). Otherwise the next active player's turn starts.

## Finishing and rankings

* A player finishes when all their tokens reach the centre. They receive the
  next rank (1st, 2nd, …).
* With `continueAfterWinner` on, play continues until one player remains,
  who receives the last rank. With it off, the game ends at the first winner
  and the remaining players are ranked by total progress.
* Forfeited players are ranked below everyone still playing (the earliest
  forfeit ranks last).

## Timers, timeouts and disconnects

* Every turn phase has a server-side deadline. The client only displays it.
* When the deadline passes, the server plays the turn for the player (roll,
  then the move the Medium AI would choose) and counts a timeout.
* After `maxConsecutiveTimeouts` timeouts in a row the player forfeits.
* A disconnected player keeps their seat. If they have not reconnected within
  the disconnect grace period (`DISCONNECT_GRACE_SECONDS`, default 120 s), they
  forfeit.
* If every human player is disconnected, the game pauses until one returns.

## AI

| Level | Behaviour |
| --- | --- |
| Easy | Legal moves, light preferences, frequent random choices |
| Medium | Greedy heuristic: capture, release, finish, advance |
| Hard | Medium + danger avoidance (probability of being hit) and safety seeking |
| Expert | Hard + two-roll threat model, blocking value, and tempo considerations |

Priority order considered by the heuristic: capture → release → escape danger →
advance toward home → strategic positions (safe squares, stacking) → avoid
exposure → best remaining legal move.

## Anti-cheat validation

Rejected with a user-friendly error code: wrong turn (`NOT_YOUR_TURN`), wrong
phase (`WRONG_PHASE`), invalid token (`INVALID_TOKEN`), illegal move
(`ILLEGAL_MOVE`), stale state (`STALE_STATE`), duplicate action
(`DUPLICATE_ACTION`), not a participant (`NOT_IN_GAME`), unknown game
(`GAME_NOT_FOUND`), rate limit (`RATE_LIMITED`). Dice values are never accepted
from the client: the roll payload has no value field, and unknown fields are
stripped.
