import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AiDifficulty, RoomSettings } from '@ludo/shared-types';
import { LIMITS } from '@ludo/config';
import { defaultRoomSettings } from '@ludo/game-engine';
import { audio } from '../services/audio';
import { socketClient } from '../services/socket';
import type { SoloConfig } from '../game/localHost';
import { loadSavedSolo } from '../game/workerTransport';
import { usePageMeta } from '../hooks/usePageMeta';
import { useMediaQuery, useOnline } from '../hooks/useMedia';
import { useAuth } from '../store/authStore';
import { useLobby } from '../store/lobbyStore';
import { toast } from '../store/uiStore';
import { Avatar } from '../components/Avatar';
import { RulesEditor } from '../components/RulesEditor';
import { Shell } from '../components/Shell';
import { InstallButton } from '../components/Mobile';
import { Field, Modal, Segmented, Spinner } from '../components/ui';

function OfflineNotice() {
  const online = useOnline();
  if (online) return null;
  return (
    <p className="offline-notice" role="alert">
      {OFFLINE_MESSAGE}
    </p>
  );
}

export const OFFLINE_MESSAGE = 'You’re offline. Reconnect to the internet to play online.';

/** Ensure we are signed in (as a guest if necessary) and the socket is connected. */
async function ready(): Promise<boolean> {
  // Online play never pretends to work offline.
  if (!navigator.onLine) {
    toast(OFFLINE_MESSAGE, 'warning', 4000);
    return false;
  }
  try {
    await useAuth.getState().ensureSession();
    socketClient.connect();
    if (!socketClient.connected) {
      await new Promise<void>((resolve) => {
        let done = false;
        let off: () => void = () => undefined;
        const finish = () => {
          if (done) return;
          done = true;
          off();
          resolve();
        };
        // onStatus may call back synchronously, so defer `finish` until `off` is assigned.
        off = socketClient.onStatus((s) => {
          if (s === 'connected') queueMicrotask(finish);
        });
        window.setTimeout(finish, 15_000);
      });
    }
    if (!socketClient.connected) {
      toast('Could not reach the game server. Please try again.', 'error');
      return false;
    }
    return true;
  } catch {
    toast('Could not start a session. Please try again.', 'error');
    return false;
  }
}

