# Mobile-first + PWA upgrade — current state and plan

This document was written **before** any mobile/PWA changes, after inspecting the
repository. It records what already existed, what was missing, and what must not
change. The outcome is documented in `MOBILE_IMPLEMENTATION_SUMMARY.md`.

## 1. What already exists (inspected)

| Area | Current state |
| --- | --- |
| Viewport | `width=device-width, initial-scale=1, viewport-fit=cover` — user zoom is **not** disabled (good). |
| Safe areas | Partial: game HUD top bar, player rail, dice tray, toasts, topbar, footer use `env(safe-area-inset-*)`. Modals, bottom sheets and landscape layout do not. |
| Viewport height | `position: fixed; inset: 0` on the game root. No `dvh` units anywhere; menu pages use `min-height: 100%`. |
| Game layout | Two layouts chosen by aspect ratio (`< 0.9` = portrait): portrait shows a 2-column (≤4 players) or 4-column compact (>4) player grid on top and a dice tray at the bottom; landscape shows a left player rail and a bottom-right dice tray. |
| Camera framing | `CameraRig` fits the board's extent to the viewport aspect with `padTop`/`padBottom` pixel hints (hard-coded 150/170 portrait, 70/20 landscape). No left/right reservation, no `setViewOffset`; the HUD is not measured. |
| Touch input | R3F pointer events on tokens; a generous invisible hit cylinder per token; the dice is a `<button>`. Gestures disabled on the game root via `touch-action: none` / `body.no-scroll`. No keyboard needed (Space/1-4 are optional shortcuts). |
| Token selection | Selectable tokens bounce + pulsing ring. Overlapping tokens are fanned out in a small cluster. No explicit "selected" feedback, no on-screen alternative to tapping the 3D token. |
| Double-tap | Director blocks actions while an action is pending / animations play; server rejects duplicate `actionId` and stale `expectedSeq`. No UI-level debounce. |
| Quality | `auto/high/medium/low` in settings; `auto` uses pointer type + cores + `deviceMemory` only. No WebGL capability probe, no ULTRA tier. Low caps at 30 fps; rendering pauses when the tab is hidden. |
| Audio | Web Audio synthesised SFX/music, unlocked on the first `pointerdown`/`keydown`. No visible "tap to enable sound" hint. |
| Haptics | None. |
| PWA | `manifest.webmanifest` exists (start_url `/play`, 192/512 PNG + SVG icon, no maskable icon). **No service worker**, no install prompt, no iOS instructions, no update flow, no offline handling, no Apple meta tags. |
| Navigation | Desktop-style top nav (hidden < 760 px, leaving only logo + user chip on phones) and footer. No bottom navigation, no bottom sheets, no Android back-button handling in game. |
| Splash | React `Suspense` spinner only; a blank screen until JS parses. |
| Offline | Socket shows Reconnecting/Offline; starting an online action while offline produces a generic error toast. Solo games need the worker chunk, which is not cached. |
| Tests | Playwright: smoke, solo, multiplayer (2 browsers), quick match, 8 sessions, one mobile spec (Pixel 7). |
| Bundles (baseline) | Initial `index` JS 328.2 kB (104.6 kB gzip), CSS 35.0 kB; 3D vendor chunk 914.8 kB (242.9 kB gzip) + GameScene 148.3 kB, lazy-loaded. The landing page lazy-loads the 3D preview after first paint when the hero is visible. Login does not load 3D. |

## 2. Gaps to close

