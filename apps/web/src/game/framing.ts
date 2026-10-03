import * as THREE from 'three';
import { type ArmCount, createBoard, yardDirection } from '@ludo/game-engine';

/**
 * Exact board framing. Instead of approximating the board's on-screen size, the board's
 * real outline (slab corners, top and bottom) is projected through a camera and the
 * camera distance is solved so that the projected board:
 *
 *   1. fits inside the free rectangle (viewport minus HUD insets and a margin),
 *   2. does not touch any HUD obstacle (desktop player rail / dice tray), sliding
 *      sideways where that keeps it larger,
 *   3. is centred in the free space whenever nothing forces it off-centre.
 *
 * The result is applied as a camera distance plus a screen-space shift
 * (`setViewOffset`), so the same board and camera code serve every layout.
 */

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FitInput {
  width: number;
  height: number;
  /** Area the board may use (CSS px). */
  free: ScreenRect;
  /** HUD rectangles the board must not overlap. */
  obstacles?: ScreenRect[];
  fov: number;
  /** Camera elevation (radians above the board plane). */
  elevation: number;
  /** Board outline in world space. */
  points: THREE.Vector3[];
  /** Gap kept between the board and the free-area edges / obstacles (px). */
  margin?: number;
}

export interface FitResult {
  distance: number;
  /** Screen-space shift of the board (px). */
  shiftX: number;
  shiftY: number;
  /** Projected board bounds after the shift. */
  bounds: ScreenRect;
}

/** World-space outline of the board (slab top and bottom) for a given board rotation. */
export function boardOutlinePoints(armCount: number, rotation: number): THREE.Vector3[] {
  const board = createBoard(armCount as ArmCount);
  // Rim tube sits at apothem + 0.86 (+0.05 radius); keep a little extra for the bevel.
  const R = (board.boardApothem + 0.95) / Math.cos(Math.PI / board.armCount);
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const points: THREE.Vector3[] = [];
  for (let a = 0; a < board.armCount; a += 1) {
    const d = yardDirection(board, a);
    const x = d.x * R;
    const z = d.z * R;
    // Same rotation as <group rotation-y={rotation}>.
    const wx = x * c + z * s;
    const wz = -x * s + z * c;
    for (const y of [0.35, -0.8]) points.push(new THREE.Vector3(wx, y, wz));
  }
  return points;
}

interface P2 {
  x: number;
  y: number;
}

function convexHull(points: P2[]): P2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: P2[] = [];
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Horizontal extent of a convex polygon within the band y0..y1, or null if it misses the band. */
function bandExtent(hull: P2[], y0: number, y1: number): { min: number; max: number } | null {
  const xs: number[] = [];
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    if (a.y >= y0 && a.y <= y1) xs.push(a.x);
    for (const yb of [y0, y1]) {
      if ((a.y - yb) * (b.y - yb) < 0) xs.push(a.x + ((yb - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null;
}

export function fitBoard(input: FitInput): FitResult {
  const { width: W, height: H, free, fov, elevation, points } = input;
  const margin = input.margin ?? 10;
  const obstacles = input.obstacles ?? [];
  const cam = new THREE.PerspectiveCamera(fov, W / H, 0.5, 500);
  const dir = new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation));
  const v = new THREE.Vector3();
  const fl = free.left + margin;
  const fr = free.right - margin;
  const ft = free.top + margin;
  const fb = free.bottom - margin;

  const project = (d: number): P2[] => {
    cam.position.copy(dir).multiplyScalar(d);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    return points.map((p) => {
      v.copy(p).project(cam);
      return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
    });
  };

  const place = (d: number): { ok: boolean; sx: number; sy: number; hull: P2[] } => {
    const hull = convexHull(project(d));
    const xs = hull.map((p) => p.x);
    const ys = hull.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    if (maxX - minX > fr - fl || maxY - minY > fb - ft) return { ok: false, sx: 0, sy: 0, hull };
    const sy = (ft + fb) / 2 - (minY + maxY) / 2;
    let lower = fl - minX;
    let upper = fr - maxX;
    for (const o of obstacles) {
      const band = bandExtent(hull, o.top - margin - sy, o.bottom + margin - sy);
      if (!band) continue;
      if ((o.left + o.right) / 2 < W / 2) lower = Math.max(lower, o.right + margin - band.min);
      else upper = Math.min(upper, o.left - margin - band.max);
    }
    if (lower > upper) return { ok: false, sx: 0, sy, hull };
    const centred = (fl + fr) / 2 - (minX + maxX) / 2;
    return { ok: true, sx: Math.min(upper, Math.max(lower, centred)), sy, hull };
  };

  // Projected size shrinks monotonically with distance: binary-search the closest fit.
  let lo = 1;
  let hi = 400;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (place(mid).ok) hi = mid;
    else lo = mid;
  }
  const best = place(hi);
  const xs = best.hull.map((p) => p.x + best.sx);
  const ys = best.hull.map((p) => p.y + best.sy);
  return {
    distance: hi,
    shiftX: best.sx,
    shiftY: best.sy,
    bounds: { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) },
  };
}
