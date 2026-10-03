import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { type ReactNode, type RefObject, Suspense, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { boardOutlinePoints, fitBoard } from '../game/framing';
import { presentation, usePresentation } from '../store/presentationStore';
import type { QualityTier } from '../services/device';
import { useSettings } from '../store/settingsStore';
import { Board } from './Board';
import { Celebration, Effects } from './Effects';
import { Tokens } from './Tokens';

export type QualityLevel = QualityTier;

/**
 * Per-tier rendering budget. The board looks premium through geometry, materials and
 * stable lighting; post-processing is limited to a subtle bloom on HIGH/ULTRA (which
 * only catches short-lived effects — nothing on the static board is bright enough).
 */
export const TIERS: Record<QualityLevel, {
  dpr: [number, number];
  shadows: boolean;
  shadowMap: number;
  reflections: number;
  bloom: boolean;
  msaa: number;
  fps: number | null;
}> = {
  low: { dpr: [0.75, 1], shadows: false, shadowMap: 0, reflections: 0, bloom: false, msaa: 0, fps: 30 },
  medium: { dpr: [1, 1.5], shadows: true, shadowMap: 1024, reflections: 64, bloom: false, msaa: 0, fps: null },
  high: { dpr: [1, 2], shadows: true, shadowMap: 2048, reflections: 128, bloom: true, msaa: 4, fps: null },
  ultra: { dpr: [1, 2.5], shadows: true, shadowMap: 4096, reflections: 256, bloom: true, msaa: 8, fps: null },
};

/**
 * Responsive framing. The HUD reports how many pixels it covers on each side
 * (presentation.insets); the board is fitted into the remaining rectangle:
 *
 *   viewport → minus safe areas & HUD (insets) → free rectangle (minus desktop
 *   obstacles) → exact fit of the projected board outline (game/framing.ts) →
 *   camera distance + setViewOffset() shift.
 *
 * The camera is stable during play. The only motion is a small nudge on a capture and
 * a gentle push-in for the winner — both disabled by Reduce Animations.
 */
function CameraRig({ armCount }: { armCount: number }) {
  const { camera, size } = useThree();
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const fitted = useRef<{ key: string; pos: THREE.Vector3 } | null>(null);

  useFrame((_, dt) => {
    const cam = camera as THREE.PerspectiveCamera;
    const s = presentation.getState();
    const reduce = useSettings.getState().reduceMotion;
    const W = Math.max(1, size.width);
    const H = Math.max(1, size.height);
    const { top, right, bottom, left } = s.insets;
    const now = performance.now();

    // Re-fit only when the viewport, HUD or board orientation changes — never per frame.
    const key = `${W}x${H}:${top},${right},${bottom},${left}:${s.obstacles.map((o) => `${o.left},${o.top},${o.right},${o.bottom}`).join('|')}:${armCount}:${s.rotation}:${cam.fov}`;
    if (fitted.current?.key !== key) {
      const free = { left, top, right: W - right, bottom: H - bottom };
      // Steeper (more top-down) when the free area is tall, so the board fills the width.
      const elevation = THREE.MathUtils.degToRad((free.right - free.left) / Math.max(1, free.bottom - free.top) < 0.95 ? 70 : 56);
      const fit = fitBoard({
        width: W,
        height: H,
        free,
        obstacles: s.obstacles,
        fov: cam.fov,
        elevation,
        points: boardOutlinePoints(armCount, s.rotation),
      });
      if (Math.abs(fit.shiftX) < 0.5 && Math.abs(fit.shiftY) < 0.5) cam.clearViewOffset();
      else cam.setViewOffset(W, H, -fit.shiftX, -fit.shiftY, W, H);
      const pos = new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation)).multiplyScalar(fit.distance);
      // The first frame (and a fresh game) starts on the fitted pose instead of flying in.
      if (!fitted.current) cam.position.copy(pos);
      fitted.current = { key, pos };
    }

    const desired = tmp.copy(fitted.current.pos);
    const celebrating = s.winnerId && now - s.celebrateAt < 7000;
    if (celebrating && !reduce) desired.multiplyScalar(0.92);
    // Ease to the fitted pose after a resize/rotation, then hold it exactly (no endless drift).
    if (cam.position.distanceToSquared(desired) < 1e-6) cam.position.copy(desired);
    else cam.position.lerp(desired, 1 - Math.exp(-dt * 6));

    if (!reduce) {
      const shakeAge = now - s.shake;
      if (shakeAge < SHAKE_MS) {
        // Deterministic, decaying nudge — a small "impact", not a random jitter.
        const k = (1 - shakeAge / SHAKE_MS) * 0.05;
        cam.position.x += Math.sin(shakeAge * 0.09) * k;
      }
    }
    cam.lookAt(0, 0, 0);
  });
  return null;
}

const SHAKE_MS = 280;

/** Stable lighting: ambient + hemisphere fill, one shadow-casting key and a soft rim. Nothing is animated. */
function Lights({ quality }: { quality: QualityLevel }) {
  const tier = TIERS[quality];
  const shadowSize = Math.max(512, tier.shadowMap);
  return (
    <>
      <ambientLight intensity={0.42} color="#b4adff" />
      <hemisphereLight args={['#d6d0ff', '#1a0f3a', 0.6]} />
      <directionalLight
        position={[6, 16, 9]}
        intensity={2.1}
        castShadow={tier.shadows}
        shadow-mapSize={[shadowSize, shadowSize]}
        shadow-camera-left={-13}
        shadow-camera-right={13}
        shadow-camera-top={13}
        shadow-camera-bottom={-13}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[-10, 6, -10]} intensity={0.6} color="#c9b8ff" />
    </>
  );
}

