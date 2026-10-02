import { type ThreeEvent, useFrame } from '@react-three/fiber';
import { memo, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { presentation, usePresentation } from '../store/presentationStore';
import { useSettings } from '../store/settingsStore';

// ---- Shared geometry & materials (created once) --------------------------------------

const PROFILE: Array<[number, number]> = [
  [0, 0],
  [0.34, 0],
  [0.36, 0.035],
  [0.34, 0.085],
  [0.26, 0.12],
  [0.19, 0.18],
  [0.15, 0.26],
  [0.13, 0.36],
  [0.15, 0.42],
  [0.2, 0.455],
  [0.2, 0.48],
  [0.12, 0.5],
  [0, 0.5],
];

let shared: {
  body: THREE.LatheGeometry;
  head: THREE.SphereGeometry;
  collar: THREE.TorusGeometry;
  ring: THREE.RingGeometry;
  hit: THREE.CylinderGeometry;
  shadow: THREE.CircleGeometry;
} | null = null;

function geometries() {
  shared ??= {
    body: new THREE.LatheGeometry(
      PROFILE.map(([r, y]) => new THREE.Vector2(r, y)),
      40,
    ),
    head: new THREE.SphereGeometry(0.17, 32, 24),
    collar: new THREE.TorusGeometry(0.2, 0.022, 10, 40),
    ring: new THREE.RingGeometry(0.4, 0.5, 48),
    hit: new THREE.CylinderGeometry(0.45, 0.45, 1.0, 12),
    shadow: new THREE.CircleGeometry(0.34, 32),
  };
  return shared;
}

const materialCache = new Map<string, { body: THREE.MeshPhysicalMaterial; collar: THREE.MeshBasicMaterial }>();
/** `cheap` (LOW tier) swaps the clear-coated physical material for a standard one. */
function materialsFor(color: string, out: boolean, cheap: boolean) {
  const key = `${color}|${out}|${cheap}`;
  let m = materialCache.get(key);
  if (!m) {
    const base = new THREE.Color(out ? '#6f6a8f' : color);
    m = {
      body: cheap
        ? (new THREE.MeshStandardMaterial({
            color: base,
            roughness: 0.25,
            metalness: 0.1,
            emissive: base,
            emissiveIntensity: out ? 0 : 0.2,
          }) as THREE.MeshPhysicalMaterial)
        : new THREE.MeshPhysicalMaterial({
            color: base,
            roughness: 0.16,
            metalness: 0.08,
            clearcoat: 1,
            clearcoatRoughness: 0.08,
            sheen: 0.4,
            sheenColor: new THREE.Color('#ffffff'),
            emissive: base,
            emissiveIntensity: out ? 0 : 0.14,
          }),
      collar: new THREE.MeshBasicMaterial({ color: out ? '#8a85a8' : base.clone().lerp(new THREE.Color('#ffffff'), 0.45), toneMapped: false }),
    };
    materialCache.set(key, m);
  }
  return m;
}

const hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
const shadowMaterial = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.35, depthWrite: false });

// ---- Token ------------------------------------------------------------------------------

const ONE = new THREE.Vector3(1, 1, 1);
const TARGET = new THREE.Vector3();
const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

const WHITE = new THREE.Color('#ffffff');
const TINT = new THREE.Color();
const SELECT_MS = 650;
/** Touch screens get a larger invisible hit target. */
const COARSE = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);

interface TokenProps {
  tokenKey: string;
  onSelect: (playerId: string, index: number) => void;
  cheap: boolean;
}

