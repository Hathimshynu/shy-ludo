import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { HOME_ENTRY_MS, homeEntryPose } from '../game/motion';
import { type Effect, presentation, usePresentation } from '../store/presentationStore';
import type { QualityTier } from '../services/device';
import { useSettings } from '../store/settingsStore';

/**
 * Event-driven effects only. Each effect is mounted while it plays and unmounted (with
 * its GPU resources disposed) when it ends — nothing here runs while the board is idle.
 */

const ringGeometry = new THREE.RingGeometry(0.3, 0.4, 48);
const discGeometry = new THREE.CircleGeometry(0.6, 40);

/** Soft round sprites with per-particle colour and size. */
function makeSpriteMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uOpacity: { value: 1 }, uScale: { value: 1 } },
    vertexShader: `
      attribute vec3 aColor; attribute float aSize; varying vec3 vColor; uniform float uScale;
      void main(){ vColor = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = aSize * uScale * (300.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `
      varying vec3 vColor; uniform float uOpacity;
      void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor * (0.6 + a), a * uOpacity); }`,
  });
}

/** A small, fixed pool of particles flying out from a point (no per-frame allocation). */
function useParticles(count: number, color: string, speed: number, rise: number) {
  const material = useMemo(() => makeSpriteMaterial(), []);
  const { geometry, velocities } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const base = new THREE.Color(color);
    const white = new THREE.Color('#ffffff');
    const c = new THREE.Color();
    for (let i = 0; i < count; i += 1) {
      // Evenly spread around the circle, with a little jitter, so few particles still read as a ring.
      const a = ((i + Math.random() * 0.6) / count) * Math.PI * 2;
      const s = speed * (0.6 + Math.random() * 0.5);
      vel[i * 3] = Math.cos(a) * s;
      vel[i * 3 + 1] = (0.4 + Math.random() * rise) * speed;
      vel[i * 3 + 2] = Math.sin(a) * s;
      c.copy(base).lerp(white, Math.random() * 0.45);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = 0.07 + Math.random() * 0.08;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    return { geometry: g, velocities: vel };
  }, [count, color, speed, rise]);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  const update = (t: number, gravity: number, opacity: number) => {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < count; i += 1) {
      pos.setXYZ(i, velocities[i * 3]! * t, velocities[i * 3 + 1]! * t - 0.5 * gravity * t * t, velocities[i * 3 + 2]! * t);
    }
    pos.needsUpdate = true;
    material.uniforms.uOpacity!.value = opacity;
  };
  return { geometry, material, update };
}

/** Capture: a small impact burst and a short shock ring (~0.6 s). */
function CaptureBurst({ e, count }: { e: Effect; count: number }) {
  const points = useRef<THREE.Points>(null);
  const wave = useRef<THREE.Mesh>(null);
  const waveMat = useRef<THREE.MeshBasicMaterial>(null);
  const { geometry, material, update } = useParticles(count, e.color, 1.8, 0.8);

  useFrame(() => {
    const age = performance.now() - e.start;
    const u = age / e.dur;
    const visible = u >= 0 && u < 1;
    if (points.current) points.current.visible = visible;
    if (!visible) return;
    update(age / 1000, 5, 1 - u);
    if (wave.current && waveMat.current) {
      wave.current.visible = u < 0.7;
      wave.current.scale.setScalar(0.6 + u * 2.2);
      waveMat.current.opacity = Math.max(0, 0.6 - u * 0.9);
    }
  });

  return (
    <group position={[e.x, e.y, e.z]}>
      <points ref={points} geometry={geometry} material={material} frustumCulled={false} visible={false} />
      <mesh ref={wave} geometry={ringGeometry} rotation-x={-Math.PI / 2} position-y={-e.y + 0.2} visible={false}>
        <meshBasicMaterial ref={waveMat} color={e.color} transparent depthWrite={false} />
      </mesh>
    </group>
  );
}

/**
 * Home entry: a soft aura under the token, one ring expanding outward and a few
 * particles drifting up — all in the player's colour, localised, ~1.2 s. Timing
 * follows the same curve as the token's rise (game/motion.ts).
 */
function HomeEntry({ e, count, reduce }: { e: Effect; count: number; reduce: boolean }) {
  const points = useRef<THREE.Points>(null);
  const aura = useRef<THREE.Mesh>(null);
  const auraMat = useRef<THREE.MeshBasicMaterial>(null);
  const ring = useRef<THREE.Mesh>(null);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  const { geometry, material, update } = useParticles(count, e.color, 0.9, 1.6);
  const RING_MS = 600;
  const RING_DELAY = 0.1 * HOME_ENTRY_MS;

  useFrame(() => {
    const age = performance.now() - e.start;
    const pose = homeEntryPose(age, reduce);
    if (aura.current && auraMat.current) {
      aura.current.visible = !pose.done;
      aura.current.scale.setScalar(0.7 + pose.glow * 0.5);
      auraMat.current.opacity = pose.glow * 0.45;
    }
    const ru = (age - RING_DELAY) / RING_MS;
    if (ring.current && ringMat.current) {
      ring.current.visible = !reduce && ru >= 0 && ru < 1;
      ring.current.scale.setScalar(0.8 + ru * 2.4);
      ringMat.current.opacity = Math.max(0, (1 - ru) * 0.75);
    }
    const pu = (age - RING_DELAY) / (HOME_ENTRY_MS - RING_DELAY);
    if (points.current) points.current.visible = count > 0 && pu >= 0 && pu < 1;
    if (count > 0 && pu >= 0 && pu < 1) update((age - RING_DELAY) / 1000, 0.6, 1 - pu * pu);
  });

  return (
    <group position={[e.x, e.y, e.z]}>
      <mesh ref={aura} geometry={discGeometry} rotation-x={-Math.PI / 2} position-y={0.03} visible={false}>
        <meshBasicMaterial ref={auraMat} color={e.color} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh ref={ring} geometry={ringGeometry} rotation-x={-Math.PI / 2} position-y={0.04} visible={false}>
        <meshBasicMaterial ref={ringMat} color={e.color} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <points ref={points} geometry={geometry} material={material} frustumCulled={false} visible={false} position-y={0.3} />
    </group>
  );
}

export function Effects({ quality = 'high' }: { quality?: QualityTier }) {
  const effects = usePresentation((s) => s.effects);
  const reduce = useSettings((s) => s.reduceMotion);
  // Small, fixed particle budgets: feedback, not fireworks.
  const capture = reduce ? 0 : quality === 'low' ? 8 : 16;
  const home = reduce ? 0 : quality === 'low' ? 8 : 14;
  return (
    <group>
      {effects.map((e) => {
        switch (e.kind) {
          case 'burst':
            return <CaptureBurst key={e.id} e={e} count={capture} />;
          case 'home':
            return <HomeEntry key={e.id} e={e} count={home} reduce={reduce} />;
          default:
            return null;
        }
      })}
    </group>
  );
}

// ---- Winner celebration ---------------------------------------------------------------

const CONFETTI_COLORS = ['#ff4d5e', '#2ee59d', '#ffd23f', '#3d8bff', '#a66bff', '#ff8a3d', '#2fe0e8', '#ff5fc8', '#ffffff'];
/** Hard limit: confetti and fireworks stop (and unmount) after this long. */
export const CELEBRATION_MS = 7500;

export function Celebration({ quality }: { quality: QualityTier }) {
  const winnerId = usePresentation((s) => s.winnerId);
  const celebrateAt = usePresentation((s) => s.celebrateAt);
  const reduce = useSettings((s) => s.reduceMotion);
  const [, rerender] = useState(0);
  const remaining = celebrateAt + CELEBRATION_MS - performance.now();
  useEffect(() => {
    if (!winnerId || remaining <= 0) return;
    const id = window.setTimeout(() => rerender((n) => n + 1), remaining + 20);
    return () => window.clearTimeout(id);
  }, [winnerId, remaining]);
  // A finished game restored from a snapshot has no celebration (celebrateAt is in the past).
  if (!winnerId || remaining <= 0) return null;
  const count = reduce ? 40 : { ultra: 300, high: 220, medium: 140, low: 60 }[quality];
  const shells = { ultra: 6, high: 5, medium: 3, low: 0 }[quality];
  return (
    <group>
      <Confetti count={count} />
      {!reduce && shells > 0 && <Fireworks shells={shells} />}
    </group>
  );
}

function Confetti({ count }: { count: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const data = useMemo(
    () =>
      Array.from({ length: count }, () => ({
        x: (Math.random() - 0.5) * 18,
        y: 6 + Math.random() * 10,
        z: (Math.random() - 0.5) * 18,
        vy: 1.2 + Math.random() * 1.6,
        sway: Math.random() * Math.PI * 2,
        rx: Math.random() * 6,
        ry: Math.random() * 6,
        spin: 2 + Math.random() * 6,
      })),
    [count],
  );
  const geometry = useMemo(() => new THREE.PlaneGeometry(0.16, 0.26), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colored = useRef(false);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((_, dt) => {
    const m = mesh.current;
    if (!m) return;
    if (!colored.current) {
      const c = new THREE.Color();
      data.forEach((_, i) => m.setColorAt(i, c.set(CONFETTI_COLORS[i % CONFETTI_COLORS.length]!)));
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      colored.current = true;
    }
    const elapsed = (performance.now() - presentation.getState().celebrateAt) / 1000;
    data.forEach((d, i) => {
      d.y -= d.vy * dt;
      // Recycle pieces only during the first part; afterwards they fall away.
      if (d.y < 0.2) d.y = elapsed < 5 ? 8 + Math.random() * 4 : -10;
      d.sway += dt * 2;
      d.rx += d.spin * dt;
      d.ry += d.spin * 0.6 * dt;
      dummy.position.set(d.x + Math.sin(d.sway) * 0.4, d.y, d.z + Math.cos(d.sway) * 0.3);
      dummy.rotation.set(d.rx, d.ry, 0);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geometry, material, count]} frustumCulled={false} />;
}

function Fireworks({ shells }: { shells: number }) {
  const PER = 70;
  const total = shells * PER;
  const material = useMemo(() => makeSpriteMaterial(), []);
  const state = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const size = new Float32Array(total);
    const vel = new Float32Array(total * 3);
    const origin = new Float32Array(shells * 3);
    const born = new Float32Array(shells);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    return { g, vel, origin, born };
  }, [total, shells]);
  useEffect(
    () => () => {
      state.g.dispose();
      material.dispose();
    },
    [state, material],
  );

  const launch = (s: number, now: number) => {
    const { g, vel, origin, born } = state;
    const col = g.getAttribute('aColor') as THREE.BufferAttribute;
    const size = g.getAttribute('aSize') as THREE.BufferAttribute;
    origin.set([(Math.random() - 0.5) * 14, 5 + Math.random() * 4, (Math.random() - 0.5) * 10 - 2], s * 3);
    born[s] = now;
    const c = new THREE.Color(CONFETTI_COLORS[Math.floor(Math.random() * 8)]);
    const cc = new THREE.Color();
    for (let i = 0; i < PER; i += 1) {
      const k = s * PER + i;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = 2.5 + Math.random() * 1.5;
      vel.set([Math.sin(phi) * Math.cos(theta) * sp, Math.cos(phi) * sp, Math.sin(phi) * Math.sin(theta) * sp], k * 3);
      cc.copy(c).lerp(WHITE, Math.random() * 0.4);
      col.setXYZ(k, cc.r, cc.g, cc.b);
      size.setX(k, 0.14 + Math.random() * 0.1);
    }
    col.needsUpdate = true;
    size.needsUpdate = true;
  };

  useFrame(() => {
    const now = performance.now() / 1000;
    const celebrateAt = presentation.getState().celebrateAt / 1000;
    const { g, vel, origin, born } = state;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let s = 0; s < shells; s += 1) {
      const age = now - born[s]!;
      if ((born[s] === 0 || age > 1.6) && now - celebrateAt < 5) launch(s, now - Math.random() * 0.4);
      const a = now - born[s]!;
      for (let i = 0; i < PER; i += 1) {
        const k = s * PER + i;
        pos.setXYZ(
          k,
          origin[s * 3]! + vel[k * 3]! * a,
          origin[s * 3 + 1]! + vel[k * 3 + 1]! * a - 2.5 * a * a,
          origin[s * 3 + 2]! + vel[k * 3 + 2]! * a,
        );
      }
    }
    pos.needsUpdate = true;
    material.uniforms.uOpacity!.value = Math.max(0, 1 - Math.max(0, now - celebrateAt - 5) / 1.5);
  });

  return <points geometry={state.g} material={material} frustumCulled={false} />;
}

const WHITE = new THREE.Color('#ffffff');
