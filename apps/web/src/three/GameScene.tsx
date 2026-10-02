import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { type ReactNode, Suspense, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { type ArmCount, createBoard } from '@ludo/game-engine';
import { presentation, usePresentation } from '../store/presentationStore';
import { useSettings } from '../store/settingsStore';
import { Board } from './Board';
import { Celebration, Effects } from './Effects';
import { Tokens } from './Tokens';

export type QualityLevel = 'high' | 'medium' | 'low';

/** Keeps the whole board in view for any aspect ratio, with subtle cinematic motion. */
function CameraRig({ armCount, padTop = 0, padBottom = 0 }: { armCount: number; padTop?: number; padBottom?: number }) {
  const { camera, size } = useThree();
  const pointer = useRef(new THREE.Vector2());
  const target = useRef(new THREE.Vector3());
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, dt) => {
    const cam = camera as THREE.PerspectiveCamera;
    const s = presentation.getState();
    const reduce = useSettings.getState().reduceMotion;
    const board = createBoard(armCount as ArmCount);
    const extent = armCount === 4 ? board.boardApothem + 1.0 : (board.boardApothem + 1.0) / Math.cos(Math.PI / armCount);
    const aspect = size.width / Math.max(1, size.height);
    const portrait = aspect < 0.9;
    // Steeper (more top-down) on portrait phones so the board fills the width.
    const elevation = THREE.MathUtils.degToRad(portrait ? 70 : 56);
    const vFov = THREE.MathUtils.degToRad(cam.fov / 2);
    const usable = Math.max(0.35, 1 - (padTop + padBottom) / Math.max(1, size.height));
    const hFov = Math.atan(Math.tan(vFov) * aspect);
    const needV = (extent * (Math.sin(elevation) + 0.18)) / (Math.tan(vFov) * usable);
    const needH = (extent * 1.04) / Math.tan(hFov);
    let dist = Math.max(needV, needH);

    const now = performance.now();
    const celebrating = s.winnerId && now - s.celebrateAt < 7000;
    if (celebrating && !reduce) dist *= 0.9;

    // Board centre shifted so it sits in the area between HUD bars.
    const shift = ((padBottom - padTop) / Math.max(1, size.height)) * Math.tan(vFov) * dist * 0.9;

    let tx = 0;
    let tz = 0;
    if (!reduce && s.focus && now - s.focus.at < 1400) {
      const rot = s.rotation;
      const fx = s.focus.x * Math.cos(rot) + s.focus.z * Math.sin(rot);
      const fz = -s.focus.x * Math.sin(rot) + s.focus.z * Math.cos(rot);
      tx = fx * 0.06;
      tz = fz * 0.06;
    }
    target.current.lerp(tmp.set(tx, 0, tz), 1 - Math.exp(-dt * 3));

    const desired = tmp.set(
      target.current.x + (reduce ? 0 : pointer.current.x * 0.5),
      Math.sin(elevation) * dist + (reduce ? 0 : pointer.current.y * 0.3),
      target.current.z + Math.cos(elevation) * dist,
    );
    cam.position.lerp(desired, 1 - Math.exp(-dt * 4));

    if (!reduce) {
      const shakeAge = now - s.shake;
      if (shakeAge < 380) {
        const k = (1 - shakeAge / 380) * 0.12;
        cam.position.x += (Math.random() - 0.5) * k;
        cam.position.y += (Math.random() - 0.5) * k;
      }
      const flashAge = now - s.flash.at;
      if (flashAge < 260) cam.position.y -= Math.sin((flashAge / 260) * Math.PI) * 0.12;
      if (!('ontouchstart' in window)) pointer.current.lerp(state.pointer, 0.05);
    }
    cam.lookAt(target.current.x, 0, target.current.z - shift);
  });
  return null;
}

/** Key/rim lights that drift and react to rolls and turn changes. */
function Lights({ quality }: { quality: QualityLevel }) {
  const accent = useRef<THREE.PointLight>(null);
  const rim = useRef<THREE.DirectionalLight>(null);
  const color = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }) => {
    const s = presentation.getState();
    const t = clock.elapsedTime;
    if (accent.current) {
      color.set(s.currentColor);
      accent.current.color.lerp(color, 0.06);
      const flash = Math.max(0, 1 - (performance.now() - s.flash.at) / 500);
      accent.current.intensity = 14 + Math.sin(t * 1.3) * 3 + flash * 40;
      accent.current.position.set(Math.cos(t * 0.25) * 9, 6, Math.sin(t * 0.25) * 9);
    }
    if (rim.current) rim.current.intensity = 0.9 + Math.sin(t * 0.7) * 0.15;
  });
  const shadowSize = quality === 'high' ? 2048 : 1024;
  return (
    <>
      <ambientLight intensity={0.32} color="#9a90ff" />
      <hemisphereLight args={['#c8c0ff', '#1a0f3a', 0.55]} />
      <directionalLight
        position={[6, 16, 9]}
        intensity={1.9}
        castShadow={quality !== 'low'}
        shadow-mapSize={[shadowSize, shadowSize]}
        shadow-camera-left={-13}
        shadow-camera-right={13}
        shadow-camera-top={13}
        shadow-camera-bottom={-13}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <directionalLight ref={rim} position={[-10, 6, -10]} intensity={0.9} color="#ff7ad9" />
      <pointLight ref={accent} position={[8, 6, 0]} intensity={14} distance={30} decay={1.6} />
    </>
  );
}

