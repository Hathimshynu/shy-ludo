import { create } from 'zustand';
import { track } from './analytics';
import { isTouchDevice } from './device';

/**
 * Progressive Web App state: installability, standalone mode and service-worker updates.
 *
 * * Android/desktop Chromium fire `beforeinstallprompt`; we keep the event and show our
 *   own unobtrusive prompt instead of the browser mini-infobar.
 * * iOS has no install API, so we show "Share → Add to Home Screen" instructions.
 * * The service worker is registered in "prompt" mode: a new version is downloaded in
 *   the background but only activated when the player confirms (never mid-game).
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type Platform = 'ios' | 'android' | 'desktop';

const STORE_KEY = 'ludo-nova:pwa';
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

interface Persisted {
  dismissedAt: number | null;
  installed: boolean;
}

function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { dismissedAt: null, installed: false, ...(JSON.parse(raw) as Partial<Persisted>) };
  } catch {
    /* storage unavailable */
  }
  return { dismissedAt: null, installed: false };
}

function writePersisted(p: Persisted): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Platform detection is used only to choose install instructions — never for features. */
export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  const iPadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iPad|iPhone|iPod/.test(ua) || iPadOs) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

interface PwaState {
  platform: Platform;
  standalone: boolean;
  canInstall: boolean;
  installed: boolean;
  dismissedAt: number | null;
  updateReady: boolean;
  offlineReady: boolean;
  iosHelpOpen: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  dismiss: () => void;
  applyUpdate: () => void;
  setIosHelp: (open: boolean) => void;
}

let deferred: BeforeInstallPromptEvent | null = null;
let updateServiceWorker: ((reload?: boolean) => Promise<void>) | null = null;

const initial = readPersisted();

export const usePwa = create<PwaState>((set, get) => ({
  platform: 'desktop',
  standalone: false,
  canInstall: false,
  installed: initial.installed,
  dismissedAt: initial.dismissedAt,
  updateReady: false,
  offlineReady: false,
  iosHelpOpen: false,
  install: async () => {
    track('pwa_install_clicked', { platform: get().platform });
    if (get().platform === 'ios' && !deferred) {
      set({ iosHelpOpen: true });
      return 'unavailable';
    }
    if (!deferred) return 'unavailable';
    const event = deferred;
    deferred = null;
    set({ canInstall: false });
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') markInstalled();
    else get().dismiss();
    return outcome;
  },
  dismiss: () => {
    const dismissedAt = Date.now();
    set({ dismissedAt });
    writePersisted({ dismissedAt, installed: get().installed });
    track('pwa_install_dismissed');
  },
  applyUpdate: () => {
    track('pwa_update_applied');
    if (updateServiceWorker) void updateServiceWorker(true);
    else window.location.reload();
  },
  setIosHelp: (iosHelpOpen) => set({ iosHelpOpen }),
}));

function markInstalled(): void {
  usePwa.setState({ installed: true, canInstall: false });
  writePersisted({ dismissedAt: usePwa.getState().dismissedAt, installed: true });
  track('pwa_installed');
}

/** Should the gentle install prompt be shown right now? */
export function shouldOfferInstall(s: PwaState = usePwa.getState()): boolean {
  if (s.standalone || s.installed) return false;
  if (s.dismissedAt && Date.now() - s.dismissedAt < SNOOZE_MS) return false;
  if (!isTouchDevice()) return false;
  return s.canInstall || s.platform === 'ios';
}

let started = false;
export function initPwa(): void {
  if (started) return;
  started = true;
  usePwa.setState({ platform: detectPlatform(), standalone: isStandalone() });
  document.documentElement.classList.toggle('is-standalone', isStandalone());

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    usePwa.setState({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => markInstalled());
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', (e) => {
    usePwa.setState({ standalone: e.matches });
    document.documentElement.classList.toggle('is-standalone', e.matches);
  });

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    void import('virtual:pwa-register').then(({ registerSW }) => {
      updateServiceWorker = registerSW({
        immediate: true,
        onNeedRefresh: () => usePwa.setState({ updateReady: true }),
        onOfflineReady: () => usePwa.setState({ offlineReady: true }),
        onRegisteredSW: (_url, registration) => {
          // Look for new deployments hourly while the app stays open.
          if (registration) window.setInterval(() => void registration.update().catch(() => undefined), 60 * 60 * 1000);
        },
      });
    });
  }
}
