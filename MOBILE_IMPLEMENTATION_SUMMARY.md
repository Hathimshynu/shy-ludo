# Mobile-first + PWA — implementation summary

Builds on the existing game without changing the engine, server authority, socket
contracts or persistence. Pre-change inspection: [MOBILE_UPGRADE.md](MOBILE_UPGRADE.md).
Architecture: [ARCHITECTURE.md §7](ARCHITECTURE.md#7-mobile--pwa-architecture).

## 1. Responsive design

| Width / situation | Composition |
| --- | --- |
| 320–767 portrait (phones) | compact top bar (current player · status · timer) → board → action dock (die, move chips) → player strip; bottom navigation on menu pages; dialogs are bottom sheets |
| short portrait (height ≤ 720, e.g. 320×568) | slimmer dock (72 px die, one-line chips) to give the board more room |
| 768 × 1024 tablet portrait | portrait composition with more space |
| landscape phones/tablets (height < 640 or width < 1024) | board left, side panel right (player chips, die, move chips) |
| ≥ 1024 × 640 landscape (desktop) | unchanged desktop layout: left player rail, floating dice tray (+ move chips) |

* Board framing: HUD regions are measured (`ResizeObserver`) and published as
  `presentation.insets`; `CameraRig` fits the board into the remaining rectangle on both
  axes and shifts the projection centre with `camera.setViewOffset()`. No fixed pixel sizes.
* `100dvh` with `100vh` fallbacks; safe areas via `--sat/--sar/--sab/--sal` (from
  `env(safe-area-inset-*)`) on every edge-anchored element (HUD, dock, sheets, bottom nav,
  install card, update banner, winner screen).
* Viewport keeps `viewport-fit=cover` and **does not** disable zoom; the game screen alone
  blocks accidental gestures (`touch-action: none`, no-scroll body).
* Touch targets ≥ 44 × 44 px on coarse pointers (segmented controls, small buttons, chips,
  close buttons, bottom nav, dice).

## 2. Mobile UX

* **Token selection:** legal tokens glow/bounce with a pulsing ring; a tap shows a white ring
  + scale pop (`presentation.selected`) before the move; touch hit areas are 25 % larger on
  coarse pointers. **Move chips** list each distinct legal move ("Capture!", "Release",
  "Bring home", "Move 4 · Front token"); equivalent moves (stacked tokens, several tokens in
  base) collapse into one chip, so overlapping tokens are never ambiguous.
* **Dice:** large 3D die with a "ROLL" badge; 350 ms tap debounce + the director's
  synchronous `pending` lock; the server still rejects duplicate `actionId`s.
* **Navigation:** bottom nav (Play · Ranks · Profile · Settings) ≤ 760 px; bottom sheets for
  players, emotes, room rules, leave confirmation and iOS install help.
* **Android Back:** `useBackGuard` — closes the top sheet; in a game asks
  "Leave this game?" instead of exiting; re-arms after each press.
* **Lobby:** menu shows PLAY ONLINE / PLAY VS AI / CREATE ROOM / JOIN ROOM as full-width
  buttons; private room shows the code, player dots (● ● ○ ○), rules in a sheet and a sticky
  Start/Ready bar.
* **Auth:** `autocapitalize="none"`, `enterkeyhint`, `inputmode`, proper `type`/`autocomplete`;
  focused fields scroll into view after the keyboard opens.
* **Winner screen:** emoji, title, place, scrollable ranking and always-visible
  Play again / Exit buttons at every size (verified 320×568 → 844×390).
* **Splash:** branded loading screen inlined in `index.html` (visible before JS loads) and
  reused as the React `Suspense` fallback.

## 3. PWA

| Item | Implementation |
| --- | --- |
| Library | `vite-plugin-pwa` 1.3 (Workbox 7), `registerType: 'prompt'`, registered in `services/pwa.ts` |
| Manifest | generated `manifest.webmanifest`: id `/`, start_url `/play?source=pwa`, scope `/`, `display: standalone` (+ `display_override`), `orientation: any`, theme/background `#0b0820`, categories, shortcuts (Solo, Online, Join) |
| Icons | original artwork rendered by `scripts/generate-icons.mjs`: 192/512 `any`, 192/512 `maskable` (emblem inside the 80 % safe zone), 180 Apple touch icon, 32 px favicon, SVG favicon |
| iOS | `apple-mobile-web-app-capable`, `apple-mobile-web-app-title`, `black-translucent` status bar, Apple touch icon |
| Install (Android/desktop Chromium) | `beforeinstallprompt` captured; gentle card on the menu (phones only, after 2.5 s, never in a game); "Later" snoozes 14 days; state persisted in `localStorage` (`ludo-nova:pwa`, no personal data) |
| Install (iOS) | card → "Share → Add to Home Screen → Add" sheet; never shown on Android/desktop |
| Standalone | detected via `display-mode: standalone/fullscreen` and `navigator.standalone`; `/` opens the menu; website footer hidden |
| Settings | Install app row → "Install app" button / iOS instructions / "Installed" |
| Updates | new worker waits; banner "A new version of Ludo Nova is available. [Update]" — hidden during an active online game, applies only on tap; hourly update checks |
| Offline | app shell + solo play offline; online entry points show "You're offline. Reconnect to the internet to play online."; global offline banner |

**Service worker safety:** precache only (no runtime caching); `/api`, `/socket.io`,
`/health` denylisted from the navigation fallback; no cookies, JWTs, game state or
authenticated responses are cached (verified by an E2E test that inspects every cache
entry after authenticated traffic).

## 4. 3D performance

| Tier | DPR | Shadows | Reflections | Bloom | Particles | Fireworks | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LOW | 0.75–1 | off | off | off | 0 ambient, 40 % burst | off | standard (not physical) token material, 30 fps cap |
| MEDIUM | 1–1.5 | 1024 | 64 px env | light | 120 | 3 shells | |
| HIGH | 1–2 | 2048 | 128 px env | full + vignette, 4× MSAA | 240 | 6 shells | |
| ULTRA | 1–2.5 | 4096 | 256 px env | stronger, 8× MSAA | 420 | 8 shells | 1.6× burst particles |

* **Auto** = capability probe (`services/device.ts`): WebGL/WebGL2, max texture size,
  software-renderer detection, `hardwareConcurrency`, `deviceMemory`, coarse pointer,
  data-saver. Phones: ≤ 2 GB or ≤ 4 cores → LOW; ≤ 4 GB or ≤ 6 cores → MEDIUM; else HIGH.
  Desktops: ≥ 8 cores + ≥ 8 GB + 16k textures → ULTRA, else HIGH. Overridable in Settings.
* Rendering pauses when the tab is hidden (both canvases). Animation state is read from a
  vanilla store inside `useFrame`; no per-frame `setState`.
* "Reduce animations" still forces minimal effects at any tier.
* The landing page shows a static poster (no WebGL download) on LOW / data-saver / reduced motion.
* No WebGL at all → the game remains playable through the move chips and a 2D die.

## 5. Audio, haptics, analytics

* Audio context starts on the first tap (no autoplay bypass); in-game
  **"Tap to enable sound"** hint until then.
* `navigator.vibrate` patterns for roll, selection, capture, your turn and win;
  Settings → Haptic feedback (disabled and labelled where unsupported, e.g. iOS Safari).
* Analytics hooks (`services/analytics.ts`) dispatch local `ludo:analytics` DOM events only
  (`pwa_install_prompt_shown`, `pwa_install_clicked`, `pwa_installed`,
  `game_started_mobile`, `game_completed_mobile`, …). Nothing is sent anywhere.

## 6. Real-device test plan (manual — not yet performed)

Automated tests use Chromium with mobile emulation. They do **not** replace real devices.

| Platform | Browser | Checks |
| --- | --- | --- |
| Android 12+ | Chrome | install prompt → installed icon, standalone (no address bar), theme colour, splash; Back button in game/sheets; haptics; portrait/landscape rotation mid-game; airplane mode → reconnect |
| Android | Samsung Internet | install via menu, layout, Back button |
| iPhone (notch + Dynamic Island) | Safari 16.4+ | Share → Add to Home Screen; standalone launch; safe areas (status bar, home indicator); "Tap to enable sound"; keyboard on login; rotation |
| iPad | Safari | portrait + landscape layouts, install |
| Desktop | Chrome, Edge, Firefox, Safari | desktop layout unchanged; Chrome/Edge install icon in the address bar; update banner after redeploy |
| Network | Chrome DevTools throttling / real 4G | slow 4G load, offline shell, mid-game network loss → "Reconnecting…" → state restored |
| Multiplayer | phone + phone + desktop + tablet | create/join by code, full game, refresh one phone mid-game |

Update flow on a real deployment: deploy → keep the app open → deploy again → the banner
appears within an hour (or on next launch); during an online game it stays hidden until the
game ends.
