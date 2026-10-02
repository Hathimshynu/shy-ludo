/**
 * Lightweight device capability detection used to pick an initial graphics tier.
 * Uses capabilities (WebGL, memory, cores, screen, data-saver), not user-agent strings.
 * The result is only a default — players can override it in Settings.
 */
export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface DeviceProfile {
  webgl: boolean;
  webgl2: boolean;
  maxTextureSize: number;
  softwareRenderer: boolean;
  cores: number;
  memoryGb: number | null;
  coarsePointer: boolean;
  screenPixels: number;
  dpr: number;
  saveData: boolean;
  recommended: QualityTier;
}

let cached: DeviceProfile | null = null;

function probeWebGL(): Pick<DeviceProfile, 'webgl' | 'webgl2' | 'maxTextureSize' | 'softwareRenderer'> {
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    const gl = gl2 ?? (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) return { webgl: false, webgl2: false, maxTextureSize: 0, softwareRenderer: true };
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    // The unmasked renderer is only used to spot software rasterisers.
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    const software = /swiftshader|llvmpipe|software|basic render/i.test(renderer);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { webgl: true, webgl2: !!gl2, maxTextureSize: max, softwareRenderer: software };
  } catch {
    return { webgl: false, webgl2: false, maxTextureSize: 0, softwareRenderer: true };
  }
}

export function recommendTier(p: Omit<DeviceProfile, 'recommended'>): QualityTier {
  if (!p.webgl || p.softwareRenderer) return 'low';
  const mem = p.memoryGb ?? (p.coarsePointer ? 4 : 8);
  let tier: QualityTier;
  if (p.coarsePointer) {
    // Phones and tablets.
    if (mem <= 2 || p.cores <= 4 || !p.webgl2) tier = 'low';
    else if (mem <= 4 || p.cores <= 6) tier = 'medium';
    else tier = 'high';
  } else {
    // Desktop / laptop.
    if (!p.webgl2 || p.cores <= 2) tier = 'medium';
    else if (p.cores >= 8 && mem >= 8 && p.maxTextureSize >= 16384) tier = 'ultra';
    else tier = 'high';
  }
  if (p.saveData && (tier === 'high' || tier === 'ultra')) tier = 'medium';
  return tier;
}

export function deviceProfile(): DeviceProfile {
  if (cached) return cached;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const base = {
    ...probeWebGL(),
    cores: nav.hardwareConcurrency ?? 4,
    memoryGb: nav.deviceMemory ?? null,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    screenPixels: Math.round(screen.width * screen.height * (window.devicePixelRatio || 1) ** 2),
    dpr: window.devicePixelRatio || 1,
    saveData: nav.connection?.saveData === true,
  };
  cached = { ...base, recommended: recommendTier(base) };
  return cached;
}

/** Touch-first device (used for mobile-only UX such as haptics and install prompts). */
export function isTouchDevice(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}