/** Navigate to the game as soon as the server starts it. */
function useGameStartRedirect(): void {
  const navigate = useNavigate();
  const restored = useLobby((s) => s.restoredGame);
  useEffect(() => {
    if (restored && restored.state.status === 'playing') navigate(`/game/${restored.gameId}`);
  }, [restored, navigate]);
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

// The first four are the primary actions (large, thumb-friendly on phones).
const TILES = [
  { to: '/online', title: 'Play Online', text: 'Quick match with players worldwide', icon: '🌐', tone: 'gold' },
  { to: '/solo', title: 'Play vs AI', text: '1–7 smart opponents, offline-ready', icon: '🤖', tone: 'cyan' },
  { to: '/friends?create=1', title: 'Create Room', text: 'Host and set the rules', icon: '✨', tone: 'violet' },
  { to: '/friends?join=1', title: 'Join Room', text: 'Enter a 6-character code', icon: '🔑', tone: 'green' },
  { to: '/friends', title: 'Play With Friends', text: 'Private room with a share code', icon: '👥', tone: 'pink' },
  { to: '/leaderboard', title: 'Leaderboard', text: 'Top players by wins & rating', icon: '🏆', tone: 'gold' },
  { to: '/profile', title: 'Profile', text: 'Stats, history and achievements', icon: '🪐', tone: 'violet' },
  { to: '/settings', title: 'Settings', text: 'Sound, music, motion, quality', icon: '⚙️', tone: 'slate' },
  { to: '/how-to-play', title: 'How to Play', text: 'Rules in two minutes', icon: '📖', tone: 'slate' },
] as const;

export function MenuPage() {
  usePageMeta({ title: 'Play', path: '/play', description: 'Choose how to play Ludo Nova: online, with friends, or against AI.' });
  const user = useAuth((s) => s.user);
  return (
    <Shell>
      <section className="menu-head">
        <div>
          <h1>Ready to roll{user ? `, ${user.displayName}` : ''}?</h1>
          <p>Pick a mode. Every online game is server-authoritative — fair dice, every time.</p>
        </div>
      </section>
      <nav className="menu-grid" aria-label="Game modes">
        {TILES.map((t, i) => (
          <Link key={t.title} to={t.to} className={`menu-tile tone-${t.tone} ${i < 4 ? 'is-hero' : ''}`} onClick={() => audio.play('click')}>
            <span className="menu-icon" aria-hidden="true">
              {t.icon}
            </span>
            <span className="menu-title">{t.title}</span>
            <span className="menu-text">{t.text}</span>
          </Link>
        ))}
      </nav>
      <div className="menu-install">
        <span>
          <strong>Install Ludo Nova</strong>
          <span className="hint">Full-screen play from your home screen</span>
        </span>
        <InstallButton />
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Solo setup
// ---------------------------------------------------------------------------

export function SoloSetupPage() {
  usePageMeta({ title: 'Play vs AI', path: '/solo', description: 'Play Ludo against 1 to 7 AI opponents with four difficulty levels.' });
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const saved = loadSavedSolo();
  const [opponents, setOpponents] = useState(3);
  const [difficulty, setDifficulty] = useState<AiDifficulty>('medium');
  const [settings, setSettings] = useState<RoomSettings>({ ...defaultRoomSettings(4), turnTimeSeconds: 30 });
  const [timer, setTimer] = useState(false);

  const start = () => {
    audio.unlock();
    const config: SoloConfig = {
      playerName: user?.displayName ?? 'You',
      avatar: user?.avatar ?? 'comet',
      opponents,
      difficulty,
      turnTimeSeconds: timer ? settings.turnTimeSeconds : 0,
      tokensPerPlayer: settings.tokensPerPlayer,
      variants: settings.variants,
    };
    navigate('/solo/game', { state: { config } });
  };

  return (
    <Shell>
      <div className="setup panel">
        <h1>Play vs AI</h1>
        <p>Same rules engine as online play. Solo games are practice — they don’t affect ranked stats.</p>
        {saved && (
          <div className="resume">
            <span>You have an unfinished solo game.</span>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate('/solo/game')}>
              Resume
            </button>
          </div>
        )}
        <div className="rules-row">
          <span className="rules-label">Opponents</span>
          <Segmented
            label="Number of AI opponents"
            value={opponents}
            onChange={setOpponents}
            options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: n }))}
          />
        </div>
        <div className="rules-row">
          <span className="rules-label">Difficulty</span>
          <Segmented
            label="AI difficulty"
            value={difficulty}
            onChange={setDifficulty}
            options={(['easy', 'medium', 'hard', 'expert'] as const).map((d) => ({ value: d, label: d[0]!.toUpperCase() + d.slice(1) }))}
          />
        </div>
        <div className="rules-row">
          <span className="rules-label">Turn timer</span>
          <Segmented label="Turn timer" value={timer ? 'on' : 'off'} onChange={(v) => setTimer(v === 'on')} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
        </div>
        <RulesEditor value={settings} onChange={setSettings} showPlayers={false} />
        <p className="hint">
          Board: {opponents + 1 <= 4 ? 'classic 4-arm' : opponents + 1 <= 6 ? '6-arm star' : '8-arm star'} for {opponents + 1} players.
        </p>
        <button className="btn btn-primary btn-lg btn-block" onClick={start}>
          Start game
        </button>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Quick match
// ---------------------------------------------------------------------------

