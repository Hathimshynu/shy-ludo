import { Component, type ErrorInfo, type ReactNode, Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Route, Routes, useParams } from 'react-router-dom';
import { audio } from './services/audio';
import { socketClient } from './services/socket';
import { useAuth } from './store/authStore';
import { wireLobby } from './store/lobbyStore';
import { useUi } from './store/uiStore';
import { Spinner, Toasts } from './components/ui';
import { LandingPage } from './pages/Landing';

const PlayPages = () => import('./pages/PlayPages');
const InfoPages = () => import('./pages/InfoPages');
const GamePages = () => import('./pages/GamePages');

const MenuPage = lazy(() => PlayPages().then((m) => ({ default: m.MenuPage })));
const OnlinePage = lazy(() => PlayPages().then((m) => ({ default: m.OnlinePage })));
const FriendsPage = lazy(() => PlayPages().then((m) => ({ default: m.FriendsPage })));
const SoloSetupPage = lazy(() => PlayPages().then((m) => ({ default: m.SoloSetupPage })));
const RoomPageImpl = lazy(() => PlayPages().then((m) => ({ default: m.RoomPage })));
const OnlineGamePage = lazy(() => GamePages().then((m) => ({ default: m.OnlineGamePage })));
const SoloGamePage = lazy(() => GamePages().then((m) => ({ default: m.SoloGamePage })));
const AuthPage = lazy(() => InfoPages().then((m) => ({ default: m.AuthPage })));
const ProfilePage = lazy(() => InfoPages().then((m) => ({ default: m.ProfilePage })));
const LeaderboardPage = lazy(() => InfoPages().then((m) => ({ default: m.LeaderboardPage })));
const SettingsPage = lazy(() => InfoPages().then((m) => ({ default: m.SettingsPage })));
const HowToPlayPage = lazy(() => InfoPages().then((m) => ({ default: m.HowToPlayPage })));
const NotFoundPage = lazy(() => InfoPages().then((m) => ({ default: m.NotFoundPage })));

function RoomRoute() {
  const { code = '' } = useParams();
  return <RoomPageImpl code={code.toUpperCase()} />;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI crashed', error, info.componentStack);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="game-message">
        <div className="panel">
          <h2>Something went wrong</h2>
          <p>The page hit an unexpected problem. Reloading usually fixes it — your online game is safe on the server.</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

function Boot() {
  useEffect(() => {
    wireLobby();
    const off = socketClient.onStatus((s) => useUi.getState().setConnection(s));
    void useAuth.getState().init();
    // Browsers only allow audio after a user gesture.
    const unlock = () => audio.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      off();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <div className="cosmos" aria-hidden="true" />
      <Boot />
      <ErrorBoundary>
        <Suspense fallback={<div className="game-message"><Spinner label="Loading…" /></div>}>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/play" element={<MenuPage />} />
            <Route path="/online" element={<OnlinePage />} />
            <Route path="/friends" element={<FriendsPage />} />
            <Route path="/room/:code" element={<RoomRoute />} />
            <Route path="/solo" element={<SoloSetupPage />} />
            <Route path="/solo/game" element={<SoloGamePage />} />
            <Route path="/game/:gameId" element={<OnlineGamePage />} />
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/register" element={<AuthPage mode="register" />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/profile/:userId" element={<ProfilePage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/how-to-play" element={<HowToPlayPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <Toasts />
    </BrowserRouter>
  );
}
