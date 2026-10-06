import { lazy, type ReactNode, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LIMITS } from '@ludo/config';
import type { PlayerState } from '@ludo/shared-types';
import { track } from '../services/analytics';
import { audio } from '../services/audio';
import { deviceProfile, isTouchDevice } from '../services/device';
import { GameDirector, ORDINAL } from '../game/director';
import { PLAYER_HEX } from '../game/layout';
import { describeMoves } from '../game/moves';
import type { GameTransport } from '../game/transport';
import { useBackGuard } from '../hooks/useBackGuard';
import { computeGameLayout, type GameLayout, useGameLayout } from '../hooks/useMedia';
import { selectCanAct, useGame } from '../store/gameStore';
import { presentation } from '../store/presentationStore';
import { resolveQuality, useSettings } from '../store/settingsStore';
import { useUi } from '../store/uiStore';
import { Avatar } from '../components/Avatar';
import { AudioHint, Splash } from '../components/Mobile';
import { EMOTE_GLYPH, PlayerCard } from '../components/PlayerCard';
import { ConnectionBadge, Modal } from '../components/ui';

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

/**
 * Measure how much of the viewport the HUD covers so the camera can frame the board
 * in the remaining rectangle (see CameraRig). Runs on resize, orientation change and
 * whenever the HUD itself changes size — no per-frame React work.
 */
/** Room kept above the desktop dice tray for up to two rows of move chips (px). */
const DESKTOP_CHIP_RESERVE = 120;

function useHudInsets(layout: GameLayout, refs: { top: HTMLElement | null; dock: HTMLElement | null; rail: HTMLElement | null }) {
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Derive the layout from the live viewport, never from a stale render.
      const current = computeGameLayout(w, h);
      const top = refs.top?.getBoundingClientRect();
      const dock = refs.dock?.getBoundingClientRect();
      let insets = { top: top ? top.bottom : 0, right: 0, bottom: 0, left: 0 };
      const obstacles: Array<{ left: number; top: number; right: number; bottom: number }> = [];
      if (current === 'portrait' && dock) insets = { ...insets, bottom: Math.max(0, h - dock.top) };
      else if (current === 'landscape' && dock) insets = { ...insets, right: Math.max(0, w - dock.left) };
      else {
        // Desktop: the board uses the full height and slides/shrinks just enough to clear
        // the player rail (top-left) and the dock's fixed footprint (bottom-right).
        insets = { ...insets, bottom: 16 };
        const rail = refs.rail?.getBoundingClientRect();
        if (rail && rail.height > 0) obstacles.push({ left: rail.left, top: rail.top, right: rail.right, bottom: rail.bottom });
        const tray = refs.dock?.querySelector('.dice-tray')?.getBoundingClientRect();
        if (dock && tray) {
          obstacles.push({ left: dock.left, right: dock.right, bottom: dock.bottom, top: dock.bottom - tray.height - DESKTOP_CHIP_RESERVE });
        }
      }
      const prev = presentation.getState();
      const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
      if (!same(prev.insets, insets) || !same(prev.obstacles, obstacles)) presentation.setState({ insets, obstacles });
    };
    // Measure now and again on the next frame, once styles for a new layout/viewport have applied.
    const schedule = () => {
      measure();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    schedule();
    // Border box: safe-area padding changes the HUD's size without changing its content box.
    const ro = new ResizeObserver(schedule);
    if (refs.top) ro.observe(refs.top, { box: 'border-box' });
    if (refs.dock) ro.observe(refs.dock, { box: 'border-box' });
    if (refs.rail) ro.observe(refs.rail, { box: 'border-box' });
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    // Some mobile browsers report the final size only after the rotation animation.
    const late = () => window.setTimeout(measure, 300);
    window.addEventListener('orientationchange', late);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.removeEventListener('orientationchange', late);
    };
  }, [layout, refs.top, refs.dock, refs.rail]);
}

