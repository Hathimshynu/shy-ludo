import { type Prisma, type PrismaClient } from '@prisma/client';
import type { GameEvent, GameState, RoomSettings } from '@ludo/shared-types';

export interface StoredRoomInfo {
  id: string;
  code: string;
  kind: 'private' | 'matchmaking';
  hostId: string | null;
  settings: RoomSettings;
}

export interface RecoverableGame {
  state: GameState;
  room: StoredRoomInfo | null;
}

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class GameRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async saveRoom(room: StoredRoomInfo, status: 'LOBBY' | 'PLAYING' | 'FINISHED' | 'CLOSED'): Promise<void> {
    await this.prisma.room.upsert({
      where: { id: room.id },
      create: {
        id: room.id,
        code: room.code,
        kind: room.kind === 'private' ? 'PRIVATE' : 'MATCHMAKING',
        hostId: room.hostId,
        settings: json(room.settings),
        status,
      },
      update: { status, hostId: room.hostId, settings: json(room.settings) },
    });
  }

  async createGame(state: GameState, roomId: string | null): Promise<void> {
    await this.prisma.game.create({
      data: {
        id: state.id,
        roomId,
        playerCount: state.players.length,
        armCount: state.armCount,
        rules: json(state.rules),
        initialSnapshot: json(state),
        snapshot: json(state),
        lastSeq: state.seq,
        players: {
          create: state.players.map((p) => ({
            playerId: p.id,
            userId: p.kind === 'human' ? p.id : null,
            seat: p.seat,
            color: p.color,
            displayName: p.name,
            isBot: p.kind === 'bot',
            botLevel: p.botLevel,
          })),
        },
      },
    });
  }

  /** Append events and update the snapshot atomically. */
  async appendEvents(state: GameState, events: readonly GameEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.prisma.$transaction([
      this.prisma.gameEvent.createMany({
        data: events.map((e) => ({
          gameId: e.gameId,
          sequenceNumber: e.seq,
          playerId: e.playerId,
          eventType: e.type,
          payload: json(e.payload),
          timestamp: new Date(e.at),
        })),
      }),
      this.prisma.game.update({
        where: { id: state.id },
        data: {
          snapshot: json(state),
          lastSeq: state.seq,
          ...(state.status === 'finished' ? { status: 'FINISHED', finishedAt: new Date(state.updatedAt) } : {}),
        },
      }),
    ]);
  }

  /** Snapshot-only update (e.g. a deadline reset after a pause). */
  async saveSnapshot(state: GameState): Promise<void> {
    await this.prisma.game.update({ where: { id: state.id }, data: { snapshot: json(state) } });
  }

  async markAbandoned(gameId: string, state: GameState): Promise<void> {
    await this.prisma.game.update({
      where: { id: gameId },
      data: { status: 'ABANDONED', finishedAt: new Date(), snapshot: json(state) },
    });
  }

  async loadActiveGames(): Promise<RecoverableGame[]> {
    const games = await this.prisma.game.findMany({ where: { status: 'ACTIVE' }, include: { room: true } });
    return games.map((g) => ({
      state: g.snapshot as unknown as GameState,
      room: g.room
        ? {
            id: g.room.id,
            code: g.room.code,
            kind: g.room.kind === 'PRIVATE' ? 'private' : 'matchmaking',
            hostId: g.room.hostId,
            settings: g.room.settings as unknown as RoomSettings,
          }
        : null,
    }));
  }

  async loadReplay(gameId: string): Promise<{ initial: GameState; status: string; events: GameEvent[] } | null> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { initialSnapshot: true, status: true, players: { select: { userId: true } } },
    });
    if (!game) return null;
    return {
      initial: game.initialSnapshot as unknown as GameState,
      status: game.status,
      events: await this.loadEvents(gameId),
    };
  }

  async isParticipant(gameId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.gamePlayer.findFirst({ where: { gameId, userId }, select: { id: true } });
    return row !== null;
  }

  async loadEvents(gameId: string): Promise<GameEvent[]> {
    const rows = await this.prisma.gameEvent.findMany({
      where: { gameId },
      orderBy: { sequenceNumber: 'asc' },
    });
    return rows.map(
      (r) =>
        ({
          gameId: r.gameId,
          seq: r.sequenceNumber,
          type: r.eventType,
          playerId: r.playerId,
          at: r.timestamp.getTime(),
          payload: r.payload,
        }) as unknown as GameEvent,
    );
  }

  async recordQueueEntry(userId: string, playerCount: number): Promise<string> {
    const row = await this.prisma.matchmakingQueue.create({ data: { userId, playerCount } });
    return row.id;
  }

  async resolveQueueEntry(id: string, outcome: 'matched' | 'left', roomId: string | null): Promise<void> {
    await this.prisma.matchmakingQueue.update({
      where: { id },
      data: { resolvedAt: new Date(), outcome, roomId },
    });
  }
}
