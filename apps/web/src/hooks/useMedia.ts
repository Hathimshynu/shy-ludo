import { useEffect, useState, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const on = () => setMatches(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

/** Browser connectivity (navigator.onLine). */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

export type GameLayout = 'portrait' | 'landscape' | 'desktop';

/**
 * Game-screen composition:
 *  - portrait  (phones held upright): top bar · board · action dock · player strip
 *  - landscape (phones/tablets sideways, small screens): board · right-hand side panel
 *  - desktop   (large landscape screens): left player rail + floating dice tray
 */
export function computeGameLayout(width: number, height: number): GameLayout {
  if (width / height < 0.9) return 'portrait';
  if (height < 640 || width < 1024) return 'landscape';
  return 'desktop';
}

function subscribeResize(cb: () => void): () => void {
  window.addEventListener('resize', cb);
  window.addEventListener('orientationchange', cb);
  return () => {
    window.removeEventListener('resize', cb);
    window.removeEventListener('orientationchange', cb);
  };
}

export function useGameLayout(): GameLayout {
  return useSyncExternalStore(subscribeResize, () => computeGameLayout(window.innerWidth, window.innerHeight));
}
