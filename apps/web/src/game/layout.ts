import type { GameState, PlayerColor } from '@ludo/shared-types';
import {
  type ArmCount,
  type BoardCoord,
  armOutward,
  armRight,
  coordToWorld,
  createBoard,
  progressToCoord,
  yardDirection,
} from '@ludo/game-engine';

/** Height of the top surface of a tile; tokens stand on it. */
export const TILE_TOP = 0.16;
export const BASE_TOP = 0.2;

export const PLAYER_HEX: Record<PlayerColor, string> = {
  red: '#ff4d5e',
  green: '#2ee59d',
  yellow: '#ffd23f',
  blue: '#3d8bff',
  purple: '#a66bff',
  orange: '#ff8a3d',
  cyan: '#2fe0e8',
  pink: '#ff5fc8',
};

export interface Placement {
  x: number;
  y: number;
  z: number;
  scale: number;
}

export const tokenKey = (playerId: string, index: number) => `${playerId}#${index}`;

function coordKey(c: BoardCoord): string {
  switch (c.kind) {
    case 'track':
      return `t${c.index}`;
    case 'lane':
      return `l${c.arm}:${c.depth}`;
    case 'home':
      return `h${c.arm}`;
    case 'base':
      return `b${c.arm}:${c.slot}`;
  }
}

/** Centre of the square a progress value maps to (no stacking offsets). */
export function progressPoint(armCount: number, arm: number, progress: number, tokenIndex = 0): Placement {
  const board = createBoard(armCount as ArmCount);
  const coord = progressToCoord(board, arm, progress, tokenIndex);
  const w = coordToWorld(board, coord);
  return { x: w.x, y: coord.kind === 'base' ? BASE_TOP : TILE_TOP, z: w.z, scale: 1 };
}

/**
 * Resting placement of every token, spreading tokens that share a square into a
 * small cluster so each stays visible and clickable.
 */
export function computePlacements(state: Pick<GameState, 'armCount' | 'players'>): Map<string, Placement> {
  const board = createBoard(state.armCount as ArmCount);
  const groups = new Map<string, Array<{ key: string; coord: BoardCoord }>>();
  for (const p of state.players) {
    p.tokens.forEach((progress, index) => {
      const coord = progressToCoord(board, p.arm, progress, index);
      const k = coordKey(coord);
      const list = groups.get(k) ?? [];
      list.push({ key: tokenKey(p.id, index), coord });
      groups.set(k, list);
    });
  }

  const out = new Map<string, Placement>();
  for (const members of groups.values()) {
    const coord = members[0]!.coord;
    const center = coordToWorld(board, coord);
    const y = coord.kind === 'base' ? BASE_TOP : TILE_TOP;
    if (members.length === 1 && coord.kind !== 'home') {
      out.set(members[0]!.key, { x: center.x, y, z: center.z, scale: 1 });
      continue;
    }
    if (coord.kind === 'home') {
      // Finished tokens line up inside their home triangle, facing outward.
      const o = armOutward(board, coord.arm);
      const r = armRight(board, coord.arm);
      members.forEach((m, i) => {
        const lateral = (i - (members.length - 1) / 2) * 0.32;
        const radial = (i % 2) * 0.18 - 0.05;
        out.set(m.key, {
          x: center.x + r.x * lateral + o.x * radial,
          y: 0.32,
          z: center.z + r.z * lateral + o.z * radial,
          scale: 0.62,
        });
      });
      continue;
    }
    const n = members.length;
    const radius = n === 2 ? 0.2 : 0.25;
    const scale = n === 2 ? 0.8 : n <= 4 ? 0.68 : 0.58;
    members.forEach((m, i) => {
      const a = (i / n) * Math.PI * 2 + Math.PI / 4;
      out.set(m.key, { x: center.x + Math.cos(a) * radius, y, z: center.z + Math.sin(a) * radius, scale });
    });
  }
  return out;
}

/**
 * Board rotation (around Y) that brings `arm`'s yard to the bottom-left of the
 * screen, so every player sees their own base nearest to them.
 */
export function boardRotationFor(armCount: number, arm: number | null): number {
  if (arm === null) return 0;
  const board = createBoard(armCount as ArmCount);
  const d = yardDirection(board, arm);
  const current = Math.atan2(d.x, d.z);
  const target = Math.atan2(-1, 1);
  return target - current;
}
