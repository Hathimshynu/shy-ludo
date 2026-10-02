import type { AppError } from './errors';
import type { GameEvent } from './events';
import type { AiDifficulty, GameState } from './game';
import type { RoomSettings, RoomView } from './room';

/** Acknowledgement envelope for every client → server event. */
export type AckResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: AppError };
export type Ack<T extends object = object> = (result: AckResult<T>) => void;

export interface GameActionBase {
  gameId: string;
  /** Client-generated UUID. Replays are rejected. */
  actionId: string;
  /** `seq` of the state the client acted on. Mismatch → STALE_STATE. */
  expectedSeq: number;
}

export interface MatchmakingStatus {
  state: 'idle' | 'searching' | 'matched';
  playerCount: number | null;
  /** Players currently waiting in this queue (including you). */
  waiting: number;
  since: number | null;
}

export interface GameSnapshotMessage {
  gameId: string;
  roomId: string;
  state: GameState;
  /** Connection flags by player id (bots are always true). */
  connected: Record<string, boolean>;
  paused: boolean;
  serverTime: number;
}

export interface GameEventsMessage {
  gameId: string;
  events: GameEvent[];
  serverTime: number;
}

export interface ClientToServerEvents {
  'room:create': (payload: { settings: RoomSettings }, ack: Ack<{ room: RoomView }>) => void;
  'room:join': (payload: { code: string }, ack: Ack<{ room: RoomView }>) => void;
  'room:leave': (payload: Record<string, never>, ack: Ack) => void;
  'room:kick': (payload: { userId: string }, ack: Ack) => void;
  'room:settings': (payload: { settings: RoomSettings }, ack: Ack<{ room: RoomView }>) => void;
  'room:addBot': (payload: { difficulty: AiDifficulty }, ack: Ack<{ room: RoomView }>) => void;
  'room:removeBot': (payload: { botId: string }, ack: Ack<{ room: RoomView }>) => void;
  'player:ready': (payload: { ready: boolean }, ack: Ack<{ room: RoomView }>) => void;
  'game:start': (payload: Record<string, never>, ack: Ack<{ gameId: string }>) => void;
  'matchmaking:join': (payload: { playerCount: number }, ack: Ack<{ status: MatchmakingStatus }>) => void;
  'matchmaking:leave': (payload: Record<string, never>, ack: Ack) => void;
  'dice:roll': (payload: GameActionBase, ack: Ack<{ seq: number }>) => void;
  'token:move': (payload: GameActionBase & { tokenIndex: number }, ack: Ack<{ seq: number }>) => void;
  'game:sync': (payload: { gameId: string }, ack: Ack<{ snapshot: GameSnapshotMessage }>) => void;
  'game:leave': (payload: { gameId: string }, ack: Ack) => void;
  'game:emote': (payload: { gameId: string; emote: string }, ack: Ack) => void;
  'time:ping': (payload: { clientTime: number }, ack: Ack<{ clientTime: number; serverTime: number }>) => void;
}

export interface ServerToClientEvents {
  'room:update': (room: RoomView) => void;
  'room:kicked': (payload: { roomId: string }) => void;
  'room:closed': (payload: { roomId: string; reason: string }) => void;
  'matchmaking:status': (status: MatchmakingStatus) => void;
  'game:start': (snapshot: GameSnapshotMessage) => void;
  'game:state': (snapshot: GameSnapshotMessage) => void;
  'game:events': (message: GameEventsMessage) => void;
  'game:finish': (payload: { gameId: string; rankings: string[] }) => void;
  'game:pause': (payload: { gameId: string; reason: string }) => void;
  'game:resume': (payload: { gameId: string; deadline: number | null }) => void;
  'game:emote': (payload: { gameId: string; playerId: string; emote: string }) => void;
  'player:disconnect': (payload: { gameId: string; playerId: string; graceSeconds: number }) => void;
  'player:reconnect': (payload: { gameId: string; playerId: string }) => void;
  'session:restore': (payload: { room: RoomView | null; game: GameSnapshotMessage | null }) => void;
  'server:error': (error: AppError) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  isGuest: boolean;
}
