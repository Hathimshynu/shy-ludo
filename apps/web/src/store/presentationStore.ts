import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Placement } from '../game/layout';

/**
 * 3D presentation state. Read every frame from `useFrame` via `getState()` so the
 * render loop never triggers React re-renders. Only coarse fields (token list,
 * selectable set) are subscribed to from React.
 */
export interface TokenAnim {
  kind: 'path' | 'capture';
  points: Placement[];
  start: number;
  stepMs: number;
  hop: number;
}

export interface TokenVisual {
  key: string;
  playerId: string;
  index: number;
  color: string;
  rest: Placement;
  anim: TokenAnim | null;
  finished: boolean;
  out: boolean;
  /** performance.now() when the home-entry celebration starts (purely visual). */
  homeAt?: number | undefined;
}

export type EffectKind = 'burst' | 'home';
export interface Effect {
  id: number;
  kind: EffectKind;
  x: number;
  y: number;
  z: number;
  color: string;
  start: number;
  dur: number;
}

export interface DiceVisual {
  value: number | null;
  rollId: number;
  spinning: boolean;
  color: string;
  by: string | null;
}

export interface PresentationState {
  armCount: number;
  rotation: number;
  tokens: Record<string, TokenVisual>;
  tokenKeys: string[];
  selectable: string[];
  hovered: string | null;
  currentColor: string;
  dice: DiceVisual;
  effects: Effect[];
  /** Capture impact time: a short, small camera nudge (skipped with Reduce Animations). */
  shake: number;
  /** Last token to reach home: the centre gem gives a brief acknowledgement. */
  homeFlash: { color: string; at: number };
  winnerId: string | null;
  celebrateAt: number;
  /** Pixels of the viewport covered by HUD on each side; the camera frames the board in the rest. */
  insets: { top: number; right: number; bottom: number; left: number };
  /** HUD rectangles (CSS px) the board must avoid, e.g. the desktop player rail and dice tray. */
  obstacles: Array<{ left: number; top: number; right: number; bottom: number }>;
  /** Token the player just picked (selection feedback before it moves). */
  selected: { key: string; at: number } | null;
}

export const initialPresentation = (): PresentationState => ({
  armCount: 4,
  rotation: 0,
  tokens: {},
  tokenKeys: [],
  selectable: [],
  hovered: null,
  currentColor: '#ffc94d',
  dice: { value: null, rollId: 0, spinning: false, color: '#ffc94d', by: null },
  effects: [],
  shake: -1e9,
  homeFlash: { color: '#ffffff', at: -1e9 },
  winnerId: null,
  celebrateAt: -1e9,
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  obstacles: [],
  selected: null,
});

export const presentation = createStore<PresentationState>()(() => initialPresentation());

let effectId = 1;
/**
 * Effects are short-lived and event-driven: each one is removed from the store (and
 * so unmounted, with its per-frame work) as soon as it ends.
 */
export function addEffect(e: Omit<Effect, 'id' | 'start'> & { start?: number }): void {
  const now = performance.now();
  const effect: Effect = { ...e, id: effectId++, start: e.start ?? now };
  presentation.setState((s) => ({
    effects: [...s.effects.filter((x) => now - x.start < x.dur), effect].slice(-12),
  }));
  const ttl = effect.start - now + effect.dur + 50;
  setTimeout(() => {
    presentation.setState((s) => (s.effects.includes(effect) ? { effects: s.effects.filter((x) => x !== effect) } : {}));
  }, ttl);
}

export function usePresentation<T>(selector: (s: PresentationState) => T): T {
  return useStore(presentation, selector);
}
