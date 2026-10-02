import { create } from 'zustand';
import type { GameSnapshotMessage, MatchmakingStatus, RoomView } from '@ludo/shared-types';
import { socketClient } from '../services/socket';

interface LobbyState {
  room: RoomView | null;
  matchmaking: MatchmakingStatus;
  /** Live game the server restored for us (refresh / reconnect). */
  restoredGame: GameSnapshotMessage | null;
  kickedFrom: string | null;
  setRoom: (room: RoomView | null) => void;
  clearRestored: () => void;
}

const IDLE: MatchmakingStatus = { state: 'idle', playerCount: null, waiting: 0, since: null };

export const useLobby = create<LobbyState>((set) => ({
  room: null,
  matchmaking: IDLE,
  restoredGame: null,
  kickedFrom: null,
  setRoom: (room) => set({ room }),
  clearRestored: () => set({ restoredGame: null }),
}));

let wired = false;
/** Subscribe the lobby store to server pushes once. */
export function wireLobby(): void {
  if (wired) return;
  wired = true;
  socketClient.on('room:update', (room) => useLobby.setState({ room }));
  socketClient.on('room:kicked', ({ roomId }) => {
    if (useLobby.getState().room?.id === roomId) useLobby.setState({ room: null, kickedFrom: roomId });
  });
  socketClient.on('room:closed', ({ roomId }) => {
    if (useLobby.getState().room?.id === roomId) useLobby.setState({ room: null });
  });
  socketClient.on('matchmaking:status', (matchmaking) => useLobby.setState({ matchmaking }));
  socketClient.on('session:restore', ({ room, game }) => {
    useLobby.setState({
      room,
      restoredGame: game && game.state.status === 'playing' ? game : null,
    });
  });
  socketClient.on('game:start', (snap) => {
    useLobby.setState({ restoredGame: snap, matchmaking: IDLE });
  });
}
