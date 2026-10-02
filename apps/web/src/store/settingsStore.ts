import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { audio } from '../services/audio';
import { deviceProfile, type QualityTier } from '../services/device';

export type Quality = 'auto' | QualityTier;

export interface SettingsState {
  soundOn: boolean;
  musicOn: boolean;
  sfxVolume: number;
  musicVolume: number;
  reduceMotion: boolean;
  quality: Quality;
  showEmotes: boolean;
  haptics: boolean;
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
      haptics: true,
      set: (patch) => set(patch),
    }),
    {
      name: 'ludo-nova:settings',
      storage: safeStorage,
      version: 2,
      // v1 → v2: adds haptics and the ULTRA tier; keeps every existing preference.
      migrate: (persisted) => ({ haptics: true, ...(persisted as object) }) as SettingsState,
    },
  ),
);

function syncAudio(s: SettingsState): void {
  audio.configure({ sfx: s.soundOn, music: s.musicOn, sfxVolume: s.sfxVolume, musicVolume: s.musicVolume });
  document.documentElement.classList.toggle('reduce-motion', s.reduceMotion);
}
syncAudio(useSettings.getState());
useSettings.subscribe(syncAudio);

/** Resolve "auto" quality from the device capability probe. */
export function resolveQuality(q: Quality): QualityTier {
  if (q !== 'auto') return q;
  return deviceProfile().recommended;
}
