import type { PlayerColor } from '@ludo/shared-types';

/**
 * Board geometry.
 *
 * The board is built from N "arms" (4, 6 or 8). Each arm is a 3-wide × 6-long strip:
 *
 *   lane 0  — outgoing lane (left-hand side when facing outward from the centre)
 *   lane 1  — centre lane: depth 5 is the tip (track square), depths 4..0 are the home column
 *   lane 2  — incoming lane (right-hand side)
 *
 * depth 0 is closest to the centre, depth 5 is the outer tip.
 *
 * Track squares are numbered clockwise. Within arm `a`, the 13 track squares are:
 *   idx 0..5  → lane 0, depth 0..5   (outward)
 *   idx 6     → lane 1, depth 5      (tip)
 *   idx 7..12 → lane 2, depth 5..0   (inward)
 * and the global track index is `a * 13 + idx`. From lane 2 / depth 0 the next square is
 * lane 0 / depth 0 of arm a + 1 (the classic diagonal corner step).
 *
 * World space: x to the right, z towards the viewer ("down" on screen), unit = one cell.
 * Arm 0 points towards +z. For 4 arms this reproduces the classic 15×15 grid exactly
 * (see `coordToGrid`).
 */

export const ARM_TRACK_SQUARES = 13;
export const ARM_DEPTH = 6;
export const HOME_LANE_LENGTH = 5;
/** Index of the start square inside an arm segment (lane 2, depth 4). */
export const START_INDEX_IN_ARM = 8;
/** Index of the star (safe) square inside an arm segment (lane 0, depth 3). */
export const STAR_INDEX_IN_ARM = 3;
export const BASE_PROGRESS = -1;

export type ArmCount = 4 | 6 | 8;

export type BoardCoord =
  | { kind: 'track'; arm: number; lane: 0 | 1 | 2; depth: number; index: number }
  | { kind: 'lane'; arm: number; depth: number }
  | { kind: 'home'; arm: number }
  | { kind: 'base'; arm: number; slot: number };

export interface WorldPoint {
  x: number;
  z: number;
}

export interface BoardGeometry {
  armCount: ArmCount;
  trackLength: number;
  /** Distance from the centre to the inner edge of every arm. */
  innerRadius: number;
  /** Distance from the centre to the centre of each base yard. */
  yardRadius: number;
  /** Half-spacing between base slots. */
  yardSlotSpread: number;
  /** Apothem of the outer board polygon (edges face the arms). */
  boardApothem: number;
  /** Absolute track indices that are safe from capture. */
  safeSquares: ReadonlySet<number>;
  /** Absolute track index of each arm's start square. */
  startSquares: readonly number[];
  /** Absolute track index of each arm's star square. */
  starSquares: readonly number[];
}

const geometryCache = new Map<ArmCount, BoardGeometry>();

export function armCountForPlayers(playerCount: number): ArmCount {
  if (playerCount <= 4) return 4;
  if (playerCount <= 6) return 6;
  return 8;
}

const ARM_COLORS: Record<ArmCount, readonly PlayerColor[]> = {
  4: ['red', 'green', 'yellow', 'blue'],
  6: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
  8: ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'],
};

export function armColors(armCount: ArmCount): readonly PlayerColor[] {
  return ARM_COLORS[armCount];
}

/** Which arm each seat sits on, spreading players evenly where possible. */
export function seatArms(playerCount: number, armCount: ArmCount): number[] {
  if (playerCount < 1 || playerCount > armCount) {
    throw new Error(`Cannot seat ${playerCount} players on a ${armCount}-arm board`);
  }
  if (armCount === 4 && playerCount === 2) return [0, 2];
  const arms: number[] = [];
  for (let i = 0; i < playerCount; i += 1) arms.push(i);
  return arms;
}

