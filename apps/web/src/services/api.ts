import type {
  ApiErrorBody,
  AuthResponse,
  GameEvent,
  GameHistoryEntry,
  GameState,
  LeaderboardCategory,
  LeaderboardResponse,
  ProfileView,
  PublicUser,
} from '@ludo/shared-types';
import { FRIENDLY_ERRORS, type ErrorCode } from '@ludo/shared-types';

const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Access token lives in memory only. The refresh token is an httpOnly cookie. */
let accessToken: string | null = null;
let accessExpiresAt = 0;
let refreshing: Promise<AuthResponse | null> | null = null;
type SessionListener = (session: AuthResponse | null) => void;
const listeners = new Set<SessionListener>();

export function onSessionChange(fn: SessionListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSession(session: AuthResponse | null): void {
  accessToken = session?.accessToken ?? null;
  accessExpiresAt = session ? Date.now() + session.expiresIn * 1000 : 0;
  listeners.forEach((l) => l(session));
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Returns a token valid for at least another minute, refreshing if necessary. */
export async function getFreshToken(): Promise<string | null> {
  if (accessToken && accessExpiresAt - Date.now() > 60_000) return accessToken;
  const session = await refreshSession();
  return session?.accessToken ?? null;
}

/** Exchange the refresh cookie for a new access token. Concurrent calls share one request. */
export function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= (async () => {
    try {
      const session = await request<AuthResponse>('/auth/refresh', { method: 'POST', auth: false, retry: false });
      setSession(session);
      return session;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setSession(null);
      else if (!(err instanceof ApiError)) throw err;
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  retry?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, retry = true, signal } = opts;
  const headers: Record<string, string> = { 'X-Requested-With': 'ludo' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('NETWORK', 'Connection lost. Please check your internet and try again.', 0);
  }
  if (res.status === 401 && auth && retry) {
    const session = await refreshSession();
    if (session) return request<T>(path, { ...opts, retry: false });
  }
  if (res.status === 204) return undefined as T;
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const e = (payload as ApiErrorBody | null)?.error;
    const code = e?.code ?? 'INTERNAL';
    const friendly = e?.message ?? FRIENDLY_ERRORS[(code as ErrorCode) in FRIENDLY_ERRORS ? (code as ErrorCode) : 'INTERNAL'];
    throw new ApiError(code, friendly, res.status, e?.fields);
  }
  return payload as T;
}

export const api = {
  async guest(displayName?: string): Promise<AuthResponse> {
    const s = await request<AuthResponse>('/auth/guest', { method: 'POST', body: displayName ? { displayName } : {}, auth: false });
    setSession(s);
    return s;
  },
  async register(input: { username: string; password: string; email?: string; displayName?: string }) {
    const s = await request<AuthResponse>('/auth/register', { method: 'POST', body: input });
    setSession(s);
    return s;
  },
  async login(input: { login: string; password: string }) {
    const s = await request<AuthResponse>('/auth/login', { method: 'POST', body: input, auth: false });
    setSession(s);
    return s;
  },
  async logout(): Promise<void> {
    try {
      await request('/auth/logout', { method: 'POST', auth: false, retry: false });
    } finally {
      setSession(null);
    }
  },
  me: () => request<{ user: PublicUser }>('/auth/me'),
  myProfile: () => request<ProfileView>('/profile/me'),
  profile: (userId: string) => request<ProfileView>(`/profile/${encodeURIComponent(userId)}`),
  updateProfile: (input: { displayName?: string; avatar?: string }) =>
    request<ProfileView>('/profile/me', { method: 'PATCH', body: input }),
  history: () => request<{ games: GameHistoryEntry[] }>('/profile/me/history'),
  leaderboard: (category: LeaderboardCategory) =>
    request<LeaderboardResponse>(`/leaderboard?category=${category}&limit=50`),
  replay: (gameId: string) =>
    request<{ initial: GameState; events: GameEvent[]; status: string }>(`/games/${encodeURIComponent(gameId)}/replay`),
};
