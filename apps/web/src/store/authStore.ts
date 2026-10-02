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

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  init: async () => {
    try {
      await refreshSession();
    } catch {
      /* network down: stay anonymous until the user acts */
    }
    if (get().status === 'loading') set({ status: 'anonymous' });
  },
  ensureSession: async () => {
    const { user } = get();
    if (user) return user;
    const session = await api.guest();
    return session.user;
  },
  logout: async () => {
    socketClient.disconnect();
    await api.logout();
  },
  setUser: (user) => set({ user }),
}));

onSessionChange((session) => {
  if (session) {
    useAuth.setState({ status: 'authenticated', user: session.user });
    socketClient.connect();
  } else {
    useAuth.setState({ status: 'anonymous', user: null });
    socketClient.disconnect();
  }
});
