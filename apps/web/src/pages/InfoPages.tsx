import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { GameHistoryEntry, LeaderboardCategory, LeaderboardResponse, ProfileView } from '@ludo/shared-types';
import { LIMITS } from '@ludo/config';
import { ApiError, api } from '../services/api';
import { audio } from '../services/audio';
import { deviceProfile } from '../services/device';
import { haptic, hapticsSupported } from '../services/haptics';
import { PLAYER_HEX } from '../game/layout';
import { ORDINAL } from '../game/director';
import { usePageMeta } from '../hooks/usePageMeta';
import { useAuth } from '../store/authStore';
import { type Quality, resolveQuality, useSettings } from '../store/settingsStore';
import { toast } from '../store/uiStore';
import { AVATAR_IDS, Avatar } from '../components/Avatar';
import { InstallButton } from '../components/Mobile';
import { Shell } from '../components/Shell';
import { Field, Segmented, Spinner, Switch } from '../components/ui';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** On phones the on-screen keyboard can cover the focused field: scroll it into view once the keyboard is up. */
function keepFocusedInView(e: React.FocusEvent<HTMLFormElement>): void {
  const el = e.target as HTMLElement;
  if (!(el instanceof HTMLInputElement)) return;
  window.setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 320);
}

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  usePageMeta({ title: mode === 'login' ? 'Sign in' : 'Create account', path: `/${mode}` });
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuth((s) => s.user);
  const from = (location.state as { from?: string } | null)?.from ?? '/play';
  const [form, setForm] = useState({ login: '', username: '', email: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const upgrading = mode === 'register' && user?.isGuest;

  useEffect(() => {
    if (user && !user.isGuest && mode === 'login') navigate(from, { replace: true });
  }, [user, mode, from, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    audio.unlock();
    setBusy(true);
    setErrors({});
    try {
      if (mode === 'login') await api.login({ login: form.login, password: form.password });
      else await api.register({ username: form.username, password: form.password, ...(form.email ? { email: form.email } : {}) });
      toast(mode === 'login' ? 'Welcome back!' : upgrading ? 'Account created — your guest progress was kept.' : 'Account created!', 'success');
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields ?? { _: err.message });
        if (!err.fields) toast(err.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const guest = async () => {
    setBusy(true);
    try {
      await api.guest();
      navigate(from, { replace: true });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start a guest session.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <Shell>
      <form className="setup panel auth" onSubmit={submit} noValidate onFocusCapture={keepFocusedInView}>
        <h1>{mode === 'login' ? 'Welcome back' : upgrading ? 'Save your progress' : 'Create your account'}</h1>
        <p>{mode === 'login' ? 'Sign in to keep your stats, rating and achievements.' : 'Pick a username — you can change your display name later.'}</p>
        {mode === 'login' ? (
          <Field label="Username or email" error={errors.login}>
            <input className="input" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" value={form.login} onChange={set('login')} required />
          </Field>
        ) : (
          <>
            <Field label="Username" error={errors.username}>
              <input className="input" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" value={form.username} onChange={set('username')} minLength={LIMITS.usernameMin} maxLength={LIMITS.usernameMax} required />
            </Field>
            <Field label="Email (optional)" error={errors.email}>
              <input className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" enterKeyHint="next" value={form.email} onChange={set('email')} />
            </Field>
          </>
        )}
        <Field label="Password" error={errors.password}>
          <input
            className="input"
            type="password"
            enterKeyHint="go"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={form.password}
            onChange={set('password')}
            minLength={mode === 'register' ? LIMITS.passwordMin : 1}
            required
          />
        </Field>
        {errors._ && <p className="field-error" role="alert">{errors._}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        {!user && (
          <button type="button" className="btn btn-ghost btn-block" onClick={guest} disabled={busy}>
            Continue as guest
          </button>
        )}
        <p className="auth-switch">
          {mode === 'login' ? (
            <>New here? <Link to="/register" state={{ from }}>Create an account</Link></>
          ) : (
            <>Already have an account? <Link to="/login" state={{ from }}>Sign in</Link></>
          )}
        </p>
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export function ProfilePage() {
  const { userId } = useParams();
  const me = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const navigate = useNavigate();
  const own = !userId || userId === me?.id;
  usePageMeta({ title: 'Profile', noindex: true });
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [history, setHistory] = useState<GameHistoryEntry[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (own && status === 'anonymous') {
      navigate('/login', { replace: true, state: { from: '/profile' } });
      return;
    }
    if (own && !me) return;
    let alive = true;
    (own ? api.myProfile() : api.profile(userId!))
      .then((p) => {
        if (!alive) return;
        setProfile(p);
        setName(p.user.displayName);
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the profile.'));
    if (own) api.history().then((h) => alive && setHistory(h.games)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [own, me, userId, status, navigate]);

  const save = async (patch: { displayName?: string; avatar?: string }) => {
    try {
      const p = await api.updateProfile(patch);
      setProfile(p);
      useAuth.getState().setUser(p.user);
      toast('Profile updated', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? (Object.values(err.fields ?? {})[0] ?? err.message) : 'Could not save.', 'error');
    }
  };

  if (error) return <Shell><div className="setup panel"><h1>Profile</h1><p>{error}</p></div></Shell>;
  if (!profile) return <Shell><div className="setup panel"><Spinner label="Loading profile…" /></div></Shell>;
  const s = profile.stats;
  const unlocked = profile.achievements.filter((a) => a.unlockedAt).length;

  return (
    <Shell wide>
      <div className="profile">
        <section className="panel profile-card">
          <Avatar id={profile.user.avatar} size={96} ring="#ffc94d" />
          <div>
            <h1>{profile.user.displayName}</h1>
            <p className="hint">
              @{profile.user.username}
              {profile.user.isGuest && ' · Guest account'} · Member since {new Date(profile.memberSince).toLocaleDateString()}
            </p>
            {own && profile.user.isGuest && (
              <Link to="/register" className="btn btn-primary btn-sm">Create an account to keep your progress</Link>
            )}
          </div>
          {own && (
            <button className="btn btn-ghost btn-sm profile-logout" onClick={async () => { await useAuth.getState().logout(); navigate('/'); }}>
              Sign out
            </button>
          )}
        </section>

        <section className="stat-grid" aria-label="Statistics">
          {[
            ['Games played', s.gamesPlayed],
            ['Games won', s.gamesWon],
            ['Win rate', `${s.winRate}%`],
            ['Rating', s.rating],
            ['Captures', s.captures],
            ['Tokens home', s.tokensFinished],
            ['Sixes rolled', s.sixesRolled],
            ['Best finish', s.bestRank ? ORDINAL[s.bestRank - 1] : '—'],
          ].map(([label, value]) => (
            <div key={label} className="stat panel">
              <span className="stat-value">{value}</span>
              <span className="stat-label">{label}</span>
            </div>
          ))}
        </section>
        <p className="hint">Statistics count ranked online games with at least two human players. They are calculated by the server.</p>

        {own && (
          <section className="panel">
            <h2>Customize</h2>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save({ displayName: name });
              }}
            >
              <Field label="Display name">
                <input className="input" value={name} maxLength={LIMITS.displayNameMax} onChange={(e) => setName(e.target.value)} />
              </Field>
              <button className="btn btn-secondary">Save</button>
            </form>
            <div className="avatar-picker" role="radiogroup" aria-label="Avatar">
              {AVATAR_IDS.map((id) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={profile.user.avatar === id}
                  className={profile.user.avatar === id ? 'is-active' : ''}
                  onClick={() => void save({ avatar: id })}
                  aria-label={id}
                >
                  <Avatar id={id} size={52} />
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="panel">
          <h2>Achievements <span className="hint">{unlocked}/{profile.achievements.length}</span></h2>
          <ul className="achievements">
            {profile.achievements.map((a) => (
              <li key={a.key} className={a.unlockedAt ? 'is-unlocked' : 'is-locked'}>
                <span className="ach-icon" aria-hidden="true">{a.unlockedAt ? '🏅' : '🔒'}</span>
                <span>
                  <strong>{a.name}</strong>
                  <span className="hint">{a.description}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {own && (
          <section className="panel">
            <h2>Recent games</h2>
            {history.length === 0 ? (
              <p className="hint">No online games yet — your results will appear here.</p>
            ) : (
              <ul className="history">
                {history.map((h) => (
                  <li key={h.gameId}>
                    <span className="pc-dot" style={{ background: PLAYER_HEX[h.color] }} />
                    <span>{h.rank ? ORDINAL[h.rank - 1] : '—'} of {h.playerCount}</span>
                    <span className="hint">⚔ {h.captures}</span>
                    <span className={h.ratingDelta >= 0 ? 'delta-up' : 'delta-down'}>{h.ratingDelta > 0 ? '+' : ''}{h.ratingDelta}</span>
                    <span className="hint">{h.finishedAt ? new Date(h.finishedAt).toLocaleString() : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<LeaderboardCategory, string> = { wins: 'Wins', games: 'Games played', captures: 'Captures', rating: 'Rating' };

export function LeaderboardPage() {
  usePageMeta({ title: 'Leaderboard', path: '/leaderboard', description: 'The top Ludo Nova players by wins, games, captures and rating.' });
  const [category, setCategory] = useState<LeaderboardCategory>('wins');
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = useAuth((s) => s.user);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.leaderboard(category).then((d) => alive && setData(d)).catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the leaderboard.'));
    return () => {
      alive = false;
    };
  }, [category, me?.id]);
  return (
    <Shell>
      <div className="panel leaderboard">
        <h1>Leaderboard</h1>
        <Segmented label="Category" value={category} onChange={setCategory} options={(Object.keys(CATEGORY_LABEL) as LeaderboardCategory[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} />
        {error && <p className="field-error">{error}</p>}
        {!data && !error && <Spinner label="Loading…" />}
        {data && data.entries.length === 0 && <p className="hint">No ranked games yet. Be the first on the board!</p>}
        {data && data.entries.length > 0 && (
          <table className="lb-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col">{CATEGORY_LABEL[category]}</th>
                <th scope="col">Games</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.user.id} className={e.user.id === me?.id ? 'is-me' : ''}>
                  <td className={`lb-rank rank-${e.rank}`}>{e.rank}</td>
                  <td>
                    <Link to={`/profile/${e.user.id}`} className="lb-player">
                      <Avatar id={e.user.avatar} size={30} />
                      {e.user.displayName}
                    </Link>
                  </td>
                  <td className="lb-value">{e.value}</td>
                  <td>{e.gamesPlayed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data?.me && !data.entries.some((e) => e.user.id === me?.id) && (
          <p className="lb-me">Your position: #{data.me.rank} · {data.me.value}</p>
        )}
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const TIER_LABEL = { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' } as const;
const TIER_HINT = {
  low: 'Low: no shadows, reflections or post-processing, fewer effect particles, 30 fps cap — best for older phones and battery life.',
  medium: 'Medium: soft shadows and reflections, no post-processing.',
  high: 'High: sharper shadows, reflections, anti-aliasing and a subtle bloom on effects.',
  ultra: 'Ultra: sharper shadows, higher resolution and extra effects for powerful GPUs.',
} as const;

export function SettingsPage() {
  usePageMeta({ title: 'Settings', noindex: true });
  const s = useSettings();
  return (
    <Shell>
      <div className="setup panel">
        <h1>Settings</h1>
        <h2 className="settings-h">Audio</h2>
        <Switch label="Sound effects" checked={s.soundOn} onChange={(soundOn) => { s.set({ soundOn }); audio.unlock(); }} />
        <label className="slider-row">
          <span>Effects volume</span>
          <input type="range" min={0} max={1} step={0.05} value={s.sfxVolume} onChange={(e) => s.set({ sfxVolume: Number(e.target.value) })} onPointerUp={() => audio.play('click')} />
        </label>
        <Switch label="Music" hint="Original generative ambient soundtrack" checked={s.musicOn} onChange={(musicOn) => { audio.unlock(); s.set({ musicOn }); }} />
        <label className="slider-row">
          <span>Music volume</span>
          <input type="range" min={0} max={1} step={0.05} value={s.musicVolume} onChange={(e) => s.set({ musicVolume: Number(e.target.value) })} />
        </label>
        <Switch
          label="Haptic feedback"
          hint={hapticsSupported() ? 'Subtle vibration on rolls, picks, captures and wins' : 'Not supported by this browser'}
          checked={s.haptics}
          disabled={!hapticsSupported()}
          onChange={(haptics) => {
            s.set({ haptics });
            if (haptics) haptic('tap');
          }}
        />
        <h2 className="settings-h">Visuals</h2>
        <Switch label="Reduce animations" hint="Fewer particles, no camera motion, faster moves, no post-processing" checked={s.reduceMotion} onChange={(reduceMotion) => s.set({ reduceMotion })} />
        <div className="rules-row">
          <span className="rules-label">
            Graphics quality
            <span className="hint quality-detected">Auto picks {TIER_LABEL[deviceProfile().recommended]} on this device</span>
          </span>
          <Segmented<Quality>
            label="Graphics quality"
            value={s.quality}
            onChange={(quality) => s.set({ quality })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'ultra', label: 'Ultra' },
            ]}
          />
        </div>
        <p className="hint">{TIER_HINT[resolveQuality(s.quality)]}</p>
        <h2 className="settings-h">Social</h2>
        <Switch label="Show emotes" checked={s.showEmotes} onChange={(showEmotes) => s.set({ showEmotes })} />
        <h2 className="settings-h">App</h2>
        <div className="settings-row">
          <span>Language</span>
          <span className="hint">English</span>
        </div>
        <div className="settings-row">
          <span>Install app</span>
          <InstallButton />
        </div>
        <Link to="/how-to-play" className="settings-row settings-link">
          <span>How to Play</span>
          <span aria-hidden="true">›</span>
        </Link>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// How to play
// ---------------------------------------------------------------------------

export function HowToPlayPage() {
  usePageMeta({ title: 'How to Play', path: '/how-to-play', description: 'Learn the rules of Ludo Nova: releasing tokens, captures, safe squares, extra turns and winning.' });
  return (
    <Shell>
      <article className="panel prose">
        <h1>How to Play</h1>
        <p>Race all of your tokens from your base, once around the board and up your coloured home column to the glowing centre.</p>
        <h2>Your turn</h2>
        <ol>
          <li><strong>Roll the die.</strong> Tap the die (or press Space). The server rolls — the animation just shows the result.</li>
          <li><strong>Leave base on a 6.</strong> A six moves a token onto your start square (hosts can also allow a 1).</li>
          <li><strong>Move a token</strong> exactly the number rolled. Glowing tokens are the ones that can move — tap one (or press 1–4).</li>
        </ol>
        <h2>Captures & safe squares</h2>
        <p>Land on a square with a rival token and it goes back to its base. Start squares (ringed) and stars are <strong>safe</strong> — nobody can be captured there. Your home column is private.</p>
        <h2>Extra turns</h2>
        <ul>
          <li>Roll a <strong>6</strong>, capture a token, or bring a token home → roll again.</li>
          <li>Three sixes in a row forfeit the turn.</li>
        </ul>
        <h2>Winning</h2>
        <p>Bring every token to the centre with an exact roll. The first player home wins; larger tables can keep playing to decide 2nd, 3rd and beyond.</p>
        <h2>Timers & disconnects</h2>
        <p>Each turn has a timer. If it runs out the server plays for you; after three missed turns in a row you forfeit. If you drop out, your seat is held for a while — just reopen the game to continue.</p>
        <h2>Bigger tables</h2>
        <p>Five or six players use a six-arm star board, seven or eight an eight-arm star. The rules are identical.</p>
        <p><Link to="/play" className="btn btn-primary">Let’s play</Link></p>
      </article>
    </Shell>
  );
}

export function NotFoundPage() {
  usePageMeta({ title: 'Not found', noindex: true });
  return (
    <Shell>
      <div className="setup panel">
        <h1>Lost in space</h1>
        <p>We couldn’t find that page.</p>
        <Link to="/" className="btn btn-primary">Back home</Link>
      </div>
    </Shell>
  );
}
