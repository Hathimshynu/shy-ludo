import { io, type Socket } from 'socket.io-client';
import {
  type AckResult,
  type ClientToServerEvents,
  type ServerToClientEvents,
  appError,
} from '@ludo/shared-types';
import { getFreshToken, refreshSession } from './api';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';
type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Payload<E extends keyof ClientToServerEvents> = Parameters<ClientToServerEvents[E]>[0];
type AckData<E extends keyof ClientToServerEvents> =
  Parameters<ClientToServerEvents[E]>[1] extends (r: AckResult<infer T>) => void ? T : object;

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || undefined;
const ACK_TIMEOUT_MS = 8000;

/**
 * Single Socket.IO connection for the whole app. Reconnects automatically, always
 * authenticating with a fresh access token, and keeps a server-clock offset.
 */
class SocketClient {
  private socket: ClientSocket | null = null;
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private _status: ConnectionStatus = 'idle';
  private pingTimer: number | null = null;
  /** Listeners survive socket re-creation (logout → login). */
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  /** serverTime ≈ Date.now() + offset */
  offset = 0;

  get status(): ConnectionStatus {
    return this._status;
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  onStatus(fn: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this._status);
    return () => this.statusListeners.delete(fn);
  }

  serverNow(): number {
    return Date.now() + this.offset;
  }

  connect(): void {
    if (this.socket) {
      if (!this.socket.connected) this.socket.connect();
      return;
    }
    this.setStatus('connecting');
    const socket: ClientSocket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 10_000,
      auth: (cb) => {
        void getFreshToken().then((token) => cb({ token }));
      },
    });
    this.socket = socket;
    for (const [event, set] of this.handlers) for (const h of set) socket.on(event as never, h as never);

    socket.on('connect', () => {
      this.setStatus('connected');
      void this.syncClock();
      this.pingTimer ??= window.setInterval(() => void this.syncClock(), 30_000);
    });
    socket.on('disconnect', (reason) => {
      // "io client disconnect" is a deliberate logout; everything else retries.
      this.setStatus(reason === 'io client disconnect' ? 'idle' : 'reconnecting');
    });
    socket.io.on('reconnect_attempt', () => this.setStatus('reconnecting'));
    socket.io.on('reconnect_failed', () => this.setStatus('offline'));
    socket.on('connect_error', async (err) => {
      if (err.message === 'UNAUTHORIZED') {
        const session = await refreshSession().catch(() => null);
        if (!session) {
          this.disconnect();
          return;
        }
      }
      this.setStatus(navigator.onLine ? 'reconnecting' : 'offline');
      // Manual retry after auth errors (the built-in manager stops on middleware errors).
      window.setTimeout(() => {
        if (this.socket && !this.socket.connected) this.socket.connect();
      }, 1500);
    });
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
  }

  disconnect(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket?.removeAllListeners();
    this.socket?.io.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    this.setStatus('idle');
  }

  on<E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]): () => void {
    const h = handler as unknown as (...args: unknown[]) => void;
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(h);
    this.socket?.on(event as never, h as never);
    return () => {
      set.delete(h);
      this.socket?.off(event as never, h as never);
    };
  }

  emit<E extends keyof ClientToServerEvents>(event: E, payload: Payload<E>): Promise<AckResult<AckData<E>>> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve({ ok: false, error: appError('INTERNAL', 'Connection lost. Reconnecting...') });
        return;
      }
      (this.socket.timeout(ACK_TIMEOUT_MS).emit as (e: string, p: unknown, cb: (err: unknown, r: unknown) => void) => void)(
        event,
        payload,
        (err, result) => {
          if (err) resolve({ ok: false, error: appError('INTERNAL', 'The server did not respond. Please try again.') });
          else resolve(result as AckResult<AckData<E>>);
        },
      );
    });
  }

  private async syncClock(): Promise<void> {
    const sent = Date.now();
    const r = await this.emit('time:ping', { clientTime: sent });
    if (r.ok) {
      const received = Date.now();
      this.offset = r.serverTime - (sent + received) / 2;
    }
  }

  private setStatus(s: ConnectionStatus): void {
    this._status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private handleOnline = () => {
    if (!this.socket) return;
    if (this.socket.connected) {
      // Brief network blip: the transport survived, so we are connected again.
      this.setStatus('connected');
      // Re-sync the server clock (missed events are caught by the director's seq-gap check).
      void this.syncClock();
    } else {
      this.socket.connect();
    }
  };

  private handleOffline = () => this.setStatus('offline');
}

export const socketClient = new SocketClient();