export interface GameViewProps {
  transport: GameTransport;
  myId: string;
  title: string;
  onExit: () => void;
  onPlayAgain?: (() => void) | undefined;
  playAgainLabel?: string;
  /** Replay mode: playback controls shown in the action dock. */
  replayControls?: ReactNode;
}

export function GameView({ transport, myId, title, onExit, onPlayAgain, playAgainLabel = 'Play again', replayControls }: GameViewProps) {
  const directorRef = useRef<GameDirector | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [emotesOpen, setEmotesOpen] = useState(false);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [topEl, setTopEl] = useState<HTMLElement | null>(null);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const [railEl, setRailEl] = useState<HTMLElement | null>(null);
  const qualitySetting = useSettings((s) => s.quality);
  const quality = useMemo(() => resolveQuality(qualitySetting), [qualitySetting]);
  const webgl = useMemo(() => deviceProfile().webgl, []);
  const layout = useGameLayout();
  const portrait = layout === 'portrait';
  useHudInsets(layout, { top: topEl, dock: dockEl, rail: railEl });

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
  const choices = useMemo(() => (mustMove && visual ? describeMoves(visual, myId) : []), [mustMove, visual, myId]);

  // Android Back during a game asks before leaving instead of silently exiting.
  // (A replay has nothing to lose: Back simply leaves it.)
  useBackGuard(visual?.status === 'playing' && transport.mode !== 'replay', () => setLeaving(true));

  // Mobile analytics hooks (local DOM events only — see services/analytics.ts).
  const startedRef = useRef(false);
  const finishedRef = useRef(false);
  useEffect(() => {
    if (!visual || !isTouchDevice()) return;
    if (!startedRef.current) {
      startedRef.current = true;
      track('game_started_mobile', { mode: transport.mode, players: visual.players.length });
    }
    if (visual.status === 'finished' && !finishedRef.current) {
      finishedRef.current = true;
      track('game_completed_mobile', { mode: transport.mode, won: visual.rankings[0] === myId });
    }
  }, [visual, transport.mode, myId]);

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

  // Double-tap guard on top of the director's pending lock and server-side dedupe.
  const lastTap = useRef(0);
  const guardTap = () => {
    const t = performance.now();
    if (t - lastTap.current < 350) return false;
    lastTap.current = t;
    return true;
  };
  const roll = useCallback(() => {
    audio.unlock();
    if (!guardTap()) return;
    void directorRef.current?.roll();
  }, []);
  const move = useCallback((index: number) => {
    if (!guardTap()) return;
    void directorRef.current?.move(index);
  }, []);
  const select = useCallback(
    (playerId: string, index: number) => {
      if (playerId === myId) move(index);
    },
    [myId, move],
  );

  // Keyboard (desktop): Space/Enter roll, 1–4 move a token, Esc menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [role="dialog"]')) return;
      if ((e.key === ' ' || e.key === 'Enter') && canRoll && !e.repeat) {
        e.preventDefault();
        roll();
      } else if (/^[1-4]$/.test(e.key) && mustMove && !e.repeat) {
        move(Number(e.key) - 1);
      } else if (e.key === 'Escape') {
        setLeaving((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canRoll, mustMove, roll, move]);

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

  if (!visual) return <Splash label="Loading game…" />;

  const timerFraction =
    secondsLeft !== null && visual.rules.turnTimeSeconds > 0 ? Math.min(1, secondsLeft / visual.rules.turnTimeSeconds) : null;
  const activeArms = visual.players.map((p) => p.arm);
  const statusText =
    visual.status === 'finished' ? 'Game over' : myTurn ? (mustMove ? 'Choose a token' : 'Your turn') : `${current?.name ?? ''}'s turn`;
  const diceLabel = pending
    ? 'Rolling…'
    : canRoll
      ? 'Tap to roll'
      : mustMove
        ? `Rolled ${visual.turn.dice ?? ''} · pick a token`
        : myTurn
          ? '…'
          : `${current?.name ?? ''} is playing`;
  const cardProps = (p: PlayerState) => ({
    player: p,
    armCount: visual.armCount,
    isTurn: visual.status === 'playing' && visual.turn.playerId === p.id,
    isMe: p.id === myId,
    connected: !online || p.kind === 'bot' || connected[p.id] !== false,
    timeLeft: timerFraction,
    emote: emotes.filter((e) => e.playerId === p.id).at(-1)?.emote,
  });
  const timerText = secondsLeft !== null && visual.status === 'playing' ? `${Math.ceil(secondsLeft)}s` : null;
  const currentColor = current ? PLAYER_HEX[current.color] : undefined;

  return (
    <div className={`game-root layout-${layout} ${portrait ? 'is-portrait' : 'is-landscape'}`}>
      <div className="game-canvas" aria-label="Game board" role="img">
        {webgl ? (
          <Suspense fallback={<Splash label="Preparing the board…" />}>
            <GameScene armCount={visual.armCount} activeArms={activeArms} quality={quality} onSelect={select} />
          </Suspense>
        ) : (
          <div className="game-message">
            <div className="panel">3D graphics are unavailable on this device. You can still play with the move buttons.</div>
          </div>
        )}
      </div>

      {/* Top bar */}
      <header className="hud-top" ref={setTopEl}>
        <button className="icon-btn" onClick={() => setLeaving(true)} aria-label="Game menu">
          <span aria-hidden="true">☰</span>
        </button>
        {layout === 'desktop' ? (
          <div className="hud-title">
            <span className="hud-room">{title}</span>
            <span className="hud-turn" style={{ color: currentColor }} aria-live="polite">
              {statusText}
            </span>
          </div>
        ) : (
          <button
            className={`turn-pill ${myTurn ? 'is-mine' : ''}`}
            style={{ ['--pc' as string]: currentColor }}
            onClick={() => setPlayersOpen(true)}
            aria-label={`${statusText}${timerText ? `, ${timerText} left` : ''}. Show players`}
          >
            {current && <Avatar id={current.avatar} size={30} ring={currentColor} />}
            <span className="turn-pill-text" key={`${visual.turn.playerId}`}>
              <span className="turn-pill-name">{myTurn ? 'You' : current?.name}</span>
              <span className="hud-turn" aria-live="polite">
                {statusText}
              </span>
            </span>
            {timerText && <span className={`turn-pill-timer ${myTurn && (secondsLeft ?? 99) <= 5 ? 'is-urgent' : ''}`}>{timerText}</span>}
          </button>
        )}
        {online ? (
          <ConnectionBadge compact={layout !== 'desktop'} />
        ) : (
          <span className="conn conn-good">
            <i />
            {transport.mode === 'replay' ? 'Replay' : 'Solo'}
          </span>
        )}
      </header>

      {layout === 'desktop' && (
        <aside className="hud-players" aria-label="Players" ref={setRailEl}>
          {visual.players.map((p) => (
            <PlayerCard key={p.id} {...cardProps(p)} />
          ))}
        </aside>
      )}

      {/* Dock: dice/action area (+ players in landscape / player strip in portrait) */}
      <div className="hud-dock" ref={setDockEl}>
        {layout === 'landscape' && (
          <button className="dock-players" onClick={() => setPlayersOpen(true)} aria-label="Show players">
            {visual.players.map((p) => (
              <PlayerCard key={p.id} {...cardProps(p)} chip />
            ))}
          </button>
        )}

        <div className={`dice-tray ${canRoll ? 'is-ready' : ''} ${myTurn ? 'is-mine' : ''}`} style={{ ['--pc' as string]: currentColor }}>
          <button className="dice-button" onClick={roll} disabled={!canRoll} aria-label={canRoll ? 'Roll the dice' : diceLabel}>
            <Suspense fallback={<span className="dice-fallback">🎲</span>}>{webgl ? <Dice3D /> : <span className="dice-fallback">🎲</span>}</Suspense>
            {canRoll && <span className="dice-cta">ROLL</span>}
          </button>
          <div className="dice-info">
            <span className="dice-label" aria-live="polite">
              {diceLabel}
            </span>
            {timerText && layout === 'desktop' && (
              <span className={`dice-timer ${myTurn && (secondsLeft ?? 99) <= 5 ? 'is-urgent' : ''}`}>
                {myTurn ? 'Your turn' : current?.name} · {timerText}
              </span>
            )}
          </div>
          {online && (
            <button className="icon-btn" onClick={() => setEmotesOpen(true)} aria-label="Send an emote">
              <span aria-hidden="true">☺</span>
            </button>
          )}
        </div>

        {replayControls}

        {choices.length > 0 && (
          <div className="move-picker" role="group" aria-label="Choose a move">
            {choices.map((c) => (
              <button
                key={c.key}
                className="move-chip"
                style={{ ['--pc' as string]: me ? PLAYER_HEX[me.color] : undefined }}
                onClick={() => move(c.tokenIndex)}
                onPointerEnter={() => presentation.setState({ hovered: c.key })}
                onPointerLeave={() => presentation.setState({ hovered: null })}
                onFocus={() => presentation.setState({ hovered: c.key })}
                onBlur={() => presentation.setState({ hovered: null })}
              >
                <strong>{c.action}</strong>
                <span>{c.token}</span>
              </button>
            ))}
          </div>
        )}

        {portrait && (
          <button className="player-strip" onClick={() => setPlayersOpen(true)} aria-label="Show players">
            {visual.players.map((p) => (
              <PlayerCard key={p.id} {...cardProps(p)} chip />
            ))}
          </button>
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

      <AudioHint />

      {visual.status === 'finished' && (
        <WinnerOverlay myId={myId} onExit={onExit} onPlayAgain={onPlayAgain} playAgainLabel={playAgainLabel} />
      )}

      {playersOpen && (
        <Modal title="Players" onClose={() => setPlayersOpen(false)}>
          <div className="players-sheet">
            {visual.players.map((p) => (
              <PlayerCard key={p.id} {...cardProps(p)} />
            ))}
          </div>
          <p className="hint">{title}</p>
        </Modal>
      )}

      {emotesOpen && (
        <Modal title="Send an emote" onClose={() => setEmotesOpen(false)}>
          <div className="emote-grid">
            {LIMITS.emotes.map((e) => (
              <button
                key={e}
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
        </Modal>
      )}

      {leaving && (
        <Modal
          title={transport.mode === 'replay' ? 'Close the replay?' : visual.status === 'finished' ? 'Leave the table?' : 'Leave this game?'}
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
            {visual.status !== 'playing' || transport.mode === 'replay'
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
        <span className="winner-emoji" aria-hidden="true">
          {iWon ? '🎉' : '🏆'}
        </span>
        <h1 id="winner-title" className="winner-title">
          {iWon ? 'YOU WIN' : `${winner?.name ?? 'Someone'} wins`}
        </h1>
        <p className="winner-sub">{iWon ? '1st place' : myRank > 0 ? `You finished ${ORDINAL[myRank - 1]}` : ''}</p>
        <ol className="ranking">
          {ranked.map((p, i) => (
            <li key={p.id} className={p.id === myId ? 'is-me' : ''} style={{ ['--pc' as string]: PLAYER_HEX[p.color] }}>
              <span className="ranking-place">{ORDINAL[i]}</span>
              <Avatar id={p.avatar} size={30} ring={PLAYER_HEX[p.color]} />
              <span className="ranking-name">
                {p.name}
                {p.status === 'forfeited' && <em> · left</em>}
              </span>
              <span className="ranking-stat" title="Captures">
                ⚔ {p.stats.captures}
              </span>
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
            Exit
          </button>
        </div>
      </div>
    </div>
  );
}
