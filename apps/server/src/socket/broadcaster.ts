import type { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@ludo/shared-types';

export type LudoServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type ServerEventName = keyof ServerToClientEvents;
export type ServerEventArgs<E extends ServerEventName> = Parameters<ServerToClientEvents[E]>;

export const channels = {
  room: (id: string) => `room:${id}`,
  game: (id: string) => `game:${id}`,
  user: (id: string) => `user:${id}`,
};

/** Thin, typed wrapper around Socket.IO rooms so domain code never touches sockets. */
export interface Broadcaster {
  emit<E extends ServerEventName>(channel: string, event: E, ...args: ServerEventArgs<E>): void;
  join(userId: string, channel: string): void;
  leave(userId: string, channel: string): void;
}

export function ioBroadcaster(io: LudoServer): Broadcaster {
  return {
    emit(channel, event, ...args) {
      io.to(channel).emit(event, ...args);
    },
    join(userId, channel) {
      io.in(channels.user(userId)).socketsJoin(channel);
    },
    leave(userId, channel) {
      io.in(channels.user(userId)).socketsLeave(channel);
    },
  };
}

/** Tracks how many sockets each user has open on this instance. */
export class Presence {
  private readonly sockets = new Map<string, Set<string>>();

  /** Returns true when this is the user's first socket. */
  add(userId: string, socketId: string): boolean {
    let set = this.sockets.get(userId);
    const first = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(socketId);
    return first;
  }

  /** Returns true when the user has no sockets left. */
  remove(userId: string, socketId: string): boolean {
    const set = this.sockets.get(userId);
    if (!set) return true;
    set.delete(socketId);
    if (set.size === 0) {
      this.sockets.delete(userId);
      return true;
    }
    return false;
  }

  isOnline(userId: string): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }

  count(): number {
    return this.sockets.size;
  }
}
