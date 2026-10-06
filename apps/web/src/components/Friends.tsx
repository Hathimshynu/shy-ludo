import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FriendEntry, FriendsResponse } from '@ludo/shared-types';
import { ApiError, api } from '../services/api';
import { socketClient } from '../services/socket';
import { useAuth } from '../store/authStore';
import { toast } from '../store/uiStore';
import { Avatar } from './Avatar';
import { Field } from './ui';

const EMPTY: FriendsResponse = { friends: [], incoming: [], outgoing: [] };

function useFriends(enabled: boolean) {
  const [data, setData] = useState<FriendsResponse>(EMPTY);
  const [loading, setLoading] = useState(enabled);
  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      setData(await api.friends());
    } catch {
      /* shown as an empty list; actions report their own errors */
    } finally {
      setLoading(false);
    }
  }, [enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, loading, reload };
}

function Row({ entry, children }: { entry: FriendEntry; children?: ReactNode }) {
  return (
    <li className="friend-row">
      <Avatar id={entry.user.avatar} size={34} />
      <span className="friend-name">
        <strong>{entry.user.displayName}</strong>
        <span className="hint">@{entry.user.username}</span>
      </span>
      <span className="friend-actions">{children}</span>
    </li>
  );
}

/** Friends list, requests and "add by username" for the signed-in player's profile. */
export function FriendsPanel() {
  const user = useAuth((s) => s.user);
  const registered = !!user && !user.isGuest;
  const { data, loading, reload } = useFriends(registered);
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      if (success) toast(success, 'success');
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy('add');
    try {
      const r = await api.addFriend(username);
      toast(r.status === 'accepted' ? `You and ${r.user.displayName} are now friends.` : `Friend request sent to ${r.user.displayName}.`, 'success');
      setUsername('');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? (err.fields?.username ?? err.message) : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  if (!registered) {
    return (
      <section className="panel friends">
        <h2>Friends</h2>
        <p className="hint">Friends need a saved account. <Link to="/register">Create an account</Link> to add friends and invite them to your rooms.</p>
      </section>
    );
  }

  return (
    <section className="panel friends" aria-busy={loading}>
      <h2>Friends</h2>
      <form className="inline-form" onSubmit={add} noValidate>
        <Field label="Add a friend by username" error={error}>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="send"
            placeholder="username"
            aria-invalid={error ? 'true' : undefined}
          />
        </Field>
        <button className="btn btn-primary" disabled={busy === 'add' || !username.trim()}>
          Send request
        </button>
      </form>

      {data.incoming.length > 0 && (
        <>
          <h3>Requests</h3>
          <ul className="friend-list">
            {data.incoming.map((f) => (
              <Row key={f.user.id} entry={f}>
                <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void run(f.user.id, () => api.acceptFriend(f.user.id), `You and ${f.user.displayName} are now friends.`)}>
                  Accept
                </button>
                <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void run(f.user.id, () => api.rejectFriend(f.user.id))}>
                  Decline
                </button>
              </Row>
            ))}
          </ul>
        </>
      )}

      <h3>Your friends</h3>
      {data.friends.length === 0 ? (
        <p className="hint">{loading ? 'Loading…' : 'No friends yet. Add someone by their username.'}</p>
      ) : (
        <ul className="friend-list">
          {data.friends.map((f) => (
            <Row key={f.user.id} entry={f}>
              {confirmRemove === f.user.id ? (
                <>
                  <button className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => void run(f.user.id, () => api.removeFriend(f.user.id)).then(() => setConfirmRemove(null))}>
                    Remove
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRemove(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRemove(f.user.id)} aria-label={`Remove ${f.user.displayName}`}>
                  Remove
                </button>
              )}
            </Row>
          ))}
        </ul>
      )}

      {data.outgoing.length > 0 && (
        <>
          <h3>Sent requests</h3>
          <ul className="friend-list">
            {data.outgoing.map((f) => (
              <Row key={f.user.id} entry={f}>
                <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void run(f.user.id, () => api.removeFriend(f.user.id))}>
                  Cancel
                </button>
              </Row>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** In a private room lobby: invite friends (they get a notification with the room code). */
export function InviteFriends() {
  const user = useAuth((s) => s.user);
  const registered = !!user && !user.isGuest;
  const { data, loading } = useFriends(registered);
  const [invited, setInvited] = useState<Set<string>>(new Set());
  if (!registered || (!loading && data.friends.length === 0)) return null;
  const invite = async (id: string, name: string) => {
    const r = await socketClient.emit('friend:invite', { userId: id });
    if (r.ok) {
      setInvited((s) => new Set(s).add(id));
      toast(`Invite sent to ${name}.`, 'success', 1800);
    } else toast(r.error.message, 'error');
  };
  return (
    <section className="panel friends invite-friends">
      <h3>Invite friends</h3>
      <ul className="friend-list">
        {data.friends.map((f) => (
          <Row key={f.user.id} entry={f}>
            <button className="btn btn-secondary btn-sm" disabled={invited.has(f.user.id)} onClick={() => void invite(f.user.id, f.user.displayName)}>
              {invited.has(f.user.id) ? 'Invited' : 'Invite'}
            </button>
          </Row>
        ))}
      </ul>
    </section>
  );
}
