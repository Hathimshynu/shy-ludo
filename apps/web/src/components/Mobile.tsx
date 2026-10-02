import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { track } from '../services/analytics';
import { audio } from '../services/audio';
import { shouldOfferInstall, usePwa } from '../services/pwa';
import { useOnline } from '../hooks/useMedia';
import { useGame } from '../store/gameStore';
import { useSettings } from '../store/settingsStore';
import { Logo, Modal } from './ui';

// ---------------------------------------------------------------------------
// Bottom navigation (phones only — hidden by CSS on wider screens)
// ---------------------------------------------------------------------------

const NAV = [
  { to: '/play', label: 'Play', icon: '🎲' },
  { to: '/leaderboard', label: 'Ranks', icon: '🏆' },
  { to: '/profile', label: 'Profile', icon: '🪐' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
] as const;

export function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="App">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} className="bottom-nav-item">
          <span aria-hidden="true">{n.icon}</span>
          <span>{n.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export function IosInstallSheet() {
  const open = usePwa((s) => s.iosHelpOpen);
  const setOpen = usePwa((s) => s.setIosHelp);
  if (!open) return null;
  return (
    <Modal title="Install Ludo Nova" onClose={() => setOpen(false)} className="ios-help">
      <p>Add Ludo Nova to your Home Screen to play full-screen, like an app.</p>
      <ol className="ios-steps">
        <li>
          <span className="ios-step-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12M7 8l5-5 5 5" />
              <path d="M5 12v8h14v-8" />
            </svg>
          </span>
          Tap <strong>Share</strong> in Safari’s toolbar.
        </li>
        <li>
          <span className="ios-step-icon" aria-hidden="true">＋</span>
          Choose <strong>Add to Home Screen</strong>.
        </li>
        <li>
          <span className="ios-step-icon" aria-hidden="true">✓</span>
          Tap <strong>Add</strong>.
        </li>
      </ol>
      <button className="btn btn-primary btn-block" onClick={() => setOpen(false)}>
        Got it
      </button>
    </Modal>
  );
}

/** Gentle, dismissible install card (phones only, never during a game, snoozed 14 days). */
export function InstallPrompt() {
  const state = usePwa();
  const location = useLocation();
  const [visible, setVisible] = useState(false);
  const eligible = shouldOfferInstall(state) && location.pathname === '/play';

  useEffect(() => {
    if (!eligible) {
      setVisible(false);
      return;
    }
    // Let the player look around first.
    const t = window.setTimeout(() => {
      setVisible(true);
      track('pwa_install_prompt_shown', { platform: usePwa.getState().platform });
    }, 2500);
    return () => window.clearTimeout(t);
  }, [eligible]);

  if (!visible || !eligible) return null;
  return (
    <div className="install-card" role="dialog" aria-labelledby="install-title">
      <Logo size={40} withText={false} />
      <div className="install-copy">
        <strong id="install-title">Play Ludo Nova anywhere</strong>
        <span>Install the game for full-screen play and faster access.</span>
      </div>
      <div className="install-actions">
        <button className="btn btn-primary btn-sm" onClick={() => void state.install()}>
          Install
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => state.dismiss()}>
          Later
        </button>
      </div>
    </div>
  );
}

/** Settings / menu entry: Install, Installed, or iOS instructions. */
export function InstallButton() {
  const { standalone, installed, canInstall, platform, install } = usePwa();
  if (standalone || installed) return <span className="chip chip-good">Installed</span>;
  if (!canInstall && platform !== 'ios') {
    return <span className="hint">Open in Chrome, Edge or Safari to install</span>;
  }
  return (
    <button className="btn btn-secondary btn-sm" onClick={() => void install()}>
      Install app
    </button>
  );
}

// ---------------------------------------------------------------------------
// Updates & connectivity
// ---------------------------------------------------------------------------

/** "New version" banner. Hidden while an online game is in progress. */
export function UpdateBanner() {
  const updateReady = usePwa((s) => s.updateReady);
  const apply = usePwa((s) => s.applyUpdate);
  const inGame = useGame((s) => s.mode === 'online' && s.visual?.status === 'playing');
  const [later, setLater] = useState(false);
  if (!updateReady || inGame || later) return null;
  return (
    <div className="update-banner" role="status">
      <span>A new version of Ludo Nova is available.</span>
      <button className="btn btn-primary btn-sm" onClick={apply}>
        Update
      </button>
      <button className="btn btn-ghost btn-sm" onClick={() => setLater(true)} aria-label="Update later">
        Later
      </button>
    </div>
  );
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      You’re offline. Solo games still work — reconnect to play online.
    </div>
  );
}

/** Mobile browsers only allow audio after a tap; tell the player instead of failing silently. */
export function AudioHint() {
  const soundOn = useSettings((s) => s.soundOn || s.musicOn);
  const [unlocked, setUnlocked] = useState(audio.unlocked);
  useEffect(() => audio.onUnlockChange(setUnlocked), []);
  if (!soundOn || unlocked) return null;
  return (
    <button className="audio-hint" onClick={() => audio.unlock()}>
      <span aria-hidden="true">🔊</span> Tap to enable sound
    </button>
  );
}

/** Branded loading state that matches the HTML splash screen. */
export function Splash({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="splash" role="status" aria-label={label}>
      <Logo size={64} withText={false} />
      <span className="splash-title">LUDO NOVA</span>
      <span className="splash-label">{label}</span>
      <span className="splash-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
