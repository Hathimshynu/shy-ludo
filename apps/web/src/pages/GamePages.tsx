import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { SocketTransport } from '../game/socketTransport';
import { type SavedSolo, WorkerTransport, clearSavedSolo, loadSavedSolo } from '../game/workerTransport';
import { SOLO_HUMAN_ID, type SoloConfig } from '../game/localHost';
import { usePageMeta } from '../hooks/usePageMeta';
import { useAuth } from '../store/authStore';
import { useLobby } from '../store/lobbyStore';
import { toast, useUi } from '../store/uiStore';
import { Spinner } from '../components/ui';
import { GameView } from './GameView';

export function OnlineGamePage() {
  const { gameId = '' } = useParams();
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const room = useLobby((s) => s.room);
  const connection = useUi((s) => s.connection);
  usePageMeta({ title: 'In game', noindex: true });

  const transport = useMemo(() => new SocketTransport(gameId), [gameId]);

  // Announce recovery after a dropped connection.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (connection === 'reconnecting' || connection === 'offline') wasOffline.current = true;
    if (connection === 'connected' && wasOffline.current) {
      wasOffline.current = false;
      toast('Game session restored.', 'success');
    }
  }, [connection]);

  useEffect(() => {
    useLobby.getState().clearRestored();
  }, [gameId]);

  useEffect(() => {
    if (status === 'anonymous') navigate('/login', { replace: true, state: { from: `/game/${gameId}` } });
  }, [status, gameId, navigate]);

  if (!user) return <div className="game-root game-message"><Spinner label="Restoring your session…" /></div>;

  const backToRoom = room?.kind === 'private' && room.gameId === gameId ? () => navigate(`/room/${room.code}`) : undefined;
  return (
    <GameView
      key={gameId}
      transport={transport}
      myId={user.id}
      title={room?.kind === 'private' ? `Room ${room.code}` : 'Online match'}
      onExit={() => navigate('/play')}
      onPlayAgain={backToRoom ?? (() => navigate('/online'))}
      playAgainLabel={backToRoom ? 'Back to room' : 'Find another match'}
    />
  );
}

export function SoloGamePage() {
  const navigate = useNavigate();
  const location = useLocation();
  usePageMeta({ title: 'Solo game', noindex: true });
  const [session, setSession] = useState<{ key: number; config: SoloConfig; resume: SavedSolo['state'] | null } | null>(() => {
    const fresh = (location.state as { config?: SoloConfig } | null)?.config;
    if (fresh) return { key: 1, config: fresh, resume: null };
    const saved = loadSavedSolo();
    return saved ? { key: 1, config: saved.config, resume: saved.state } : null;
  });

  useEffect(() => {
    if (!session) navigate('/solo', { replace: true });
    // Drop the router state so a refresh resumes the saved game instead of starting over.
    else if (location.state) navigate('/solo/game', { replace: true, state: null });
  }, [session, navigate, location.state]);

  const [transport, setTransport] = useState<WorkerTransport | null>(null);
  useEffect(() => {
    if (!session) return;
    const t = new WorkerTransport(session.config, session.resume);
    setTransport(t);
    return () => t.dispose();
  }, [session]);

  if (!session || !transport) return null;
  return (
    <GameView
      key={session.key}
      transport={transport}
      myId={SOLO_HUMAN_ID}
      title={`Solo · ${session.config.opponents} AI · ${session.config.difficulty}`}
      onExit={() => {
        clearSavedSolo();
        navigate('/play');
      }}
      onPlayAgain={() => {
        clearSavedSolo();
        setSession({ key: session.key + 1, config: session.config, resume: null });
      }}
    />
  );
}