export function createBoard(armCount: ArmCount): BoardGeometry {
  const cached = geometryCache.get(armCount);
  if (cached) return cached;

  const half = Math.PI / armCount;
  const innerRadius = 1.5 / Math.tan(half);
  const yardClearance = 1.7;
  const yardRadius = Math.max((innerRadius + 3) / Math.cos(half), (1.5 + yardClearance) / Math.sin(half));
  const trackLength = ARM_TRACK_SQUARES * armCount;
  const startSquares: number[] = [];
  const starSquares: number[] = [];
  for (let a = 0; a < armCount; a += 1) {
    startSquares.push(a * ARM_TRACK_SQUARES + START_INDEX_IN_ARM);
    starSquares.push(a * ARM_TRACK_SQUARES + STAR_INDEX_IN_ARM);
  }
  const geometry: BoardGeometry = {
    armCount,
    trackLength,
    innerRadius,
    yardRadius,
    yardSlotSpread: armCount === 8 ? 0.62 : 0.75,
    boardApothem: innerRadius + ARM_DEPTH + 0.45,
    safeSquares: new Set([...startSquares, ...starSquares]),
    startSquares,
    starSquares,
  };
  geometryCache.set(armCount, geometry);
  return geometry;
}

// ---------------------------------------------------------------------------
// Progress helpers (per player)
// ---------------------------------------------------------------------------

/** Last progress value on the shared track (the player's own arm tip). */
export function lastTrackProgress(board: BoardGeometry): number {
  return board.trackLength - 2;
}

/** First progress value of the private home column. */
export function homeLaneStart(board: BoardGeometry): number {
  return board.trackLength - 1;
}

/** Progress value of a finished token. */
export function finishProgress(board: BoardGeometry): number {
  return board.trackLength + HOME_LANE_LENGTH - 1;
}

export function isOnTrack(board: BoardGeometry, progress: number): boolean {
  return progress >= 0 && progress <= lastTrackProgress(board);
}

export function startSquare(board: BoardGeometry, arm: number): number {
  return arm * ARM_TRACK_SQUARES + START_INDEX_IN_ARM;
}

/** Absolute track square for a token, or null when the token is in base / home column / finished. */
export function progressToSquare(board: BoardGeometry, arm: number, progress: number): number | null {
  if (!isOnTrack(board, progress)) return null;
  return (startSquare(board, arm) + progress) % board.trackLength;
}

export function isSafeSquare(board: BoardGeometry, square: number): boolean {
  return board.safeSquares.has(square);
}

// ---------------------------------------------------------------------------
// Canonical coordinates
// ---------------------------------------------------------------------------

export function trackSquareCoord(board: BoardGeometry, square: number): BoardCoord {
  const index = ((square % board.trackLength) + board.trackLength) % board.trackLength;
  const arm = Math.floor(index / ARM_TRACK_SQUARES);
  const idx = index % ARM_TRACK_SQUARES;
  if (idx <= 5) return { kind: 'track', arm, lane: 0, depth: idx, index };
  if (idx === 6) return { kind: 'track', arm, lane: 1, depth: 5, index };
  return { kind: 'track', arm, lane: 2, depth: 12 - idx, index };
}

/** Map a player's token progress to a canonical board coordinate. */
export function progressToCoord(
  board: BoardGeometry,
  arm: number,
  progress: number,
  tokenIndex = 0,
): BoardCoord {
  if (progress < 0) return { kind: 'base', arm, slot: tokenIndex };
  const square = progressToSquare(board, arm, progress);
  if (square !== null) return trackSquareCoord(board, square);
  if (progress >= finishProgress(board)) return { kind: 'home', arm };
  const laneStep = progress - homeLaneStart(board); // 0..4
  return { kind: 'lane', arm, depth: HOME_LANE_LENGTH - 1 - laneStep };
}

/** Angle (radians) of an arm, measured so that arm 0 points to +z and arms advance clockwise. */
export function armAngle(board: BoardGeometry, arm: number): number {
  return (arm * 2 * Math.PI) / board.armCount;
}

/** Outward unit vector of an arm. */
export function armOutward(board: BoardGeometry, arm: number): WorldPoint {
  const t = armAngle(board, arm);
  return { x: -Math.sin(t), z: Math.cos(t) };
}

/** Right-hand unit vector of an arm (when facing outward). */
export function armRight(board: BoardGeometry, arm: number): WorldPoint {
  const o = armOutward(board, arm);
  return { x: -o.z, z: o.x };
}

function armCell(board: BoardGeometry, arm: number, lane: number, depth: number): WorldPoint {
  const o = armOutward(board, arm);
  const r = armRight(board, arm);
  const radial = board.innerRadius + 0.5 + depth;
  const lateral = lane - 1;
  return { x: o.x * radial + r.x * lateral, z: o.z * radial + r.z * lateral };
}

