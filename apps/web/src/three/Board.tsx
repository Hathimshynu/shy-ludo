import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three-stdlib';
import {
  type ArmCount,
  armColors,
  baseSlotWorld,
  boardCells,
  createBoard,
  yardCenter,
} from '@ludo/game-engine';
import { PLAYER_HEX } from '../game/layout';
import type { QualityTier } from '../services/device';
import { presentation } from '../store/presentationStore';
import {
  armRotation,
  boardOutline,
  createFeltMaterial,
  createTileMaterial,
  extrudeUp,
  homePyramid,
  roundedPolygon,
  roundedRect,
  starShape,
} from './geometry';

const TILE_Y = 0.1;
const NEUTRAL = new THREE.Color('#d6d0f0');
const GEM_ACK_MS = 900;
const GEM_YAW = Math.PI / 4;
const GEM_GLOW = 0.35;
const GEM_EMISSIVE = new THREE.Color('#ffb84d');
const TMP_COLOR = new THREE.Color();

interface BoardProps {
  armCount: number;
  /** Arms that have a player (others are drawn dimmer). */
  activeArms?: number[];
  quality?: QualityTier;
}

/**
 * The procedurally generated board: lacquered slab, gold trim, playfield, coloured
 * yards, instanced tiles, star squares and the central home pyramid with its gem.
 * Everything is static: the board never animates on its own.
 */
