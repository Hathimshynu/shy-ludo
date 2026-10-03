import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three-stdlib';
import { presentation } from '../store/presentationStore';
import { useSettings } from '../store/settingsStore';

/** Face normal for each value (opposite faces sum to 7). */
const FACE: Record<number, THREE.Vector3> = {
  1: new THREE.Vector3(0, 1, 0),
  6: new THREE.Vector3(0, -1, 0),
  2: new THREE.Vector3(1, 0, 0),
  5: new THREE.Vector3(-1, 0, 0),
  3: new THREE.Vector3(0, 0, 1),
  4: new THREE.Vector3(0, 0, -1),
};

const PIPS: Record<number, Array<[number, number]>> = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  5: [[-1, -1], [-1, 1], [0, 0], [1, -1], [1, 1]],
  6: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]],
};

const UP = new THREE.Vector3(0, 1, 0);
const TARGET_COLOR = new THREE.Color();
const ROLL_MS = 900;
const ROLL_MS_REDUCED = 240;

function faceBasis(n: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const helper = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(n, helper).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return [u, v];
}

/** The die canvas only renders while visible. */
function HiddenPause() {
  const { setFrameloop } = useThree();
  useEffect(() => {
    const apply = () => setFrameloop(document.hidden ? 'never' : 'always');
    apply();
    document.addEventListener('visibilitychange', apply);
    return () => document.removeEventListener('visibilitychange', apply);
  }, [setFrameloop]);
  return null;
}

function Die() {
  const group = useRef<THREE.Group>(null);
  const bodyMat = useRef<THREE.MeshPhysicalMaterial>(null);
  const halo = useRef<THREE.Mesh>(null);
  const haloMat = useRef<THREE.MeshBasicMaterial>(null);
  const geometry = useMemo(() => new RoundedBoxGeometry(1, 1, 1, 5, 0.16), []);
  const pipGeometry = useMemo(() => new THREE.SphereGeometry(0.088, 20, 14), []);

  const pips = useMemo(() => {
    const list: Array<{ pos: THREE.Vector3; quat: THREE.Quaternion; one: boolean }> = [];
    for (let value = 1; value <= 6; value += 1) {
      const n = FACE[value]!;
      const [u, v] = faceBasis(n);
      for (const [a, b] of PIPS[value]!) {
        const pos = n.clone().multiplyScalar(0.5).add(u.clone().multiplyScalar(a * 0.25)).add(v.clone().multiplyScalar(b * 0.25));
        list.push({ pos, quat: new THREE.Quaternion().setFromUnitVectors(UP, n), one: value === 1 });
      }
    }
    return list;
  }, []);

  const anim = useRef({
    rollId: -1,
    start: 0,
    from: new THREE.Quaternion(),
    target: new THREE.Quaternion().setFromUnitVectors(FACE[6]!, UP),
    axis: new THREE.Vector3(1, 0, 0),
    turns: 0,
    color: new THREE.Color('#ffc94d'),
  });
  const spinAxis = useMemo(() => new THREE.Vector3(1, 0.7, 0.3).normalize(), []);
  const tmpQ = useMemo(() => new THREE.Quaternion(), []);

  useFrame(({ clock }, dt) => {
    const g = group.current;
    if (!g) return;
    const d = presentation.getState().dice;
    const a = anim.current;
    const reduce = useSettings.getState().reduceMotion;
    const now = performance.now();
    const time = clock.elapsedTime;
    a.color.lerp(TARGET_COLOR.set(d.color), 0.15);

    if (d.rollId !== a.rollId && d.value !== null) {
      // New authoritative result: plan a tumble that ends exactly on that face.
      a.rollId = d.rollId;
      a.start = now;
      a.from.copy(g.quaternion);
      const yaw = new THREE.Quaternion().setFromAxisAngle(UP, (Math.random() - 0.5) * 1.2);
      a.target.setFromUnitVectors(FACE[d.value]!, UP).premultiply(yaw);
      a.axis.set(Math.random() - 0.5, Math.random() * 0.3, Math.random() - 0.5).normalize();
      a.turns = reduce ? 0 : Math.PI * 2 * (2 + Math.floor(Math.random() * 2));
    }

    const duration = reduce ? ROLL_MS_REDUCED : ROLL_MS;
    const u = Math.min(1, (now - a.start) / duration);
    let lift = 0;
    if (d.spinning && u >= 1) {
      // Waiting for the server: free spin.
      tmpQ.setFromAxisAngle(spinAxis, dt * 14);
      g.quaternion.premultiply(tmpQ);
      lift = 0.35 + Math.sin(time * 18) * 0.05;
    } else if (u < 1) {
      const e = 1 - (1 - u) ** 3;
      // Unwind a rotation around a random axis so the final orientation is exact.
      tmpQ.setFromAxisAngle(a.axis, a.turns * (1 - e));
      g.quaternion.copy(a.target).premultiply(tmpQ);
      if (u < 0.15) g.quaternion.slerp(a.from, 1 - u / 0.15);
      lift = reduce ? 0 : Math.abs(Math.sin(u * Math.PI * 2.2)) * (1 - u) * 1.1;
    } else {
      // At rest the die is perfectly still.
      if (g.quaternion.angleTo(a.target) < 1e-4) g.quaternion.copy(a.target);
      else g.quaternion.slerp(a.target, 0.2);
    }
    g.position.y = lift;
    const land = u < 1 ? Math.max(0, 1 - Math.abs(u - 0.98) * 12) : 0;
    g.scale.set(1 + land * 0.06, 1 - land * 0.1, 1 + land * 0.06);

    if (bodyMat.current) {
      bodyMat.current.emissive.copy(a.color);
      bodyMat.current.emissiveIntensity = 0.06 + (u < 1 ? 0.12 : 0) + (d.spinning ? 0.1 : 0);
    }
    if (halo.current && haloMat.current) {
      haloMat.current.color.copy(a.color);
      // Bright while rolling, a steady soft glow at rest (no idle pulsing).
      haloMat.current.opacity = u < 1 || d.spinning ? 0.55 : 0.12;
      halo.current.scale.setScalar(1 + (u < 1 ? Math.sin(u * Math.PI) * 0.4 : 0));
    }
  });

  return (
    <>
      <mesh ref={halo} position-y={-0.62} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.62, 0.95, 48]} />
        <meshBasicMaterial ref={haloMat} transparent toneMapped={false} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <group ref={group}>
        <mesh geometry={geometry}>
          <meshPhysicalMaterial
            ref={bodyMat}
            color="#fbf8ff"
            roughness={0.18}
            metalness={0.02}
            clearcoat={1}
            clearcoatRoughness={0.1}
            sheen={0.6}
            sheenColor="#d8ccff"
          />
        </mesh>
        {pips.map((p, i) => (
          <mesh key={i} geometry={pipGeometry} position={p.pos} quaternion={p.quat} scale={[1, 0.38, 1]}>
            <meshStandardMaterial
              color={p.one ? '#ff4d5e' : '#1b1442'}
              roughness={0.4}
              emissive={p.one ? '#ff4d5e' : '#000000'}
              emissiveIntensity={p.one ? 0.5 : 0}
            />
          </mesh>
        ))}
      </group>
    </>
  );
}

export function Dice3D() {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 30, position: [0, 3.4, 2.5] }}
      gl={{ alpha: true, antialias: true }}
      onCreated={({ gl, camera }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        camera.lookAt(0, 0, 0);
      }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 5, 3]} intensity={2.2} />
      <pointLight position={[-2, 2, 2]} intensity={6} color="#a66bff" />
      <HiddenPause />
      <Die />
    </Canvas>
  );
}