/** Unit vector from the centre towards a player's yard (between arm and arm + 1). */
export function yardDirection(board: BoardGeometry, arm: number): WorldPoint {
  const a = armOutward(board, arm);
  const b = armOutward(board, (arm + 1) % board.armCount);
  const len = Math.hypot(a.x + b.x, a.z + b.z);
  return { x: (a.x + b.x) / len, z: (a.z + b.z) / len };
}

export function yardCenter(board: BoardGeometry, arm: number): WorldPoint {
  const d = yardDirection(board, arm);
  return { x: d.x * board.yardRadius, z: d.z * board.yardRadius };
}

export function baseSlotWorld(board: BoardGeometry, arm: number, slot: number): WorldPoint {
  const c = yardCenter(board, arm);
  const d = yardDirection(board, arm);
  const p = { x: -d.z, z: d.x };
  const s = board.yardSlotSpread;
  const radial = slot < 2 ? -s : s;
  const lateral = slot % 2 === 0 ? -s : s;
  return { x: c.x + d.x * radial + p.x * lateral, z: c.z + d.z * radial + p.z * lateral };
}

/** Centre of the arm's triangle in the central home area. */
export function homeWorld(board: BoardGeometry, arm: number): WorldPoint {
  const o = armOutward(board, arm);
  const r = board.innerRadius * 0.55;
  return { x: o.x * r, z: o.z * r };
}

export function coordToWorld(board: BoardGeometry, coord: BoardCoord): WorldPoint {
  switch (coord.kind) {
    case 'track':
      return armCell(board, coord.arm, coord.lane, coord.depth);
    case 'lane':
      return armCell(board, coord.arm, 1, coord.depth);
    case 'home':
      return homeWorld(board, coord.arm);
    case 'base':
      return baseSlotWorld(board, coord.arm, coord.slot);
  }
}

export function progressToWorld(
  board: BoardGeometry,
  arm: number,
  progress: number,
  tokenIndex = 0,
): WorldPoint {
  return coordToWorld(board, progressToCoord(board, arm, progress, tokenIndex));
}

/**
 * Classic (row, column) on the 15×15 grid. Only defined for 4-arm boards and for
 * track / lane coordinates.
 */
export function coordToGrid(board: BoardGeometry, coord: BoardCoord): { row: number; col: number } {
  if (board.armCount !== 4) throw new Error('Grid coordinates exist only for the 4-arm board');
  if (coord.kind === 'base' || coord.kind === 'home') {
    throw new Error('Grid coordinates are defined for track and lane squares only');
  }
  const w = coordToWorld(board, coord);
  return { row: Math.round(w.z + 7), col: Math.round(w.x + 7) };
}

/** Every cell of the board, for renderers. */
export interface BoardCell {
  coord: BoardCoord;
  world: WorldPoint;
  /** Rotation (radians around the vertical axis) to align a square cell with its arm. */
  rotation: number;
  /** Arm whose colour tints this cell, or null for neutral track cells. */
  tintArm: number | null;
  safe: boolean;
  start: boolean;
  star: boolean;
}

export function boardCells(board: BoardGeometry): BoardCell[] {
  const cells: BoardCell[] = [];
  for (let square = 0; square < board.trackLength; square += 1) {
    const coord = trackSquareCoord(board, square);
    const start = board.startSquares.includes(square);
    const star = board.starSquares.includes(square);
    cells.push({
      coord,
      world: coordToWorld(board, coord),
      rotation: -armAngle(board, coord.arm),
      tintArm: start ? coord.arm : null,
      safe: start || star,
      start,
      star,
    });
  }
  for (let arm = 0; arm < board.armCount; arm += 1) {
    for (let depth = 0; depth < HOME_LANE_LENGTH; depth += 1) {
      const coord: BoardCoord = { kind: 'lane', arm, depth };
      cells.push({
        coord,
        world: coordToWorld(board, coord),
        rotation: -armAngle(board, arm),
        tintArm: arm,
        safe: true,
        start: false,
        star: false,
      });
    }
  }
  return cells;
}
