import { randomInt, randomUUID } from 'node:crypto';
import { LIMITS } from '@ludo/config';
import {
  type AiDifficulty,
  type GameState,
  type RoomKind,
  type RoomSeat,
  type RoomSettings,
  type RoomStatus,
  type RoomView,
  appError,
} from '@ludo/shared-types';
import { GameError } from '../errors';
import type { Logger } from '../logger';
import { type Broadcaster, channels } from '../socket/broadcaster';
import type { CodeRegistry } from '../services/coordination';
import type { GameRepository, StoredRoomInfo } from '../services/gameRepository';

export interface SocketUser {
  id: string;
  name: string;
  avatar: string;
}

export interface Room {
  id: string;
  code: string;
  kind: RoomKind;
  hostId: string;
  status: RoomStatus;
  settings: RoomSettings;
  seats: RoomSeat[];
  gameId: string | null;
  createdAt: number;
}

export interface RoomManagerDeps {
  broadcaster: Broadcaster;
  repo: GameRepository;
  codes: CodeRegistry;
  logger: Logger;
  lobbyDisconnectSeconds: number;
  isOnline: (userId: string) => boolean;
  /** Start a game for the room; returns the new game id. */
  startGame: (room: Room) => Promise<string>;
  /** Forfeit the user's running game (used when leaving a room mid-game). */
  leaveGame: (userId: string) => void;
}

const BOT_NAMES = ['Astra', 'Bolt', 'Cosmo', 'Dash', 'Echo', 'Flux', 'Gizmo', 'Halo', 'Ion', 'Juno', 'Kite', 'Lumen'];
const BOT_AVATARS = ['rocket', 'saturn', 'pulsar', 'quasar', 'meteor', 'orbit'];

