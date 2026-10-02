import type { ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/authStore';
import { useLobby } from '../store/lobbyStore';
import { Avatar } from './Avatar';
import { BottomNav, InstallPrompt, OfflineBanner } from './Mobile';
import { ConnectionBadge, Logo } from './ui';

function RejoinBanner() {
  const restored = useLobby((s) => s.restoredGame);
  const location = useLocation();
  const navigate = useNavigate();
  if (!restored || location.pathname.startsWith('/game/')) return null;
  return (
    <div className="rejoin" role="alert">
      <span>You have a game in progress.</span>
      <button className="btn btn-primary btn-sm" onClick={() => navigate(`/game/${restored.gameId}`)}>
        Rejoin game
      </button>
    </div>
  );
}

export function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const user = useAuth((s) => s.user);
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="topbar-brand" aria-label="Ludo Nova home">
          <Logo />
        </Link>
        <nav className="topbar-nav" aria-label="Main">
          <NavLink to="/play">Play</NavLink>
          <NavLink to="/leaderboard">Leaderboard</NavLink>
          <NavLink to="/how-to-play">How to play</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="topbar-user">
          {user && <ConnectionBadge compact />}
          {user ? (
            <Link to="/profile" className="user-chip" aria-label="Your profile">
              <Avatar id={user.avatar} size={30} />
              <span>{user.displayName}</span>
              {user.isGuest && <em>Guest</em>}
            </Link>
          ) : (
            <Link to="/login" className="btn btn-secondary btn-sm">
              Sign in
            </Link>
          )}
        </div>
      </header>
      <OfflineBanner />
      <RejoinBanner />
      <main className={wide ? 'page page-wide' : 'page'}>{children}</main>
      <footer className="footer">
        <span>© {new Date().getFullYear()} Ludo Nova · An original game</span>
        <nav aria-label="Footer">
          <Link to="/how-to-play">Rules</Link>
          <Link to="/leaderboard">Leaderboard</Link>
          <Link to="/settings">Settings</Link>
        </nav>
      </footer>
      <InstallPrompt />
      <BottomNav />
    </div>
  );
}
