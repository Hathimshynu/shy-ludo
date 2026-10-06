import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { GameEvent, GameState } from '@ludo/shared-types';
import { REPLAY_SPEEDS, ReplayTransport, type ReplayStatus } from '../game/replayTransport';
import { usePageMeta } from '../hooks/usePageMeta';
import { ApiError, api } from '../services/api';
import { useAuth } from '../store/authStore';
import { Spinner } from '../components/ui';
import { GameView } from './GameView';

/** Spectator id for the replay viewer: never a player, so the board never offers actions. */
const VIEWER_ID = 'replay-viewer';

function ReplayControls({ transport }: { transport: ReplayTransport }) {
  const [status, setStatus] = useState<ReplayStatus>(transport.status);
  useEffect(() => transport.onStatus(setStatus), [transport]);
  const atStart = status.position === 0;
  const atEnd = status.position >= status.total;
  const nextSpeed = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(status.speed) + 1) % REPLAY_SPEEDS.length]!;
  return (
    <div className="replay-controls" role="group" aria-label="Replay controls">
      <button className="icon-btn" onClick={() => transport.restart()} disabled={atStart} aria-label="Restart replay">
        <span aria-hidden="true">⏮</span>
      </button>
      <button className="icon-btn" onClick={() => transport.previous()} disabled={atStart} aria-label="Previous move">
        <span aria-hidden="true">◀</span>
      </button>
      <button
        className="icon-btn replay-play"
        onClick={() => (status.playing ? transport.pause() : transport.play())}
        aria-label={status.playing ? 'Pause replay' : atEnd ? 'Watch again' : 'Play replay'}
      >
        <span aria-hidden="true">{status.playing ? '⏸' : '▶'}</span>
      </button>
      <button className="icon-btn" onClick={() => transport.next()} disabled={atEnd} aria-label="Next move">
        <span aria-hidden="true">▶▶</span>
      </button>
      <button className="replay-speed" onClick={() => transport.setSpeed(nextSpeed)} aria-label={`Playback speed ${status.speed}×, change to ${nextSpeed}×`}>
        {status.speed}×
      </button>
      <span className="replay-progress" aria-live="polite">
        Move {status.move}/{status.moves}
      </span>
    </div>
  );
}

export function ReplayPage() {
  const { gameId = '' } = useParams();
  const navigate = useNavigate();
  const status = useAuth((s) => s.status);
  const [data, setData] = useState<{ initial: GameState; events: GameEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePageMeta({ title: 'Replay', noindex: true });

  useEffect(() => {
    if (status === 'anonymous') navigate('/login', { replace: true, state: { from: `/replay/${gameId}` } });
  }, [status, gameId, navigate]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    let alive = true;
    setData(null);
    setError(null);
    api
      .replay(gameId)
      .then((r) => alive && setData({ initial: r.initial, events: r.events }))
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load this replay.'));
    return () => {
      alive = false;
    };
  }, [gameId, status]);

  const transport = useMemo(() => (data ? new ReplayTransport(data.initial, data.events) : null), [data]);
  useEffect(() => () => transport?.dispose(), [transport]);

  if (error) {
    return (
      <div className="game-root game-message">
        <div className="panel">
          <h2>Replay unavailable</h2>
          <p>{error}</p>
          <Link className="btn btn-primary" to="/profile">
            Back to profile
          </Link>
        </div>
      </div>
    );
  }
  if (!transport) return <div className="game-root game-message"><Spinner label="Loading replay…" /></div>;

  return (
    <GameView
      key={gameId}
      transport={transport}
      myId={VIEWER_ID}
      title="Replay"
      onExit={() => navigate('/profile')}
      onPlayAgain={() => transport.restart()}
      playAgainLabel="Watch again"
      replayControls={<ReplayControls transport={transport} />}
    />
  );
}
