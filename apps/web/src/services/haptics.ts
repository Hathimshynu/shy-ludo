import { useSettings } from '../store/settingsStore';

/**
 * Subtle vibration feedback where supported (Android browsers). iOS Safari has no
 * Vibration API, so this silently does nothing there. Never required for gameplay.
 */
const PATTERNS = {
  tap: 8,
  roll: 12,
  select: [6, 30, 10],
  capture: [20, 40, 30],
  yourTurn: [10, 60, 10],
  win: [30, 50, 30, 50, 80],
} as const;

export type HapticName = keyof typeof PATTERNS;

export function hapticsSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function haptic(name: HapticName): void {
  if (!hapticsSupported() || !useSettings.getState().haptics) return;
  try {
    navigator.vibrate(PATTERNS[name] as number | number[]);
  } catch {
    /* some browsers throw without a user gesture — ignore */
  }
}