1. Installable PWA: service worker (precache shell + solo assets, never API/socket), manifest with maskable/Apple icons, iOS meta tags.
2. Install UX: Android `beforeinstallprompt` prompt, iOS "Add to Home Screen" sheet, install entry in settings/menu, persisted dismissal, standalone detection.
3. Update flow that never reloads during an active online game.
4. Offline: app shell loads offline; online actions show "You're offline"; solo works offline.
5. Mobile game composition: compact top bar (current player · turn · timer), measured HUD → board fitted to the remaining rectangle via `setViewOffset`, dice/action area, compact player strip; landscape side panel; player details in a bottom sheet.
6. Token selection: explicit selected state + an on-screen move picker so overlapping tokens are never ambiguous.
7. Double-tap guard at the input layer.
8. Quality: LOW/MEDIUM/HIGH/ULTRA + AUTO with a WebGL capability probe.
9. Haptics with a setting; "Tap to enable sound" hint.
10. Mobile navigation: bottom nav, bottom sheets for modals, Android back handling (close sheet / confirm leaving game).
11. Mobile lobby/menu/room/auth/settings/winner layouts; `dvh` with fallback; safe areas everywhere.
12. Instant splash screen in `index.html`.
13. Landing: do not load WebGL on LOW/save-data devices (static poster instead).
14. Tests under `tests/e2e/mobile/` + PWA checks.

## 3. Must remain unchanged

* Server authority, engine, socket contracts, persistence, reconnect semantics.
* Desktop layout (left player rail, bottom-right dice tray, keyboard shortcuts, parallax camera).
* Existing tests (none removed or weakened).
* Lazy loading of the 3D code; SEO tags, sitemap, robots.
* Security: cookies, CORS, CSP (`worker-src 'self'` already permits the service worker), rate limits.

---

## 4. Visual calm & polish audit (second pass, inspected before changes)

Goal: *nothing moves until something important happens.* Every animation in the game
view was located and classified as **persistent** (runs while idle), **interaction**,
**gameplay event** or **celebration**.

### 4.1 Persistent animations found (removed)

| Where | What it did | Class | Action |
| --- | --- | --- | --- |
| `three/geometry.ts` tile shader | Light pulses travelling around the track forever (`uTime`) | persistent | removed; static per-lane tint |
| `three/geometry.ts` felt shader | Rotating rings and rays (`uTime`) | persistent | removed; fixed faint rings |
| `three/Board.tsx` gem | Spun and bobbed forever; emissive 2.2 + its own point light (bloom halo) | persistent | static gem; brief pop only on home entry |
| `three/Board.tsx` rim | Unlit, tone-mapping-free gold tube (always blooming) | persistent glow | lit brushed-gold trim |
| `three/GameScene.tsx` `Lights` | Accent point light orbiting the board, intensity `14 + sin(t)·3`, recoloured every turn; rim light `0.9 + sin(t)·0.15` | persistent blinking light | static ambient + hemisphere + key + soft rim |
| `three/GameScene.tsx` `AmbientParticles` | 120–420 additive motes drifting forever | persistent | removed |
| `three/GameScene.tsx` `CameraRig` | Pointer parallax (desktop), focus drift towards every moved token | persistent / per move | removed; camera holds its fitted pose |
| `three/Tokens.tsx` | Every idle token bobbed (`sin(t·1.8)`); legal tokens bounced, wobbled and their ring flashed at ~1 Hz; winner tokens hopped forever | persistent | idle tokens still; legal tokens breathe ±4 % over 1.6 s with a steady ring; winner hop limited to 4.5 s |
| `three/Dice3D.tsx` | Idle die bobbed; halo pulsed | persistent | still at rest; steady soft halo |
| `three/Effects.tsx` `Celebration` | Confetti/fireworks components stayed mounted (per-frame work) for the rest of the game | celebration without end | hard 7.5 s limit, then unmounted |
| `styles/game.css` | Dice tray `tray-pulse` infinite; timers `blink 0.5s infinite`; winner glow `breathe` infinite | persistent | one-shot entrances; urgent timer = colour only |

### 4.2 Event effects that were excessive (simplified)

