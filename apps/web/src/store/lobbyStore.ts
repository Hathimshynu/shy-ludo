import { create } from 'zustand';
import type { FriendInvite, GameSnapshotMessage, MatchmakingStatus, RoomView } from '@ludo/shared-types';
import { socketClient } from '../services/socket';

interface LobbyState {
  room: RoomView | null;
  matchmaking: MatchmakingStatus;
  /** Live game the server restored for us (refresh / reconnect). */
  restoredGame: GameSnapshotMessage | null;
  kickedFrom: string | null;
  /** Latest room invite from a friend (shown until joined or dismissed). */
  invite: FriendInvite | null;
  setRoom: (room: RoomView | null) => void;
  clearRestored: () => void;
}

const IDLE: MatchmakingStatus = { state: 'idle', playerCount: null, waiting: 0, since: null };

export const useLobby = create<LobbyState>((set) => ({
  room: null,
  matchmaking: IDLE,
  restoredGame: null,
  kickedFrom: null,
  invite: null,
  setRoom: (room) => set({ room }),
  clearRestored: () => set({ restoredGame: null }),
}));

let wired = false;
/** Games this client has been started into (game:start or session restore). */
const enteredGames = new Set<string>();
/** Games for which the room-update fallback already ran (never pull a player back twice). */
const fallbackTried = new Set<string>();
const START_FALLBACK_MS = 1500;

/**
 * Safety net: the room says its game is running but this client never received game:start
 * (a lost event would otherwise leave the player stuck in the lobby). Fetch the snapshot
 * once and enter the game.
 */
function ensureEnteredGame(room: RoomView): void {
  const gameId = room.gameId;
  if (room.status !== 'playing' || !gameId || enteredGames.has(gameId) || fallbackTried.has(gameId)) return;
  fallbackTried.add(gameId);
  window.setTimeout(() => {
    if (enteredGames.has(gameId) || useLobby.getState().room?.id !== room.id) return;
    void socketClient.emit('game:sync', { gameId }).then((r) => {
      if (!r.ok || enteredGames.has(gameId) || r.snapshot.state.status !== 'playing') return;
      enteredGames.add(gameId);
      useLobby.setState({ restoredGame: r.snapshot, matchmaking: IDLE });
    });
  }, START_FALLBACK_MS);
}

/** Subscribe the lobby store to server pushes once. */
export function wireLobby(): void {
  if (wired) return;
  wired = true;
  socketClient.on('room:update', (room) => {
    useLobby.setState({ room });
    ensureEnteredGame(room);
  });
  socketClient.on('room:kicked', ({ roomId }) => {
    if (useLobby.getState().room?.id === roomId) useLobby.setState({ room: null, kickedFrom: roomId });
  });
  socketClient.on('room:closed', ({ roomId }) => {
    if (useLobby.getState().room?.id === roomId) useLobby.setState({ room: null });
  });
  socketClient.on('matchmaking:status', (matchmaking) => useLobby.setState({ matchmaking }));
  socketClient.on('friend:invite', (invite) => {
    // Already in that room (or in a game): nothing to offer.
    if (useLobby.getState().room?.code === invite.code) return;
    useLobby.setState({ invite });
  });
  socketClient.on('session:restore', ({ room, game }) => {
    if (game) enteredGames.add(game.gameId);
    useLobby.setState({
      room,
      restoredGame: game && game.state.status === 'playing' ? game : null,
    });
  });
  socketClient.on('game:start', (snap) => {
    enteredGames.add(snap.gameId);
    useLobby.setState({ restoredGame: snap, matchmaking: IDLE });
  });
}
