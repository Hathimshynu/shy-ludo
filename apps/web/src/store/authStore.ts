import { create } from 'zustand';
import type { PublicUser } from '@ludo/shared-types';
import { api, onSessionChange, refreshSession } from '../services/api';
import { socketClient } from '../services/socket';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  user: PublicUser | null;
  init: () => Promise<void>;
  /** Make sure there is a session, creating a guest account if needed. */
  ensureSession: () => Promise<PublicUser>;
  logout: () => Promise<void>;
  setUser: (user: PublicUser) => void;
}

/** The boot-time session restore; everything that needs "the" user waits for it first. */
let initPromise: Promise<void> | null = null;
/** Shared in-flight guest creation, so concurrent callers never create two accounts. */
let guestPromise: Promise<PublicUser> | null = null;

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  init: () => {
    initPromise ??= (async () => {
      try {
        await refreshSession();
      } catch {
        /* network down: stay anonymous until the user acts */
      }
      if (get().status === 'loading') set({ status: 'anonymous' });
    })();
    return initPromise;
  },
  ensureSession: async () => {
    // A page opened directly (e.g. /room/CODE) must not create a guest while the
    // existing session is still being restored from the refresh cookie.
    if (get().status === 'loading') await get().init();
    const { user } = get();
    if (user) return user;
    guestPromise ??= api
      .guest()
      .then((s) => s.user)
      .finally(() => {
        guestPromise = null;
      });
    return guestPromise;
  },
  logout: async () => {
    socketClient.disconnect();
    await api.logout();
  },
  setUser: (user) => set({ user }),
}));

onSessionChange((session) => {
  if (session) {
    const previous = useAuth.getState().user;
    useAuth.setState({ status: 'authenticated', user: session.user });
    // A different account (login, sign-up, guest upgrade) must not keep using a socket
    // authenticated as the previous user.
    if (previous && previous.id !== session.user.id) socketClient.disconnect();
    socketClient.connect();
  } else {
    useAuth.setState({ status: 'anonymous', user: null });
    socketClient.disconnect();
  }
});
