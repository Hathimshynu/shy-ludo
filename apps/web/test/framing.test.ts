import { describe, expect, it } from 'vitest';
import { boardOutlinePoints, fitBoard, type ScreenRect } from '../src/game/framing';

const FOV = 36;
const deg = (d: number) => (d * Math.PI) / 180;

function fit(width: number, height: number, free: ScreenRect, obstacles: ScreenRect[] = [], armCount = 4, rotation = 0) {
  const elevation = deg((free.right - free.left) / (free.bottom - free.top) < 0.95 ? 70 : 56);
  return fitBoard({ width, height, free, obstacles, fov: FOV, elevation, points: boardOutlinePoints(armCount, rotation) });
}

const within = (b: ScreenRect, r: ScreenRect, slack = 0.5) =>
  b.left >= r.left - slack && b.right <= r.right + slack && b.top >= r.top - slack && b.bottom <= r.bottom + slack;

describe('exact board framing', () => {
  const cases: Array<[number, number, ScreenRect]> = [
    [320, 568, { left: 0, top: 60, right: 320, bottom: 568 - 230 }],
    [375, 812, { left: 0, top: 64, right: 375, bottom: 812 - 250 }],
    [768, 1024, { left: 0, top: 70, right: 768, bottom: 1024 - 260 }],
    [844, 390, { left: 0, top: 70, right: 844 - 300, bottom: 390 }],
    [1920, 1080, { left: 0, top: 80, right: 1920, bottom: 1080 - 16 }],
  ];

  for (const [w, h, free] of cases) {
    it(`fills the free area at ${w}×${h} without leaving it`, () => {
      for (const arms of [4, 6, 8]) {
        const r = fit(w, h, free, [], arms, 0.7);
        expect(within(r.bounds, free)).toBe(true);
        // One axis is binding: the board spans it edge to edge, minus the 10 px margins.
        const fill = Math.max(
          (r.bounds.right - r.bounds.left) / (free.right - free.left - 20),
          (r.bounds.bottom - r.bounds.top) / (free.bottom - free.top - 20),
        );
        expect(fill).toBeGreaterThan(0.99);
      }
    });
  }

  it('centres the board in the free area when nothing is in the way', () => {
    const free = { left: 0, top: 80, right: 1366, bottom: 752 };
    const r = fit(1366, 768, free);
    const cx = (r.bounds.left + r.bounds.right) / 2;
    const cy = (r.bounds.top + r.bounds.bottom) / 2;
    expect(Math.abs(cx - 683)).toBeLessThan(1);
    expect(Math.abs(cy - (80 + 752) / 2)).toBeLessThan(1);
  });

  it('slides or shrinks the board to clear desktop HUD obstacles', () => {
    const free = { left: 0, top: 80, right: 1440, bottom: 884 };
    const rail = { left: 14, top: 82, right: 244, bottom: 360 };
    const dock = { left: 1124, top: 884 - 135 - 120, right: 1424, bottom: 884 };
    const open = fit(1440, 900, free);
    const blocked = fit(1440, 900, free, [rail, dock]);
    // Without obstacles the centred board reaches under the dock's corner.
    expect(open.bounds.right).toBeGreaterThan(dock.left);
    // With them, the board's right edge clears the dock (its widest, bottom part is level with it).
    expect(blocked.bounds.right).toBeLessThanOrEqual(dock.left);
    expect(within(blocked.bounds, free)).toBe(true);
    // ...while staying large: still at least 85% of the free height.
    expect((blocked.bounds.bottom - blocked.bounds.top) / (free.bottom - free.top)).toBeGreaterThan(0.85);
  });
});
