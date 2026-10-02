import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BRAND } from '@ludo/config';
import { usePageMeta } from '../hooks/usePageMeta';
import { Logo } from '../components/ui';
import { useAuth } from '../store/authStore';

const LandingBoard = lazy(() => import('../three/LandingBoard'));

/** Only mount the WebGL preview once the hero is on screen and the browser is idle. */
function useDeferredMount(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
        if (idle) idle(() => setShow(true));
        else window.setTimeout(() => setShow(true), 150);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, show];
}

const FEATURES = [
  { icon: '🌐', title: 'Real-time multiplayer', text: 'Quick match tables for 2, 4, 6 or 8 players. Every roll and move is decided by the server — no cheating, no desync.' },
  { icon: '🎲', title: '3D gameplay', text: 'A lacquered board, glossy tokens and a real tumbling die. Step-by-step hops, capture bursts and fireworks for the winner.' },
  { icon: '👥', title: 'Play with friends', text: 'Create a private room, share a 6-letter code and pick your own rules — timers, blockades, rank-everyone and more.' },
  { icon: '🤖', title: 'AI opponents', text: 'Four difficulty levels from Easy to Expert. The AI hunts, escapes danger and plays the odds — and never blocks your screen.' },
  { icon: '⚡', title: 'Up to 8 players', text: 'The board reshapes itself: a classic cross for four, a six-arm star or an eight-arm star for the biggest tables.' },
  { icon: '🔁', title: 'Never lose a game', text: 'Refresh, switch networks or close the tab — your seat is held and the game picks up exactly where it left off.' },
];

export function LandingPage() {
  usePageMeta({ path: '/', description: BRAND.description });
  const [boardRef, showBoard] = useDeferredMount();
  const user = useAuth((s) => s.user);
  return (
    <div className="landing">
      <header className="landing-nav">
        <Logo />
        <nav aria-label="Main">
          <Link to="/how-to-play">How to play</Link>
          <Link to="/leaderboard">Leaderboard</Link>
          {user ? <Link to="/play" className="btn btn-secondary btn-sm">Open menu</Link> : <Link to="/login" className="btn btn-secondary btn-sm">Sign in</Link>}
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Free · Browser · 2–8 players</span>
          <h1 className="hero-title">
            {BRAND.heroLines.map((line, i) => (
              <span key={line} style={{ animationDelay: `${i * 120}ms` }}>
                {line}
              </span>
            ))}
          </h1>
          <p className="hero-sub">
            The classic race-home board game, rebuilt in glowing 3D. Challenge friends, match with players online, or sharpen your
            strategy against four levels of AI.
          </p>
          <div className="hero-actions">
            <Link to="/online" className="btn btn-primary btn-lg">Play Online</Link>
            <Link to="/solo" className="btn btn-secondary btn-lg">Play vs AI</Link>
            <Link to="/friends?create=1" className="btn btn-ghost btn-lg">Create Room</Link>
          </div>
        </div>
        <div className="hero-board" ref={boardRef} aria-label="Interactive 3D board preview — drag to look around">
          <div className="hero-glow" aria-hidden="true" />
          {showBoard && (
            <Suspense fallback={null}>
              <LandingBoard />
            </Suspense>
          )}
        </div>
      </section>

      <section className="section" aria-labelledby="features-title">
        <h2 id="features-title">Everything you love about Ludo — leveled up</h2>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <article key={f.title} className="feature panel">
              <span className="feature-icon" aria-hidden="true">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <ol className="steps">
          <li className="panel">
            <span className="step-num">1</span>
            <h3>Pick a mode</h3>
            <p>Jump into a quick match, open a private room, or play offline against AI. No download, no sign-up required.</p>
          </li>
          <li className="panel">
            <span className="step-num">2</span>
            <h3>Roll & race</h3>
            <p>Roll a six to leave base, then race clockwise around the board and up your home column. Land on rivals to send them back.</p>
          </li>
          <li className="panel">
            <span className="step-num">3</span>
            <h3>Bring them home</h3>
            <p>First to bring every token to the centre wins. Bigger tables keep playing to rank 2nd, 3rd and beyond.</p>
          </li>
        </ol>
        <div className="cta">
          <Link to="/play" className="btn btn-primary btn-lg">Start playing</Link>
        </div>
      </section>

      <footer className="footer">
        <span>© {new Date().getFullYear()} {BRAND.name} · An original game · All artwork, audio and code are original.</span>
        <nav aria-label="Footer">
          <Link to="/how-to-play">Rules</Link>
          <Link to="/leaderboard">Leaderboard</Link>
          <Link to="/settings">Settings</Link>
        </nav>
      </footer>
    </div>
  );
}