export function Board({ armCount, activeArms, quality = 'high' }: BoardProps) {
  const board = useMemo(() => createBoard(armCount as ArmCount), [armCount]);
  const colors = useMemo(() => armColors(board.armCount).map((c) => new THREE.Color(PLAYER_HEX[c])), [board]);
  const active = useMemo(() => new Set(activeArms ?? colors.map((_, i) => i)), [activeArms, colors]);

  // ---- Slab, rim and playfield ------------------------------------------------
  const slab = useMemo(() => {
    const outline = boardOutline(board, board.boardApothem + 0.55);
    return extrudeUp(roundedPolygon(outline, 1.4), 0.55, 0.22, 5);
  }, [board]);
  const felt = useMemo(() => {
    const outline = boardOutline(board, board.boardApothem + 0.25);
    return new THREE.ShapeGeometry(roundedPolygon(outline, 1.1), 24);
  }, [board]);
  const rimCurve = useMemo(() => {
    const outline = boardOutline(board, board.boardApothem + 0.86);
    const pts = roundedPolygon(outline, 1.6)
      .getSpacedPoints(240)
      .map((p) => new THREE.Vector3(p.x, 0, -p.y));
    return new THREE.CatmullRomCurve3(pts, true);
  }, [board]);
  const rim = useMemo(() => new THREE.TubeGeometry(rimCurve, 360, 0.05, 8, true), [rimCurve]);
  const feltMaterial = useMemo(() => createFeltMaterial(), []);

  // ---- Tiles (one instanced draw call) -----------------------------------------
  const cells = useMemo(() => boardCells(board), [board]);
  const tileGeometry = useMemo(() => {
    const g = new RoundedBoxGeometry(0.9, 0.12, 0.9, 2, 0.07);
    return g;
  }, []);
  const tileMaterial = useMemo(() => createTileMaterial(), []);
  const tilesRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = tilesRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const glow = new Float32Array(cells.length);
    cells.forEach((cell, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), cell.rotation);
      m.compose(new THREE.Vector3(cell.world.x, TILE_Y, cell.world.z), q, s);
      mesh.setMatrixAt(i, m);
      const tint = cell.tintArm !== null ? colors[cell.tintArm]! : NEUTRAL;
      const dim = cell.tintArm !== null && !active.has(cell.tintArm);
      mesh.setColorAt(i, dim ? tint.clone().lerp(new THREE.Color('#6d6790'), 0.55) : tint);
      glow[i] = cell.tintArm !== null ? (dim ? 0.1 : 0.5) : cell.safe ? 0.1 : 0;
    });
    mesh.geometry.setAttribute('aGlow', new THREE.InstancedBufferAttribute(glow, 1));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [cells, colors, active]);

  // ---- Star squares -----------------------------------------------------------
  const stars = useMemo(() => cells.filter((c) => c.star), [cells]);
  const starGeometry = useMemo(() => extrudeUp(starShape(0.3, 0.13), 0.04, 0.02, 2), []);
  const starsRef = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = starsRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    stars.forEach((cell, i) => {
      m.makeRotationY(cell.rotation);
      m.setPosition(cell.world.x, TILE_Y + 0.06, cell.world.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [stars]);

  // ---- Start-square emblems ----------------------------------------------------------
  const starts = useMemo(() => cells.filter((c) => c.start), [cells]);

  // ---- Yards ---------------------------------------------------------------------
  const yards = useMemo(() => {
    const big = board.armCount === 4;
    const half = big ? 2.55 : board.yardSlotSpread + 1.05;
    return colors.map((color, arm) => {
      const c = yardCenter(board, arm);
      const slots = [0, 1, 2, 3].map((slot) => baseSlotWorld(board, arm, slot));
      return { arm, color, center: c, half, rotation: armRotation(board, arm), slots };
    });
  }, [board, colors]);
  const yardGeometry = useMemo(() => {
    const half = yards[0]!.half;
    return extrudeUp(roundedRect(half, half, half * 0.32), 0.12, 0.06, 3);
  }, [yards]);
  const wellGeometry = useMemo(() => {
    const half = yards[0]!.half * 0.78;
    return extrudeUp(roundedRect(half, half, half * 0.3), 0.04, 0.02, 2);
  }, [yards]);

  // ---- Centre ---------------------------------------------------------------------
  const pyramid = useMemo(() => homePyramid(board, colors, 0.55), [board, colors]);
  const gemRef = useRef<THREE.Mesh>(null);
  const gemMat = useRef<THREE.MeshStandardMaterial>(null);

  // The board is static. The only motion here is the centre gem's brief
  // acknowledgement when a token reaches home (event-driven, ~0.9 s).
  useFrame(() => {
    const gem = gemRef.current;
    const mat = gemMat.current;
    if (!gem || !mat) return;
    const { color, at } = presentation.getState().homeFlash;
    const age = performance.now() - at;
    if (age < GEM_ACK_MS) {
      const k = Math.sin((age / GEM_ACK_MS) * Math.PI);
      gem.scale.setScalar(1 + k * 0.28);
      gem.rotation.y = GEM_YAW + (age / GEM_ACK_MS) * Math.PI * 0.5;
      mat.emissive.copy(GEM_EMISSIVE).lerp(TMP_COLOR.set(color), k);
      mat.emissiveIntensity = GEM_GLOW + k * 0.9;
    } else if (gem.scale.x !== 1) {
      gem.scale.setScalar(1);
      gem.rotation.y = GEM_YAW;
      mat.emissive.copy(GEM_EMISSIVE);
      mat.emissiveIntensity = GEM_GLOW;
    }
  });

  useEffect(
    () => () => {
      [slab, felt, rim, tileGeometry, starGeometry, yardGeometry, wellGeometry, pyramid].forEach((g) => g.dispose());
      tileMaterial.dispose();
      feltMaterial.dispose();
    },
    [slab, felt, rim, tileGeometry, starGeometry, yardGeometry, wellGeometry, pyramid, tileMaterial, feltMaterial],
  );

  const shadows = quality !== 'low';

  return (
    <group>
      {/* Lacquered slab */}
      <mesh geometry={slab} position-y={-0.77} receiveShadow={shadows}>
        <meshPhysicalMaterial color="#1c1548" roughness={0.42} metalness={0.25} clearcoat={0.8} clearcoatRoughness={0.25} />
      </mesh>
      {/* Brushed-gold trim (lit, not emissive, so it never blooms) */}
      <mesh geometry={rim} position-y={-0.1}>
        <meshStandardMaterial color="#d9b25c" metalness={0.85} roughness={0.35} />
      </mesh>
      {/* Playfield */}
      <mesh geometry={felt} material={feltMaterial} rotation-x={-Math.PI / 2} position-y={0.005} receiveShadow={shadows} />

      {/* Yards */}
      {yards.map((y) => {
        const dim = !active.has(y.arm);
        return (
          <group key={y.arm}>
            <group position={[y.center.x, 0.0, y.center.z]} rotation-y={y.rotation}>
              <mesh geometry={yardGeometry} receiveShadow={shadows} castShadow={false}>
                <meshPhysicalMaterial
                  color={dim ? y.color.clone().lerp(new THREE.Color('#3b3566'), 0.6) : y.color}
                  emissive={y.color}
                  emissiveIntensity={dim ? 0.02 : 0.08}
                  roughness={0.38}
                  clearcoat={0.6}
                  clearcoatRoughness={0.25}
                />
              </mesh>
              <mesh geometry={wellGeometry} position-y={0.16} receiveShadow={shadows}>
                <meshStandardMaterial
                  color={y.color.clone().lerp(new THREE.Color('#1a1442'), dim ? 0.92 : 0.78)}
                  roughness={0.45}
                  metalness={0.15}
                />
              </mesh>
            </group>
            {y.slots.map((s, i) => (
              <mesh key={i} position={[s.x, 0.205, s.z]} rotation-x={-Math.PI / 2}>
                <ringGeometry args={[0.27, 0.36, 40]} />
                <meshBasicMaterial color={y.color} transparent opacity={dim ? 0.25 : 0.75} />
              </mesh>
            ))}
          </group>
        );
      })}

      {/* Tiles */}
      <instancedMesh
        ref={tilesRef}
        args={[tileGeometry, tileMaterial, cells.length]}
        castShadow={false}
        receiveShadow={shadows}
        frustumCulled={false}
      />
      <instancedMesh ref={starsRef} args={[starGeometry, undefined, stars.length]} frustumCulled={false}>
        <meshStandardMaterial color="#ffc94d" emissive="#ff9b3d" emissiveIntensity={0.12} metalness={0.6} roughness={0.3} />
      </instancedMesh>
      {starts.map((cell) => (
        <mesh key={cell.coord.kind === 'track' ? cell.coord.index : 0} position={[cell.world.x, TILE_Y + 0.065, cell.world.z]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[0.18, 0.28, 32]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.85} />
        </mesh>
      ))}

      {/* Home pyramid + gem (static; see useFrame above for the home acknowledgement) */}
      <mesh geometry={pyramid} receiveShadow={shadows}>
        <meshStandardMaterial vertexColors roughness={0.4} metalness={0.15} />
      </mesh>
      <mesh ref={gemRef} position-y={0.95} rotation-y={GEM_YAW} castShadow={shadows}>
        <octahedronGeometry args={[0.3, 0]} />
        <meshStandardMaterial ref={gemMat} color="#fff2c4" emissive={GEM_EMISSIVE} emissiveIntensity={GEM_GLOW} metalness={0.3} roughness={0.25} />
      </mesh>
    </group>
  );
}
