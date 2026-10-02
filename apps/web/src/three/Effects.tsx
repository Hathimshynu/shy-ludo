import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { type Effect, presentation, usePresentation } from '../store/presentationStore';
import { useSettings } from '../store/settingsStore';

const ringGeometry = new THREE.RingGeometry(0.3, 0.42, 48);

/** Soft round additive sprites with per-particle colour and size. */
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

function Ring({ e }: { e: Effect }) {
  const mesh = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    const u = (performance.now() - e.start) / e.dur;
    if (!mesh.current || !mat.current) return;
    mesh.current.visible = u >= 0 && u < 1;
    mesh.current.scale.setScalar(0.6 + u * 1.2);
    mat.current.opacity = (1 - u) * 0.8;
  });
  return (
    <mesh ref={mesh} geometry={ringGeometry} position={[e.x, e.y + 0.02, e.z]} rotation-x={-Math.PI / 2}>
      <meshBasicMaterial ref={mat} color={e.color} transparent toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

/** Radial particle explosion + shockwave ring + flash (captures, homecomings, sparkles). */
function Burst({ e, count, speed, gravity, rise }: { e: Effect; count: number; speed: number; gravity: number; rise: number }) {
  const points = useRef<THREE.Points>(null);
  const flash = useRef<THREE.Mesh>(null);
  const wave = useRef<THREE.Mesh>(null);
  const material = useMemo(() => makeSpriteMaterial(), []);
  const { geometry, velocities } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const base = new THREE.Color(e.color);
    const white = new THREE.Color('#ffffff');
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * rise + 0.3;
      const s = speed * (0.4 + Math.random() * 0.8);
      vel[i * 3] = Math.cos(a) * s;
      vel[i * 3 + 1] = up * speed;
      vel[i * 3 + 2] = Math.sin(a) * s;
      const c = base.clone().lerp(white, Math.random() * 0.5);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = 0.08 + Math.random() * 0.14;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    return { geometry: g, velocities: vel };
  }, [count, e.color, speed, rise]);

  useFrame(() => {
    const t = (performance.now() - e.start) / 1000;
    const u = t / (e.dur / 1000);
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < count; i += 1) {
      pos.setXYZ(
        i,
        velocities[i * 3]! * t,
        velocities[i * 3 + 1]! * t - 0.5 * gravity * t * t,
        velocities[i * 3 + 2]! * t,
      );
    }
    pos.needsUpdate = true;
    material.uniforms.uOpacity!.value = Math.max(0, 1 - u);
    if (points.current) points.current.visible = u < 1;
    if (flash.current) {
      flash.current.visible = u < 0.25;
      flash.current.scale.setScalar(0.3 + u * 3);
      (flash.current.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - u * 4);
    }
    if (wave.current) {
      wave.current.visible = u < 0.6;
      wave.current.scale.setScalar(0.5 + u * 5);
      (wave.current.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.7 - u * 1.2);
    }
  });

  return (
    <group position={[e.x, e.y, e.z]}>
      <points ref={points} geometry={geometry} material={material} frustumCulled={false} />
      <mesh ref={flash}>
        <sphereGeometry args={[0.3, 16, 12]} />
        <meshBasicMaterial color={e.color} transparent toneMapped={false} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh ref={wave} geometry={ringGeometry} rotation-x={-Math.PI / 2} position-y={-e.y + 0.18}>
        <meshBasicMaterial color={e.color} transparent toneMapped={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

export function Effects() {
  const effects = usePresentation((s) => s.effects);
  const reduce = useSettings((s) => s.reduceMotion);
  const scale = reduce ? 0.3 : 1;
  return (
    <group>
      {effects.map((e) => {
        if (performance.now() - e.start > e.dur) return null;
        switch (e.kind) {
          case 'ring':
            return reduce ? null : <Ring key={e.id} e={e} />;
          case 'burst':
            return <Burst key={e.id} e={e} count={Math.round(70 * scale)} speed={2.6} gravity={6} rise={1.2} />;
          case 'home':
            return <Burst key={e.id} e={e} count={Math.round(60 * scale)} speed={1.4} gravity={1.5} rise={2.2} />;
          case 'sparkle':
            return reduce ? null : <Burst key={e.id} e={e} count={24} speed={1.2} gravity={0.5} rise={1.5} />;
        }
      })}
    </group>
  );
}

// ---- Winner celebration ---------------------------------------------------------------

const CONFETTI_COLORS = ['#ff4d5e', '#2ee59d', '#ffd23f', '#3d8bff', '#a66bff', '#ff8a3d', '#2fe0e8', '#ff5fc8', '#ffffff'];

export function Celebration({ quality }: { quality: 'high' | 'medium' | 'low' }) {
  const winnerId = usePresentation((s) => s.winnerId);
  const reduce = useSettings((s) => s.reduceMotion);
  if (!winnerId) return null;
  const count = reduce ? 40 : quality === 'high' ? 260 : quality === 'medium' ? 160 : 90;
  return (
    <group>
      <Confetti count={count} />
      {!reduce && <Fireworks shells={quality === 'low' ? 3 : 6} />}
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

  useFrame((_, dt) => {
    const m = mesh.current;
    if (!m) return;
    if (!colored.current) {
      data.forEach((_, i) => m.setColorAt(i, new THREE.Color(CONFETTI_COLORS[i % CONFETTI_COLORS.length])));
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      colored.current = true;
    }
    const elapsed = (performance.now() - presentation.getState().celebrateAt) / 1000;
    data.forEach((d, i) => {
      d.y -= d.vy * dt;
      if (d.y < 0.2) d.y = elapsed < 7 ? 8 + Math.random() * 4 : -10;
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
  const PER = 90;
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

  const launch = (s: number, now: number) => {
    const { g, vel, origin, born } = state;
    const col = g.getAttribute('aColor') as THREE.BufferAttribute;
    const size = g.getAttribute('aSize') as THREE.BufferAttribute;
    origin.set([(Math.random() - 0.5) * 14, 5 + Math.random() * 4, (Math.random() - 0.5) * 10 - 2], s * 3);
    born[s] = now;
    const c = new THREE.Color(CONFETTI_COLORS[Math.floor(Math.random() * 8)]);
    for (let i = 0; i < PER; i += 1) {
      const k = s * PER + i;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = 2.5 + Math.random() * 1.5;
      vel.set([Math.sin(phi) * Math.cos(theta) * sp, Math.cos(phi) * sp, Math.sin(phi) * Math.sin(theta) * sp], k * 3);
      const cc = c.clone().lerp(new THREE.Color('#ffffff'), Math.random() * 0.4);
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
      if ((born[s] === 0 || age > 1.6) && now - celebrateAt < 6) launch(s, now - Math.random() * 0.4);
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
    material.uniforms.uOpacity!.value = Math.max(0, 1 - Math.max(0, now - celebrateAt - 6) / 1.5);
  });

  return <points geometry={state.g} material={material} frustumCulled={false} />;
}