const fail = (code: Parameters<typeof appError>[0], message?: string): never => {
  throw new GameError(appError(code, message));
};

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly byCode = new Map<string, string>();
  private readonly userRoom = new Map<string, string>();
  private readonly lobbyTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: RoomManagerDeps) {}

  // ---- Queries ---------------------------------------------------------------

  view(room: Room): RoomView {
    return {
      id: room.id,
      code: room.code,
      kind: room.kind,
      hostId: room.hostId,
      status: room.status,
      settings: room.settings,
      seats: room.seats.map((s) => ({
        ...s,
        isHost: s.id === room.hostId,
        connected: s.kind === 'bot' ? true : this.deps.isOnline(s.id),
      })),
      gameId: room.gameId,
      createdAt: room.createdAt,
    };
  }

  roomOf(userId: string): Room | undefined {
    const id = this.userRoom.get(userId);
    return id ? this.rooms.get(id) : undefined;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  count(): number {
    return this.rooms.size;
  }

  // ---- Commands ----------------------------------------------------------------

  async create(user: SocketUser, settings: RoomSettings, kind: RoomKind = 'private'): Promise<Room> {
    this.ensureFree(user.id);
    const room: Room = {
      id: `room_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      code: await this.allocateCode(),
      kind,
      hostId: user.id,
      status: 'lobby',
      settings,
      seats: [],
      gameId: null,
      createdAt: Date.now(),
    };
    this.rooms.set(room.id, room);
    this.byCode.set(room.code, room.id);
    this.seatHuman(room, user, kind === 'matchmaking');
    await this.deps.repo.saveRoom(this.stored(room), 'LOBBY');
    this.deps.logger.info({ roomId: room.id, kind, hostId: user.id }, 'Room created');
    this.publish(room);
    return room;
  }

  async join(user: SocketUser, code: string): Promise<Room> {
    const room = this.rooms.get(this.byCode.get(code) ?? '');
    if (!room || room.status === 'finished') return fail('ROOM_NOT_FOUND');
    if (room.seats.some((s) => s.id === user.id)) {
      // Already seated (e.g. second tab) — idempotent.
      this.deps.broadcaster.join(user.id, channels.room(room.id));
      return room;
    }
    if (room.kind !== 'private') return fail('ROOM_NOT_FOUND');
    if (room.status !== 'lobby') return fail('ROOM_IN_GAME');
    if (room.seats.length >= room.settings.maxPlayers) return fail('ROOM_FULL');
    this.ensureFree(user.id);
    this.seatHuman(room, user, false);
    this.deps.logger.info({ roomId: room.id, userId: user.id }, 'Player joined room');
    this.publish(room);
    return room;
  }

  leave(userId: string): void {
    const room = this.roomOf(userId);
    if (!room) return;
    if (room.status === 'playing') this.deps.leaveGame(userId);
    this.removeHuman(room, userId);
  }

  kick(hostId: string, targetId: string): Room {
    const room = this.hostRoom(hostId);
    if (targetId === hostId) return fail('BAD_REQUEST', 'You cannot remove yourself.');
    if (!room.seats.some((s) => s.id === targetId && s.kind === 'human')) return fail('NOT_IN_ROOM', 'That player is not in the room.');
    this.removeHuman(room, targetId);
    this.deps.broadcaster.emit(channels.user(targetId), 'room:kicked', { roomId: room.id });
    return room;
  }

  updateSettings(hostId: string, settings: RoomSettings): Room {
    const room = this.hostRoom(hostId);
    if (settings.maxPlayers < room.seats.length) {
      return fail('BAD_REQUEST', `There are already ${room.seats.length} players in the room.`);
    }
    room.settings = settings;
    for (const seat of room.seats) if (seat.id !== room.hostId) seat.ready = false;
    void this.deps.repo.saveRoom(this.stored(room), 'LOBBY').catch(() => undefined);
    this.publish(room);
    return room;
  }

  addBot(hostId: string, difficulty: AiDifficulty): Room {
    const room = this.hostRoom(hostId);
    if (room.seats.length >= room.settings.maxPlayers) return fail('ROOM_FULL');
    const used = new Set(room.seats.map((s) => s.name));
    const base = BOT_NAMES.find((n) => !used.has(`${n} (AI)`)) ?? `Bot ${room.seats.length + 1}`;
    room.seats.push({
      id: `bot_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      kind: 'bot',
      name: `${base} (AI)`,
      avatar: BOT_AVATARS[randomInt(BOT_AVATARS.length)]!,
      botLevel: difficulty,
      ready: true,
      connected: true,
      isHost: false,
    });
    this.publish(room);
    return room;
  }

  removeBot(hostId: string, botId: string): Room {
    const room = this.hostRoom(hostId);
    const index = room.seats.findIndex((s) => s.id === botId && s.kind === 'bot');
    if (index < 0) return fail('NOT_FOUND', 'That bot is not in the room.');
    room.seats.splice(index, 1);
    this.publish(room);
    return room;
  }

  setReady(userId: string, ready: boolean): Room {
    const room = this.roomOf(userId);
    if (!room) return fail('NOT_IN_ROOM');
    if (room.status !== 'lobby') return fail('ROOM_IN_GAME');
    const seat = room.seats.find((s) => s.id === userId)!;
    seat.ready = ready;
    this.publish(room);
    return room;
  }

  async start(hostId: string): Promise<string> {
    const room = this.hostRoom(hostId);
    if (room.seats.length < 2) return fail('NOT_ENOUGH_PLAYERS');
    if (room.seats.some((s) => s.kind === 'human' && s.id !== room.hostId && !s.ready)) return fail('NOT_READY');
    return this.launch(room);
  }

  /** Create a matchmaking room for already-matched users and start it immediately. */
  async createMatchRoom(users: SocketUser[], settings: RoomSettings): Promise<{ room: Room; gameId: string }> {
    for (const u of users) {
      const existing = this.roomOf(u.id);
      if (existing && existing.status === 'lobby') this.removeHuman(existing, u.id);
    }
    const [host, ...rest] = users;
    const room = await this.create(host!, settings, 'matchmaking');
    for (const u of rest) this.seatHuman(room, u, true);
    const gameId = await this.launch(room);
    return { room, gameId };
  }

  /** Called by the session manager when a game ends. */
  onGameEnded(roomId: string, state: GameState): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.gameId = state.id;
    if (room.kind === 'private') {
      // Back to the lobby so friends can rematch. Drop seats of players who left mid-game.
      room.status = 'lobby';
      room.seats = room.seats.filter((s) => s.kind === 'bot' || this.userRoom.get(s.id) === room.id);
      const humans = room.seats.filter((s) => s.kind === 'human');
      if (humans.length === 0) {
        this.close(room, 'Everyone left');
        return;
      }
      if (!humans.some((h) => h.id === room.hostId)) room.hostId = humans[0]!.id;
      for (const seat of room.seats) seat.ready = seat.kind === 'bot' || seat.id === room.hostId;
      void this.deps.repo.saveRoom(this.stored(room), 'LOBBY').catch(() => undefined);
      this.publish(room);
      for (const h of humans) if (!this.deps.isOnline(h.id)) this.userDisconnected(h.id);
    } else {
      room.status = 'finished';
      void this.deps.repo.saveRoom(this.stored(room), 'FINISHED').catch(() => undefined);
      this.publish(room);
      for (const seat of room.seats) if (seat.kind === 'human') this.detach(room, seat.id);
      this.close(room, 'Game finished');
    }
  }

  /** Re-create a room in memory for a game recovered after a restart. */
  restore(stored: StoredRoomInfo, state: GameState): Room {
    const room: Room = {
      id: stored.id,
      code: stored.code,
      kind: stored.kind,
      hostId: stored.hostId ?? state.players.find((p) => p.kind === 'human')!.id,
      status: 'playing',
      settings: stored.settings,
      seats: state.players.map((p) => ({
        id: p.id,
        kind: p.kind,
        name: p.name,
        avatar: p.avatar,
        botLevel: p.botLevel,
        ready: true,
        connected: false,
        isHost: false,
      })),
      gameId: state.id,
      createdAt: state.createdAt,
    };
    this.rooms.set(room.id, room);
    this.byCode.set(room.code, room.id);
    void this.deps.codes.claim(room.code, room.id);
    for (const p of state.players) {
      if (p.kind === 'human' && p.status === 'active') this.userRoom.set(p.id, room.id);
    }
    return room;
  }

  // ---- Presence ----------------------------------------------------------------

  userConnected(userId: string): void {
    const timer = this.lobbyTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.lobbyTimers.delete(userId);
    const room = this.roomOf(userId);
    if (room) this.publish(room);
  }

  userDisconnected(userId: string): void {
    const room = this.roomOf(userId);
    if (!room) return;
    this.publish(room);
    if (room.status !== 'lobby') return;
    const timer = setTimeout(() => {
      this.lobbyTimers.delete(userId);
      if (!this.deps.isOnline(userId) && this.roomOf(userId)?.status === 'lobby') this.leave(userId);
    }, this.deps.lobbyDisconnectSeconds * 1000);
    timer.unref?.();
    this.lobbyTimers.set(userId, timer);
  }

  /** Remove the user from a room whose game they forfeited (room keeps running). */
  releaseFromGame(userId: string): void {
    const room = this.roomOf(userId);
    if (room && room.status === 'playing') this.detach(room, userId);
  }

  dispose(): void {
    for (const t of this.lobbyTimers.values()) clearTimeout(t);
    this.lobbyTimers.clear();
  }

  // ---- Internals ---------------------------------------------------------------

  private async launch(room: Room): Promise<string> {
    room.status = 'playing';
    try {
      const gameId = await this.deps.startGame(room);
      room.gameId = gameId;
      void this.deps.repo.saveRoom(this.stored(room), 'PLAYING').catch(() => undefined);
      this.publish(room);
      return gameId;
    } catch (err) {
      room.status = 'lobby';
      this.publish(room);
      throw err;
    }
  }

  private ensureFree(userId: string): void {
    const current = this.roomOf(userId);
    if (!current) return;
    if (current.status === 'playing') fail('ALREADY_IN_GAME');
    // Leaving a lobby to create/join another one is allowed.
    this.removeHuman(current, userId);
  }

  private seatHuman(room: Room, user: SocketUser, ready: boolean): void {
    room.seats.push({
      id: user.id,
      kind: 'human',
      name: user.name,
      avatar: user.avatar,
      botLevel: null,
      ready: ready || user.id === room.hostId,
      connected: true,
      isHost: user.id === room.hostId,
    });
    this.userRoom.set(user.id, room.id);
    this.deps.broadcaster.join(user.id, channels.room(room.id));
  }

  private removeHuman(room: Room, userId: string): void {
    const index = room.seats.findIndex((s) => s.id === userId);
    if (index >= 0 && room.status !== 'playing') room.seats.splice(index, 1);
    this.detach(room, userId);
    const humans = room.seats.filter((s) => s.kind === 'human' && this.userRoom.get(s.id) === room.id);
    if (humans.length === 0) {
      if (room.status !== 'playing') this.close(room, 'Everyone left');
      return;
    }
    if (room.hostId === userId) {
      room.hostId = humans[0]!.id;
      humans[0]!.ready = true;
    }
    this.publish(room);
  }

  private detach(room: Room, userId: string): void {
    if (this.userRoom.get(userId) === room.id) this.userRoom.delete(userId);
    this.deps.broadcaster.leave(userId, channels.room(room.id));
  }

  private close(room: Room, reason: string): void {
    this.rooms.delete(room.id);
    this.byCode.delete(room.code);
    void this.deps.codes.release(room.code).catch(() => undefined);
    if (room.status === 'lobby') {
      void this.deps.repo.saveRoom(this.stored(room), 'CLOSED').catch(() => undefined);
    }
    this.deps.broadcaster.emit(channels.room(room.id), 'room:closed', { roomId: room.id, reason });
  }

  private hostRoom(userId: string): Room {
    const room = this.roomOf(userId);
    if (!room) return fail('NOT_IN_ROOM');
    if (room.hostId !== userId) return fail('NOT_HOST');
    if (room.status !== 'lobby') return fail('ROOM_IN_GAME');
    return room;
  }

  private publish(room: Room): void {
    this.deps.broadcaster.emit(channels.room(room.id), 'room:update', this.view(room));
  }

  private stored(room: Room): StoredRoomInfo {
    return { id: room.id, code: room.code, kind: room.kind, hostId: room.hostId, settings: room.settings };
  }

  private async allocateCode(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let code = '';
      for (let i = 0; i < LIMITS.roomCodeLength; i += 1) {
        code += LIMITS.roomCodeAlphabet[randomInt(LIMITS.roomCodeAlphabet.length)];
      }
      if (!this.byCode.has(code) && (await this.deps.codes.claim(code, 'pending'))) return code;
    }
    throw new Error('Could not allocate a unique room code');
  }
}