export function OnlinePage() {
  usePageMeta({ title: 'Play Online', path: '/online', description: 'Find a 2, 4, 6 or 8 player Ludo match online.' });
  useGameStartRedirect();
  const matchmaking = useLobby((s) => s.matchmaking);
  const [size, setSize] = useState<number>(4);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const searching = matchmaking.state === 'searching';

  useEffect(() => {
    if (!searching || !matchmaking.since) return;
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - matchmaking.since!) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [searching, matchmaking.since]);

  const find = async () => {
    audio.unlock();
    setBusy(true);
    if (await ready()) {
      const r = await socketClient.emit('matchmaking:join', { playerCount: size });
      if (!r.ok) toast(r.error.message, 'error');
      else useLobby.setState({ matchmaking: r.status });
    }
    setBusy(false);
  };
  const cancel = async () => {
    await socketClient.emit('matchmaking:leave', {});
    useLobby.setState({ matchmaking: { state: 'idle', playerCount: null, waiting: 0, since: null } });
  };

  return (
    <Shell>
      <div className="setup panel">
        <h1>Play Online</h1>
        <OfflineNotice />
        <p>Choose a table size and we’ll seat you with other players.</p>
        <div className="size-picker" role="radiogroup" aria-label="Table size">
          {LIMITS.matchmakingSizes.map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={size === n}
              disabled={searching}
              className={`size-option ${size === n ? 'is-active' : ''}`}
              onClick={() => {
                audio.play('click');
                setSize(n);
              }}
            >
              <span className="size-num">{n}</span>
              <span className="size-label">Players</span>
              <span className="size-board">{n <= 4 ? 'Classic' : n <= 6 ? 'Hex star' : 'Octa star'}</span>
            </button>
          ))}
        </div>
        {searching ? (
          <div className="searching" role="status">
            <div className="radar" aria-hidden="true" />
            <div>
              <strong>Searching for a {matchmaking.playerCount}-player match…</strong>
              <span>
                {matchmaking.waiting} / {matchmaking.playerCount} players · {elapsed}s
              </span>
            </div>
            <button className="btn btn-secondary" onClick={cancel}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn btn-primary btn-lg btn-block" onClick={find} disabled={busy}>
            {busy ? 'Connecting…' : 'Find Match'}
          </button>
        )}
        <p className="hint">Tip: invite friends with a private room for an instant game, or add AI seats.</p>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Friends: create / join private room
// ---------------------------------------------------------------------------