/** Slow floating motes of light above the board. */
function AmbientParticles({ count }: { count: number }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 } },
        vertexShader: `
          attribute vec3 aColor; attribute float aSeed; varying vec3 vColor; varying float vAlpha; uniform float uTime;
          void main(){
            vec3 p = position;
            p.y = mod(p.y + uTime * (0.15 + aSeed * 0.25), 9.0) + 0.3;
            p.x += sin(uTime * 0.3 + aSeed * 20.0) * 0.4;
            p.z += cos(uTime * 0.25 + aSeed * 13.0) * 0.4;
            vColor = aColor; vAlpha = smoothstep(0.3, 1.5, p.y) * (1.0 - smoothstep(6.5, 9.0, p.y));
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_PointSize = (40.0 + aSeed * 60.0) / -mv.z; gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `
          varying vec3 vColor; varying float vAlpha;
          void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
            gl_FragColor = vec4(vColor, a * vAlpha * 0.7); }`,
      }),
    [],
  );
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const palette = ['#ffd36b', '#a66bff', '#2fe0e8', '#ff5fc8', '#ffffff'].map((c) => new THREE.Color(c));
    for (let i = 0; i < count; i += 1) {
      const r = 4 + Math.random() * 12;
      const a = Math.random() * Math.PI * 2;
      pos.set([Math.cos(a) * r, Math.random() * 9, Math.sin(a) * r], i * 3);
      const c = palette[i % palette.length]!;
      col.set([c.r, c.g, c.b], i * 3);
      seed[i] = Math.random();
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    return g;
  }, [count]);
  useFrame(({ clock }) => {
    material.uniforms.uTime!.value = clock.elapsedTime;
  });
  if (count === 0) return null;
  return <points geometry={geometry} material={material} frustumCulled={false} />;
}

function Reflections() {
  return (
    <Environment resolution={128} frames={1}>
      <Lightformer form="ring" intensity={2} color="#ffffff" position={[0, 6, 0]} scale={8} rotation-x={Math.PI / 2} />
      <Lightformer form="rect" intensity={3} color="#a66bff" position={[-8, 3, -4]} scale={[6, 4, 1]} rotation-y={Math.PI / 3} />
      <Lightformer form="rect" intensity={3} color="#2fe0e8" position={[8, 3, 4]} scale={[6, 4, 1]} rotation-y={-Math.PI / 3} />
      <Lightformer form="rect" intensity={2} color="#ffc94d" position={[0, 2, 9]} scale={[10, 2, 1]} />
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

export interface SceneProps {
  armCount: number;
  activeArms?: number[];
  quality: QualityLevel;
  onSelect?: (playerId: string, index: number) => void;
  padTop?: number;
  padBottom?: number;
  children?: ReactNode;
  showTokens?: boolean;
}

export function GameScene({ armCount, activeArms, quality, onSelect, padTop, padBottom, children, showTokens = true }: SceneProps) {
  const reduce = useSettings((s) => s.reduceMotion);
  const rotation = usePresentation((s) => s.rotation);
  const particles = reduce ? 0 : quality === 'high' ? 260 : quality === 'medium' ? 140 : 0;
  return (
    <Canvas
      shadows={quality !== 'low'}
      dpr={quality === 'high' ? [1, 2] : quality === 'medium' ? [1, 1.5] : [0.85, 1]}
      gl={{ antialias: quality !== 'high', powerPreference: 'high-performance', alpha: true, stencil: false }}
      camera={{ fov: 36, position: [0, 18, 12], near: 0.5, far: 120 }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
      }}
      onPointerMissed={() => presentation.setState({ hovered: null })}
    >
      <FramePacer fps={quality === 'low' ? 30 : null} />
      <CameraRig armCount={armCount} padTop={padTop} padBottom={padBottom} />
      <Lights quality={quality} />
      <Suspense fallback={null}>{quality !== 'low' && <Reflections />}</Suspense>
      <group rotation-y={rotation}>
        <Board armCount={armCount} activeArms={activeArms} quality={quality} />
        {showTokens && <Tokens onSelect={onSelect ?? (() => undefined)} />}
        <Effects />
        {children}
      </group>
      <AmbientParticles count={particles} />
      <Celebration quality={quality} />
      {quality === 'high' && !reduce && (
        <EffectComposer multisampling={4}>
          <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={0.75} />
          <Vignette eskil={false} offset={0.25} darkness={0.55} />
        </EffectComposer>
      )}
      {quality === 'medium' && !reduce && (
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur luminanceThreshold={0.9} intensity={0.55} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
