import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { audio } from '../services/audio';

export type Quality = 'auto' | 'high' | 'medium' | 'low';

export interface SettingsState {
  soundOn: boolean;
  musicOn: boolean;
  sfxVolume: number;
  musicVolume: number;
  reduceMotion: boolean;
  quality: Quality;
  showEmotes: boolean;
  set: (patch: Partial<Omit<SettingsState, 'set'>>) => void;
}

const prefersReducedMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Storage that never throws (private mode, blocked storage). */
const safeStorage = createJSONStorage(() => ({
  getItem: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  removeItem: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
}));

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      soundOn: true,
      musicOn: false,
      sfxVolume: 0.8,
      musicVolume: 0.35,
      reduceMotion: Boolean(prefersReducedMotion),
      quality: 'auto',
      showEmotes: true,
      set: (patch) => set(patch),
    }),
    { name: 'ludo-nova:settings', storage: safeStorage, version: 1 },
  ),
);

function syncAudio(s: SettingsState): void {
  audio.configure({ sfx: s.soundOn, music: s.musicOn, sfxVolume: s.sfxVolume, musicVolume: s.musicVolume });
  document.documentElement.classList.toggle('reduce-motion', s.reduceMotion);
}
syncAudio(useSettings.getState());
useSettings.subscribe(syncAudio);

/** Resolve "auto" quality from the device. */
export function resolveQuality(q: Quality): Exclude<Quality, 'auto'> {
  if (q !== 'auto') return q;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  if (coarse && (cores <= 4 || memory <= 3)) return 'low';
  if (coarse) return 'medium';
  return cores >= 8 ? 'high' : 'medium';
}
