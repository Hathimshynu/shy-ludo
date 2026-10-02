import type { AckResult } from '@ludo/shared-types';
import { socketClient } from '../services/socket';
import type { GameTransport, TransportHandlers } from './transport';

const uuid = (): string =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16),
      );

export class SocketTransport implements GameTransport {
  readonly mode = 'online' as const;
  private handlers: TransportHandlers | null = null;

  constructor(readonly gameId: string) {}

  subscribe(handlers: TransportHandlers): () => void {
    this.handlers = handlers;
    const mine = (id: string) => id === this.gameId;
    const offs = [
      socketClient.on('game:start', (snap) => mine(snap.gameId) && handlers.onSnapshot(snap)),
      socketClient.on('game:state', (snap) => mine(snap.gameId) && handlers.onSnapshot(snap)),
      socketClient.on('session:restore', ({ game }) => {
        // After a reconnect the server re-sends the authoritative snapshot.
        if (game && mine(game.gameId)) handlers.onSnapshot(game);
        else this.requestSnapshot();
      }),
      socketClient.on('game:events', (m) => mine(m.gameId) && handlers.onEvents(m.events)),
      socketClient.on('game:finish', (m) => mine(m.gameId) && handlers.onFinish(m.rankings)),
      socketClient.on('player:disconnect', (m) => mine(m.gameId) && handlers.onPresence(m.playerId, false)),
      socketClient.on('player:reconnect', (m) => mine(m.gameId) && handlers.onPresence(m.playerId, true)),
      socketClient.on('game:pause', (m) => mine(m.gameId) && handlers.onPause(true)),
      socketClient.on('game:resume', (m) => mine(m.gameId) && handlers.onPause(false, m.deadline)),
      socketClient.on('game:emote', (m) => mine(m.gameId) && handlers.onEmote(m.playerId, m.emote)),
    ];
    return () => {
      offs.forEach((off) => off());
      this.handlers = null;
    };
  }

  requestSnapshot(): void {
    void socketClient.emit('game:sync', { gameId: this.gameId }).then((r) => {
      if (r.ok) this.handlers?.onSnapshot(r.snapshot);
      else if (r.error.code === 'GAME_NOT_FOUND' || r.error.code === 'NOT_IN_GAME') this.handlers?.onGone();
    });
  }

  roll(expectedSeq: number): Promise<AckResult<{ seq?: number }>> {
    return socketClient.emit('dice:roll', { gameId: this.gameId, actionId: uuid(), expectedSeq });
  }

  move(tokenIndex: number, expectedSeq: number): Promise<AckResult<{ seq?: number }>> {
    return socketClient.emit('token:move', { gameId: this.gameId, actionId: uuid(), expectedSeq, tokenIndex });
  }

  async leave(): Promise<void> {
    await socketClient.emit('game:leave', { gameId: this.gameId });
  }

  emote(emote: string): Promise<AckResult> {
    return socketClient.emit('game:emote', { gameId: this.gameId, emote });
  }

  notifyIdle(): void {
    /* server paces bots itself */
  }

  now(): number {
    return socketClient.serverNow();
  }
}