* **Every dice roll flashed the whole scene**: the accent light jumped by +40 intensity and the camera dipped. Now only the die animates.
* **Six**: a 24-particle sparkle burst at the board centre. Removed (the die already shows it).
* **Each step of a move**: an expanding ring on every square. Removed; the hop, landing squash and step sound remain.
* **Capture**: 70–112 particles, a screen-size flash sphere, random camera shake of 0.12 and a light flash. Now 8–16 particles, a short shock ring and a small decaying nudge (0.05, 280 ms), and the victim spins once instead of three times.
* **Home entry**: the same explosion as a capture. Replaced by a dedicated sequence (see §4.4).
* **Post-processing**: bloom on MEDIUM (the default phone tier) and bloom + vignette on HIGH/ULTRA. Now there's none on LOW/MEDIUM; HIGH/ULTRA get a subtle bloom (threshold 0.92, intensity 0.45) that only catches effects.
* **Token materials** were mirror-like (roughness 0.16, clear-coat 1, emissive 0.14 plus bloom). Now glossy but readable: roughness 0.3, emissive 0.05.

### 4.3 Bugs found

| # | Bug | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | Effects kept rendering after they ended | Expired effects stayed in the store until the *next* effect was added, so their `useFrame` loops kept running hidden | `addEffect` schedules removal at the end of each effect |
| 2 | GPU memory grew with every capture/home effect | Per-effect `BufferGeometry` / `ShaderMaterial` never disposed | disposed on unmount |
| 3 | Step sounds/rings could fire after leaving a game | Per-step `setTimeout`s were not tracked by the director | `GameDirector.later()` tracks timers; `stop()` clears them |
| 4 | Celebration ran forever | `Celebration` stayed mounted while `winnerId` was set | unmounts after `CELEBRATION_MS` |
| 5 | Two "home" chimes when the last token finished | `PLAYER_FINISHED` replayed the home sound right after the token's own | distinct `notify` cue |
| 6 | Keyboard shortcuts 1–4 skipped the double-tap guard; held keys auto-repeated | went straight to `director.move` | routed through the guarded `move`, `e.repeat` ignored (also for Space/Enter) |
| 7 | `createBoard()` called every frame in `CameraRig` | not memoised | memoised per arm count |
| 8 | Capture/effects queued while fast-forwarding (hidden tab / long backlog) | burst + shake were added even when playback was skipped | only when actually animating |
| 9 | Tray/timer blinking ignored "Reduce animations" | CSS `infinite` animations | removed (see §4.1) |
| 10 | Board ran 26 px off-screen on a 768×1024 tablet; used only 81–84 % of the free area at 844×390, 1280×720 and 1366×768 | `CameraRig` sized the board with an approximation (`sin(elevation) + 0.18`) that ignores perspective | exact fit: project the real board outline and solve the distance (`game/framing.ts`) |
| 11 | On desktop (1440×900) the board's corner sat under the dice tray | desktop framing ignored the player rail and dock | rail and the dock's fixed footprint are framing obstacles; the board slides/shrinks just enough |
| 12 | Desktop board re-fitted when the dice label or move chips changed size | dock width depended on its text | fixed 300 px desktop dock (chips in a 2-column grid) |
| 13 | Idle frames were never identical | camera/token/dice easing (`lerp`) approached its target forever | snap exactly once within ε |
| 14 | Pointer cursor stuck as "pointer" after leaving a game while hovering a token | cursor reset only on pointer-out | reset on token unmount |

### 4.4 Home entry (new)

The engine's `TOKEN_MOVED` event with `to === finishProgress` is the only trigger; the
animation never decides anything. Sequence (1.2 s; 0.42 s with Reduce Animations):
brief pause → token rises 0.42 → player-colour aura + one expanding ring + 14 drifting
particles (8 on LOW, none with Reduce Animations) → slow turn with slight tilt → settle →
centre gem pops in the player's colour → HUD "★ Home n/4" counter pops once. A short
synthesised chime and an Android haptic accompany it. The curve lives in
`game/motion.ts` (pure, unit-tested).
