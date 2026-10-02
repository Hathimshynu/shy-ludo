import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LIMITS } from '@ludo/config';
import { audio } from '../services/audio';
import { GameDirector, ORDINAL } from '../game/director';
import { PLAYER_HEX } from '../game/layout';
import type { GameTransport } from '../game/transport';
import { selectCanAct, useGame } from '../store/gameStore';
import { resolveQuality, useSettings } from '../store/settingsStore';
import { useUi } from '../store/uiStore';
import { Avatar } from '../components/Avatar';
import { EMOTE_GLYPH, PlayerCard } from '../components/PlayerCard';
import { ConnectionBadge, Modal, Spinner } from '../components/ui';

const GameScene = lazy(() => import('../three/GameScene').then((m) => ({ default: m.GameScene })));
const Dice3D = lazy(() => import('../three/Dice3D').then((m) => ({ default: m.Dice3D })));

/** Seconds left on the current turn, ticking 4× per second (server clock). */
function useCountdown(deadline: number | null, now: () => number): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (deadline === null) {
      setLeft(null);
      return;
    }
    const tick = () => setLeft(Math.max(0, (deadline - now()) / 1000));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [deadline, now]);
  return left;
}

function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState(() => window.innerWidth / window.innerHeight < 0.9);
  useEffect(() => {
    const on = () => setPortrait(window.innerWidth / window.innerHeight < 0.9);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return portrait;
}

export interface GameViewProps {
  transport: GameTransport;
  myId: string;
  title: string;
  onExit: () => void;
  onPlayAgain?: (() => void) | undefined;
  playAgainLabel?: string;
}

export function GameView({ transport, myId, title, onExit, onPlayAgain, playAgainLabel = 'Play again' }: GameViewProps) {
  const directorRef = useRef<GameDirector | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [emotesOpen, setEmotesOpen] = useState(false);
  const qualitySetting = useSettings((s) => s.quality);
  const quality = useMemo(() => resolveQuality(qualitySetting), [qualitySetting]);
  const portrait = useIsPortrait();

  useEffect(() => {
    const director = new GameDirector(transport, myId);
    directorRef.current = director;
    director.start();
    document.body.classList.add('no-scroll');
    return () => {
      director.stop();
      directorRef.current = null;
      document.body.classList.remove('no-scroll');
    };
  }, [transport, myId]);

  const visual = useGame((s) => s.visual);
  const connected = useGame((s) => s.connected);
  const paused = useGame((s) => s.paused);
  const banner = useGame((s) => s.banner);
  const emotes = useGame((s) => s.emotes);
  const canAct = useGame(selectCanAct);
  const pending = useGame((s) => s.pending);
  const gone = useGame((s) => s.gone);
  const connection = useUi((s) => s.connection);
  const now = useCallback(() => transport.now(), [transport]);
  const secondsLeft = useCountdown(visual?.status === 'playing' ? visual.turn.deadline : null, now);

  const me = visual?.players.find((p) => p.id === myId);
  const current = visual?.players.find((p) => p.id === visual.turn.playerId);
  const myTurn = !!visual && visual.status === 'playing' && visual.turn.playerId === myId;
  const canRoll = canAct && visual?.turn.phase === 'roll';
  const mustMove = canAct && visual?.turn.phase === 'move';
  const online = transport.mode === 'online';
  const offline = online && connection !== 'connected';

  // Countdown ticks in the last five seconds of my turn.
  const lastTick = useRef(-1);
  useEffect(() => {
    if (!myTurn || secondsLeft === null) return;
    const s = Math.ceil(secondsLeft);
    if (s <= 5 && s > 0 && s !== lastTick.current) {
      lastTick.current = s;
      audio.play('tick');
    }
  }, [myTurn, secondsLeft]);

  const roll = useCallback(() => {
    audio.unlock();
    void directorRef.current?.roll();
  }, []);
  const select = useCallback((playerId: string, index: number) => {
    if (playerId === myId) void directorRef.current?.move(index);
  }, [myId]);

  // Keyboard: Space/Enter roll, 1–4 move a token, E emotes, Esc menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [role="dialog"]')) return;
      if ((e.key === ' ' || e.key === 'Enter') && canRoll) {
        e.preventDefault();
        roll();
      } else if (/^[1-4]$/.test(e.key) && mustMove) {
        void directorRef.current?.move(Number(e.key) - 1);
      } else if (e.key === 'Escape') {
        setLeaving((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canRoll, mustMove, roll]);

  if (gone) {
    return (
      <div className="game-root game-message">
        <div className="panel">
          <h2>This game is no longer available</h2>
          <p>It may have finished while you were away.</p>
          <button className="btn btn-primary" onClick={onExit}>
            Back to menu
          </button>
        </div>
      </div>
    );
  }

  if (!visual) {
    return (
      <div className="game-root game-message">
        <Spinner label="Loading game…" />
      </div>
    );
  }

  const timerFraction =
    secondsLeft !== null && visual.rules.turnTimeSeconds > 0 ? Math.min(1, secondsLeft / visual.rules.turnTimeSeconds) : null;
  const activeArms = visual.players.map((p) => p.arm);
  const statusText = visual.status === 'finished'
    ? 'Game over'
    : myTurn
      ? mustMove
        ? 'Choose a token'
        : 'Your turn'
      : `${current?.name ?? ''}'s turn`;
  const diceLabel = pending
    ? 'Rolling…'
    : canRoll
      ? 'Tap to roll'
      : mustMove
        ? 'Pick a glowing token'
        : myTurn
          ? '…'
          : `${current?.name ?? ''} is playing`;

  return (
    <div className={`game-root ${portrait ? 'is-portrait' : 'is-landscape'}`}>
      <div className="game-canvas" aria-label="Game board" role="img">
        <Suspense fallback={<div className="game-message"><Spinner label="Preparing the board…" /></div>}>
          <GameScene
            armCount={visual.armCount}
            activeArms={activeArms}
            quality={quality}
            onSelect={select}
            padTop={portrait ? 150 : 70}
            padBottom={portrait ? 170 : 20}
          />
        </Suspense>
      </div>

      {/* Top bar */}
      <header className="hud-top">
        <button className="icon-btn" onClick={() => setLeaving(true)} aria-label="Game menu">
          <span aria-hidden="true">☰</span>
        </button>
        <div className="hud-title">
          <span className="hud-room">{title}</span>
          <span className="hud-turn" style={{ color: current ? PLAYER_HEX[current.color] : undefined }} aria-live="polite">
            {statusText}
          </span>
        </div>
        {online ? <ConnectionBadge compact={portrait} /> : <span className="conn conn-good"><i />Solo</span>}
      </header>

      {/* Players */}
      <aside className={`hud-players ${portrait && visual.players.length > 4 ? "is-compact" : ""}`} aria-label="Players">
        {visual.players.map((p) => (
          <PlayerCard
            key={p.id}
            player={p}
            armCount={visual.armCount}
            isTurn={visual.status === 'playing' && visual.turn.playerId === p.id}
            isMe={p.id === myId}
            connected={!online || p.kind === 'bot' || connected[p.id] !== false}
            timeLeft={timerFraction}
            emote={emotes.filter((e) => e.playerId === p.id).at(-1)?.emote}
          />
        ))}
      </aside>

      {/* Dice tray */}
      <div className={`dice-tray ${canRoll ? 'is-ready' : ''} ${myTurn ? 'is-mine' : ''}`} style={{ ['--pc' as string]: current ? PLAYER_HEX[current.color] : undefined }}>
        <button className="dice-button" onClick={roll} disabled={!canRoll} aria-label={canRoll ? 'Roll the dice' : diceLabel}>
          <Suspense fallback={<span className="dice-fallback">🎲</span>}>
            <Dice3D />
          </Suspense>
        </button>
        <div className="dice-info">
          <span className="dice-label">{diceLabel}</span>
          {secondsLeft !== null && visual.status === 'playing' && (
            <span className={`dice-timer ${myTurn && secondsLeft <= 5 ? 'is-urgent' : ''}`}>
              {myTurn ? 'Your turn' : current?.name} · {Math.ceil(secondsLeft)}s
            </span>
          )}
        </div>
        {online && (
          <div className="emote-wrap">
            <button className="icon-btn" onClick={() => setEmotesOpen((o) => !o)} aria-expanded={emotesOpen} aria-label="Send an emote">
              <span aria-hidden="true">☺</span>
            </button>
            {emotesOpen && (
              <div className="emote-palette" role="menu">
                {LIMITS.emotes.map((e) => (
                  <button
                    key={e}
                    role="menuitem"
                    onClick={() => {
                      void directorRef.current?.emote(e);
                      setEmotesOpen(false);
                    }}
                    aria-label={e}
                  >
                    {EMOTE_GLYPH[e]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {banner && (
        <div key={banner.id} className="turn-banner" style={{ ['--pc' as string]: banner.color }} aria-live="assertive">
          <strong>{banner.text}</strong>
          {banner.sub && <span>{banner.sub}</span>}
        </div>
      )}

      {(paused || offline) && visual.status === 'playing' && (
        <div className="hud-notice" role="status">
          {offline ? 'Connection lost. Reconnecting…' : 'Waiting for players to reconnect…'}
        </div>
      )}

      {visual.status === 'finished' && (
        <WinnerOverlay myId={myId} onExit={onExit} onPlayAgain={onPlayAgain} playAgainLabel={playAgainLabel} />
      )}

      {leaving && (
        <Modal
          title={visual.status === 'finished' ? 'Leave the table?' : 'Leave this game?'}
          onClose={() => setLeaving(false)}
          actions={
            <>
              <button className="btn btn-secondary" onClick={() => setLeaving(false)}>
                Keep playing
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  if (visual.status === 'playing' && me?.status === 'active') void transport.leave();
                  onExit();
                }}
              >
                Leave
              </button>
            </>
          }
        >
          <p>
            {visual.status !== 'playing'
              ? 'You can come back to the menu at any time.'
              : online
                ? 'Leaving forfeits your seat. The game continues without you.'
                : 'Your solo game will be abandoned.'}
          </p>
        </Modal>
      )}
    </div>
  );
}

function WinnerOverlay({
  myId,
  onExit,
  onPlayAgain,
  playAgainLabel,
}: {
  myId: string;
  onExit: () => void;
  onPlayAgain?: (() => void) | undefined;
  playAgainLabel: string;
}) {
  const visual = useGame((s) => s.visual)!;
  const ranked = visual.rankings.map((id) => visual.players.find((p) => p.id === id)!).filter(Boolean);
  const winner = ranked[0];
  const iWon = winner?.id === myId;
  const myRank = visual.rankings.indexOf(myId) + 1;
  return (
    <div className="winner-overlay">
      <div className="winner-card panel" role="dialog" aria-labelledby="winner-title">
        <div className="winner-burst" style={{ ['--pc' as string]: winner ? PLAYER_HEX[winner.color] : undefined }} />
        <h1 id="winner-title" className="winner-title">
          {iWon ? 'YOU WIN' : `${winner?.name ?? 'Someone'} wins`}
        </h1>
        {!iWon && myRank > 0 && <p className="winner-sub">You finished {ORDINAL[myRank - 1]}</p>}
        <ol className="ranking">
          {ranked.map((p, i) => (
            <li key={p.id} className={p.id === myId ? 'is-me' : ''} style={{ ['--pc' as string]: PLAYER_HEX[p.color] }}>
              <span className="ranking-place">{ORDINAL[i]}</span>
              <Avatar id={p.avatar} size={32} ring={PLAYER_HEX[p.color]} />
              <span className="ranking-name">
                {p.name}
                {p.status === 'forfeited' && <em> · left</em>}
              </span>
              <span className="ranking-stat" title="Captures">⚔ {p.stats.captures}</span>
            </li>
          ))}
        </ol>
        <div className="winner-actions">
          {onPlayAgain && (
            <button className="btn btn-primary btn-lg" onClick={onPlayAgain}>
              {playAgainLabel}
            </button>
          )}
          <button className="btn btn-secondary btn-lg" onClick={onExit}>
            Main menu
          </button>
        </div>
      </div>
    </div>
  );
}