/** Static, soft studio reflections (rendered once). */
function Reflections({ resolution }: { resolution: number }) {
  return (
    <Environment resolution={resolution} frames={1}>
      <Lightformer form="ring" intensity={1.6} color="#ffffff" position={[0, 6, 0]} scale={8} rotation-x={Math.PI / 2} />
      <Lightformer form="rect" intensity={1.4} color="#c9b8ff" position={[-8, 3, -4]} scale={[6, 4, 1]} rotation-y={Math.PI / 3} />
      <Lightformer form="rect" intensity={1.4} color="#d8f4ff" position={[8, 3, 4]} scale={[6, 4, 1]} rotation-y={-Math.PI / 3} />
      <Lightformer form="rect" intensity={1.2} color="#ffe2a8" position={[0, 2, 9]} scale={[10, 2, 1]} />
    </Environment>
  );
}

/**
 * Frame pacing: stop rendering while the tab is hidden, and cap the "low" quality
 * tier at 30 fps to save battery on weak devices.
 */
function FramePacer({ fps }: { fps: number | null }) {
  const { invalidate, setFrameloop } = useThree();
  useEffect(() => {
    let timer: number | null = null;
    const apply = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      if (document.hidden) {
        setFrameloop('never');
      } else if (fps) {
        setFrameloop('demand');
        timer = window.setInterval(() => invalidate(), 1000 / fps);
      } else {
        setFrameloop('always');
      }
    };
    apply();
    document.addEventListener('visibilitychange', apply);
    return () => {
      document.removeEventListener('visibilitychange', apply);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [fps, invalidate, setFrameloop]);
  return null;
}

/**
 * Read-only layout probe for development and end-to-end tests (never in production
 * builds): projects the board's bounds and every token's resting position to CSS
 * pixels so tests can verify the board fits and nothing important is covered.
 */
function LayoutProbe({ board }: { board: RefObject<THREE.Group | null> }) {
  const { camera, size } = useThree();
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    const toScreen = (v: THREE.Vector3) => {
      const p = v.clone().project(camera);
      return { x: ((p.x + 1) / 2) * size.width, y: ((1 - p.y) / 2) * size.height };
    };
    w.__ludoScene = {
      probe: () => {
        const group = board.current;
        if (!group) return null;
        group.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(group.children[0]!);
        const outline: Array<{ x: number; y: number }> = [];
        for (const x of [box.min.x, box.max.x])
          for (const y of [box.min.y, Math.min(box.max.y, 0.3)])
            for (const z of [box.min.z, box.max.z]) outline.push(toScreen(new THREE.Vector3(x, y, z)));
        const xs = outline.map((p) => p.x);
        const ys = outline.map((p) => p.y);
        const tokens = Object.values(presentation.getState().tokens).map((t) => ({
          key: t.key,
          ...toScreen(group.localToWorld(new THREE.Vector3(t.rest.x, t.rest.y + 0.3, t.rest.z))),
        }));
        return {
          board: { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) },
          outline,
          tokens,
        };
      },
    };
    return () => {
      delete w.__ludoScene;
    };
  }, [camera, size, board]);
  return null;
}

const PROBE = import.meta.env.DEV || import.meta.env.VITE_E2E === 'true';

export interface SceneProps {
  armCount: number;
  activeArms?: number[];
  quality: QualityLevel;
  onSelect?: (playerId: string, index: number) => void;
  children?: ReactNode;
  showTokens?: boolean;
}

export function GameScene({ armCount, activeArms, quality, onSelect, children, showTokens = true }: SceneProps) {
  const reduce = useSettings((s) => s.reduceMotion);
  const rotation = usePresentation((s) => s.rotation);
  const tier = TIERS[quality];
  const boardGroup = useRef<THREE.Group>(null);
  return (
    <Canvas
      shadows={tier.shadows}
      dpr={tier.dpr}
      gl={{ antialias: tier.msaa === 0, powerPreference: 'high-performance', alpha: true, stencil: false }}
      camera={{ fov: 36, position: [0, 18, 12], near: 0.5, far: 120 }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
      }}
      onPointerMissed={() => presentation.setState({ hovered: null })}
    >
      <FramePacer fps={tier.fps} />
      <CameraRig armCount={armCount} />
      <Lights quality={quality} />
      <Suspense fallback={null}>{tier.reflections > 0 && <Reflections resolution={tier.reflections} />}</Suspense>
      {PROBE && <LayoutProbe board={boardGroup} />}
      <group ref={boardGroup} rotation-y={rotation}>
        <Board armCount={armCount} activeArms={activeArms} quality={quality} />
        {showTokens && <Tokens onSelect={onSelect ?? (() => undefined)} cheap={quality === 'low'} />}
        <Effects quality={quality} />
        {children}
      </group>
      <Celebration quality={quality} />
      {tier.bloom && !reduce && (
        <EffectComposer multisampling={tier.msaa}>
          <Bloom mipmapBlur luminanceThreshold={0.92} luminanceSmoothing={0.15} intensity={0.45} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
