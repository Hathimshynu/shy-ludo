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
