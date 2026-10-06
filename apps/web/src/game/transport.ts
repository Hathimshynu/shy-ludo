import type { AckResult, GameEvent, GameSnapshotMessage } from '@ludo/shared-types';

export interface TransportHandlers {
  onSnapshot: (snap: Pick<GameSnapshotMessage, 'state' | 'connected' | 'paused'>) => void;
  onEvents: (events: GameEvent[]) => void;
  onFinish: (rankings: string[]) => void;
  onPresence: (playerId: string, connected: boolean) => void;
  onPause: (paused: boolean, deadline?: number | null) => void;
  onEmote: (playerId: string, emote: string) => void;
  /** The game no longer exists or we are not part of it. */
  onGone: () => void;
}

/**
 * The GameDirector talks to the authority through this interface: Socket.IO for
 * online games, a Web Worker for solo games. Both deliver the same event format.
 */
export interface GameTransport {
  readonly mode: 'online' | 'solo' | 'replay';
  subscribe(handlers: TransportHandlers): () => void;
  requestSnapshot(): void;
  roll(expectedSeq: number): Promise<AckResult<{ seq?: number }>>;
  move(tokenIndex: number, expectedSeq: number): Promise<AckResult<{ seq?: number }>>;
  leave(): Promise<void>;
  emote(emote: string): Promise<AckResult>;
  /** Board animations caught up with `seq` (used to pace bots in solo games). */
  notifyIdle(seq: number): void;
  /** Server clock (ms). */
  now(): number;
}