const Token = memo(function Token({ tokenKey, onSelect, cheap }: TokenProps) {
  const g = geometries();
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const current = useRef(new THREE.Vector3());
  const initialised = useRef(false);

  const color = usePresentation((s) => s.tokens[tokenKey]?.color ?? '#ffffff');
  const out = usePresentation((s) => s.tokens[tokenKey]?.out ?? false);
  const selectable = usePresentation((s) => s.selectable.includes(tokenKey));
  const mats = useMemo(() => materialsFor(color, out, cheap), [color, out, cheap]);
  const shadowMat = useMemo(() => shadowMaterial.clone(), []);

  useFrame(({ clock }, dt) => {
    const s = presentation.getState();
    const t = s.tokens[tokenKey];
    if (!t || !group.current || !body.current) return;
    const reduce = useSettings.getState().reduceMotion;
    const now = performance.now();
    const time = clock.elapsedTime;
    let { x, y, z } = t.rest;
    let scale = t.rest.scale;
    let spin = 0;
    let moving = false;

    const anim = t.anim;
    if (anim) {
      const segs = anim.points.length - 1;
      const total = segs * anim.stepMs;
      const elapsed = now - anim.start;
      if (elapsed < total) {
        moving = true;
        if (elapsed < 0) {
          const p = anim.points[0]!;
          x = p.x;
          y = p.y;
          z = p.z;
          scale = p.scale;
          if (anim.kind === 'capture') body.current.position.x = Math.sin(now * 0.08) * 0.04; // shiver
        } else {
          const i = Math.min(segs - 1, Math.floor(elapsed / anim.stepMs));
          const u = (elapsed - i * anim.stepMs) / anim.stepMs;
          const a = anim.points[i]!;
          const b = anim.points[i + 1]!;
          const e = easeInOut(u);
          x = a.x + (b.x - a.x) * e;
          z = a.z + (b.z - a.z) * e;
          y = a.y + (b.y - a.y) * e + Math.sin(Math.PI * u) * anim.hop;
          scale = a.scale + (b.scale - a.scale) * e;
          if (anim.kind === 'capture') {
            spin = u * Math.PI * 6;
            scale *= 1 - Math.sin(Math.PI * u) * 0.35;
          } else {
            spin = Math.sin(Math.PI * u) * 0.5;
            // squash on landing
            const land = Math.max(0, 1 - Math.abs(u - 1) * 6);
            body.current.scale.set(1 + land * 0.12, 1 - land * 0.16, 1 + land * 0.12);
          }
        }
      }
    }

    if (!moving) {
      body.current.scale.lerp(ONE, 0.25);
      body.current.position.x = 0;
      TARGET.set(x, y, z);
      if (!initialised.current) current.current.copy(TARGET);
      current.current.lerp(TARGET, 1 - Math.exp(-dt * 14));
      x = current.current.x;
      y = current.current.y;
      z = current.current.z;
      if (!reduce) {
        if (selectable) y += Math.abs(Math.sin(time * 5.2 + t.index)) * 0.16;
        else if (s.winnerId === t.playerId) y += Math.abs(Math.sin(time * 6 + t.index * 0.7)) * 0.45;
        else if (!t.finished) y += Math.sin(time * 1.8 + t.index * 1.3 + x) * 0.012;
      }
    } else {
      current.current.set(x, y, z);
    }
    initialised.current = true;

    const hovered = s.hovered === tokenKey && selectable;
    // Selection feedback: a white ring and a quick scale pop the instant a token is picked.
    const selAge = s.selected?.key === tokenKey ? now - s.selected.at : Infinity;
    const selected = selAge < SELECT_MS;
    const pop = selected && !reduce ? Math.sin((selAge / SELECT_MS) * Math.PI) * 0.22 : 0;
    group.current.position.set(x, y, z);
    const k = scale * (hovered ? 1.14 : 1) * (1 + pop);
    group.current.scale.setScalar(k);
    body.current.rotation.y = spin + (selectable && !reduce ? Math.sin(time * 2) * 0.25 : 0);

    if (ring.current && ringMat.current) {
      ring.current.visible = selectable || selected;
      if (selectable || selected) {
        const pulse = reduce ? 1 : selected ? 1.15 + pop : 1 + Math.sin(time * 6) * 0.12;
        ring.current.scale.setScalar(pulse);
        ringMat.current.color.copy(selected ? WHITE : TINT.set(color));
        ringMat.current.opacity = selected ? 0.95 : 0.55 + Math.sin(time * 6) * 0.3;
        ring.current.position.y = -(y - t.rest.y) / k + 0.02;
      }
    }
    if (shadow.current) {
      const height = Math.max(0, y - t.rest.y);
      shadow.current.position.y = -height / k + 0.012;
      const sh = 1 / (1 + height * 1.2);
      shadow.current.scale.setScalar(sh);
      shadowMat.opacity = 0.35 * sh;
    }
  });

  const handleOver = (e: ThreeEvent<PointerEvent>) => {
    if (!selectable) return;
    e.stopPropagation();
    presentation.setState({ hovered: tokenKey });
    document.body.style.cursor = 'pointer';
  };
  const handleOut = () => {
    if (presentation.getState().hovered === tokenKey) presentation.setState({ hovered: null });
    document.body.style.cursor = '';
  };
  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (!selectable) return;
    e.stopPropagation();
    const t = presentation.getState().tokens[tokenKey];
    if (t) onSelect(t.playerId, t.index);
  };

  return (
    <group ref={group}>
      <mesh ref={shadow} geometry={g.shadow} material={shadowMat} rotation-x={-Math.PI / 2} />
      <mesh ref={ring} geometry={g.ring} rotation-x={-Math.PI / 2} visible={false}>
        <meshBasicMaterial ref={ringMat} color={color} transparent toneMapped={false} depthWrite={false} />
      </mesh>
      <group ref={body}>
        <mesh geometry={g.body} material={mats.body} castShadow />
        <mesh geometry={g.head} material={mats.body} position-y={0.62} castShadow />
        <mesh geometry={g.collar} material={mats.collar} position-y={0.465} rotation-x={Math.PI / 2} />
      </group>
      {/* Generous, invisible hit target for touch. Only selectable tokens take pointer events. */}
      <mesh
        geometry={g.hit}
        material={hitMaterial}
        position-y={0.45}
        scale={COARSE ? [1.25, 1, 1.25] : 1}
        raycast={selectable ? THREE.Mesh.prototype.raycast : () => undefined}
        onPointerOver={handleOver}
        onPointerOut={handleOut}
        onClick={handleClick}
      />
    </group>
  );
});

export function Tokens({ onSelect, cheap = false }: { onSelect: (playerId: string, index: number) => void; cheap?: boolean }) {
  const keys = usePresentation((s) => s.tokenKeys);
  return (
    <group>
      {keys.map((k) => (
        <Token key={k} tokenKey={k} onSelect={onSelect} cheap={cheap} />
      ))}
    </group>
  );
}