export function FriendsPage() {
  usePageMeta({ title: 'Play With Friends', path: '/friends', description: 'Create a private Ludo room and share the code with friends.' });
  const navigate = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const [tab, setTab] = useState<'create' | 'join'>(params.get('join') ? 'join' : 'create');
  const [settings, setSettings] = useState<RoomSettings>(defaultRoomSettings(4));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const create = async () => {
    audio.unlock();
    setBusy(true);
    if (await ready()) {
      const r = await socketClient.emit('room:create', { settings });
      if (r.ok) navigate(`/room/${r.room.code}`);
      else toast(r.error.message, 'error');
    }
    setBusy(false);
  };
  const join = async (e: FormEvent) => {
    e.preventDefault();
    audio.unlock();
    const normalized = code.trim().toUpperCase();
    if (normalized.length !== LIMITS.roomCodeLength) {
      setError(`Room codes have ${LIMITS.roomCodeLength} characters.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    if (await ready()) {
      const r = await socketClient.emit('room:join', { code: normalized });
      if (r.ok) navigate(`/room/${r.room.code}`);
      else setError(r.error.code === 'VALIDATION' ? 'That code doesn’t look right.' : r.error.message);
    }
    setBusy(false);
  };

  return (
    <Shell>
      <div className="setup panel">
        <h1>Play With Friends</h1>
        <OfflineNotice />
        <Segmented
          label="Create or join"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'create', label: 'Create room' },
            { value: 'join', label: 'Join room' },
          ]}
        />
        {tab === 'create' ? (
          <>
            <RulesEditor value={settings} onChange={setSettings} />
            <button className="btn btn-primary btn-lg btn-block" onClick={create} disabled={busy}>
              {busy ? 'Creating…' : 'Create Private Room'}
            </button>
          </>
        ) : (
          <form onSubmit={join} className="join-form">
            <Field label="Room code" error={error}>
              <input
                className="input input-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                placeholder="A7K9P2"
                autoComplete="off"
                autoCapitalize="characters"
                inputMode="text"
                aria-invalid={!!error}
              />
            </Field>
            <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length < 6}>
              {busy ? 'Joining…' : 'Join Room'}
            </button>
          </form>
        )}
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Private room lobby
// ---------------------------------------------------------------------------

export function RoomPage({ code }: { code: string }) {
  usePageMeta({ title: `Room ${code}`, noindex: true });
  useGameStartRedirect();
  const navigate = useNavigate();
  const room = useLobby((s) => s.room);
  const kickedFrom = useLobby((s) => s.kickedFrom);
  const user = useAuth((s) => s.user);
  const [joining, setJoining] = useState(false);
  const [botLevel, setBotLevel] = useState<AiDifficulty>('medium');
  const [rulesOpen, setRulesOpen] = useState(false);
  const narrow = useMediaQuery('(max-width: 899px)');

  // Arriving by link: join the room.
  useEffect(() => {
    if (room?.code === code) return;
    let cancelled = false;
    setJoining(true);
    void (async () => {
      if (!(await ready())) return;
      const r = await socketClient.emit('room:join', { code });
      if (cancelled) return;
      if (!r.ok) {
        toast(r.error.message, 'error');
        navigate('/friends?join=1', { replace: true });
      }
      setJoining(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [code, room?.code, navigate]);

  useEffect(() => {
    if (kickedFrom) {
      toast('The host removed you from the room.', 'warning');
      useLobby.setState({ kickedFrom: null });
      navigate('/play');
    }
  }, [kickedFrom, navigate]);

  if (!room || room.code !== code || !user) {
    return (
      <Shell>
        <div className="setup panel">{joining ? <Spinner label="Joining room…" /> : <Spinner />}</div>
      </Shell>
    );
  }

  const isHost = room.hostId === user.id;
  const mySeat = room.seats.find((s) => s.id === user.id);
  const allReady = room.seats.every((s) => s.kind === 'bot' || s.isHost || s.ready);
  const emptySeats = Math.max(0, room.settings.maxPlayers - room.seats.length);
  const shareUrl = `${window.location.origin}/room/${room.code}`;

  const emit = async <E extends 'room:settings' | 'room:addBot' | 'room:removeBot' | 'player:ready' | 'room:kick' | 'game:start' | 'room:leave'>(
    event: E,
    payload: Parameters<typeof socketClient.emit<E>>[1],
  ) => {
    audio.play('click');
    const r = await socketClient.emit(event, payload);
    if (!r.ok) toast(r.error.message, 'error');
    return r;
  };

  const copy = async () => {
    try {
      if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: 'Join my Ludo Nova room', text: `Room code ${room.code}`, url: shareUrl });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        toast('Invite link copied!', 'success');
      }
    } catch {
      /* share sheet dismissed */
    }
  };

  return (
    <Shell wide>
      <div className="lobby">
        <section className="panel lobby-main">
          <div className="lobby-head">
            <div>
              <span className="eyebrow">Private room</span>
              <h1 className="room-code" aria-label={`Room code ${room.code.split('').join(' ')}`}>
                {room.code}
              </h1>
            </div>
            <div className="lobby-head-actions">
              <button className="btn btn-secondary" onClick={copy}>
                Share invite
              </button>
            </div>
          </div>
          <p className="lobby-count">
            Players: <strong>{room.seats.length}/{room.settings.maxPlayers}</strong>
          </p>
          <div className="seat-dots" aria-hidden="true">
            {Array.from({ length: room.settings.maxPlayers }, (_, i) => (
              <i key={i} className={i < room.seats.length ? 'is-filled' : ''} />
            ))}
          </div>
          {narrow && (
            <button className="btn btn-secondary btn-block rules-open" onClick={() => setRulesOpen(true)}>
              Table rules · {room.settings.maxPlayers} players · {room.settings.turnTimeSeconds}s
            </button>
          )}
          <ul className="seats">
            {room.seats.map((s, i) => (
              <li key={s.id} className={`seat ${s.ready || s.isHost || s.kind === 'bot' ? 'is-ready' : ''}`} style={{ animationDelay: `${i * 60}ms` }}>
                <Avatar id={s.avatar} size={48} className="seat-avatar" />
                <div className="seat-body">
                  <span className="seat-name">
                    {s.name}
                    {s.id === user.id && <em> (you)</em>}
                  </span>
                  <span className="seat-meta">
                    {s.isHost ? 'Host' : s.kind === 'bot' ? `AI · ${s.botLevel}` : s.ready ? 'Ready' : 'Not ready'}
                    {!s.connected && ' · offline'}
                  </span>
                </div>
                {isHost && !s.isHost && (
                  <button
                    className="icon-btn"
                    aria-label={`Remove ${s.name}`}
                    onClick={() => (s.kind === 'bot' ? emit('room:removeBot', { botId: s.id }) : emit('room:kick', { userId: s.id }))}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
            {Array.from({ length: emptySeats }, (_, i) => (
              <li key={`empty-${i}`} className="seat seat-empty">
                <span className="seat-avatar-empty" aria-hidden="true" />
                <span className="seat-meta">Waiting for player…</span>
              </li>
            ))}
          </ul>
          {isHost && emptySeats > 0 && (
            <div className="add-bot">
              <Segmented
                label="Bot difficulty"
                value={botLevel}
                onChange={setBotLevel}
                options={(['easy', 'medium', 'hard', 'expert'] as const).map((d) => ({ value: d, label: d[0]!.toUpperCase() + d.slice(1) }))}
              />
              <button className="btn btn-secondary" onClick={() => emit('room:addBot', { difficulty: botLevel })}>
                + Add AI player
              </button>
            </div>
          )}
          <div className="lobby-actions">
            <button className="btn btn-ghost" onClick={async () => { await emit('room:leave', {}); useLobby.setState({ room: null }); navigate('/play'); }}>
              Leave room
            </button>
            {isHost ? (
              <button
                className="btn btn-primary btn-lg"
                disabled={room.seats.length < 2 || !allReady}
                onClick={() => emit('game:start', {})}
                title={room.seats.length < 2 ? 'Need at least 2 players' : !allReady ? 'Waiting for everyone to be ready' : undefined}
              >
                Start game
              </button>
            ) : (
              <button className={`btn btn-lg ${mySeat?.ready ? 'btn-secondary' : 'btn-primary'}`} onClick={() => emit('player:ready', { ready: !mySeat?.ready })}>
                {mySeat?.ready ? 'Not ready' : 'I’m ready'}
              </button>
            )}
          </div>
        </section>
        {narrow ? (
          rulesOpen && (
            <Modal title="Table rules" onClose={() => setRulesOpen(false)}>
          {!isHost && <p className="hint">Only the host can change the rules.</p>}
          <RulesEditor
            value={room.settings}
            disabled={!isHost}
            minPlayers={Math.max(2, room.seats.length)}
            onChange={(settings) => void emit('room:settings', { settings })}
          />
            </Modal>
          )
        ) : (
          <aside className="panel lobby-rules">
            <h2>Table rules</h2>
          {!isHost && <p className="hint">Only the host can change the rules.</p>}
          <RulesEditor
            value={room.settings}
            disabled={!isHost}
            minPlayers={Math.max(2, room.seats.length)}
            onChange={(settings) => void emit('room:settings', { settings })}
          />
          </aside>
        )}
      </div>
    </Shell>
  );
}

