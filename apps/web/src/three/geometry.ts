import * as THREE from 'three';
import { type BoardGeometry, armAngle, yardDirection } from '@ludo/game-engine';

/**
 * Board shapes are authored in board space (x right, z towards the viewer) and
 * converted to THREE.Shape space (x, y = -z), then extruded and rotated so the
 * extrusion points up (+Y).
 */
export const toShape = (x: number, z: number) => new THREE.Vector2(x, -z);

export function roundedPolygon(points: THREE.Vector2[], radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n]!;
    const cur = points[i]!;
    const next = points[(i + 1) % n]!;
    const toPrev = prev.clone().sub(cur).normalize();
    const toNext = next.clone().sub(cur).normalize();
    const r = Math.min(radius, cur.distanceTo(prev) / 2, cur.distanceTo(next) / 2);
    const a = cur.clone().add(toPrev.multiplyScalar(r));
    const b = cur.clone().add(toNext.multiplyScalar(r));
    if (i === 0) shape.moveTo(a.x, a.y);
    else shape.lineTo(a.x, a.y);
    shape.quadraticCurveTo(cur.x, cur.y, b.x, b.y);
  }
  shape.closePath();
  return shape;
}

/** Regular polygon whose edges face the arms (so arms point at edge midpoints). */
export function boardOutline(board: BoardGeometry, apothem: number): THREE.Vector2[] {
  const R = apothem / Math.cos(Math.PI / board.armCount);
  const pts: THREE.Vector2[] = [];
  for (let a = 0; a < board.armCount; a += 1) {
    const d = yardDirection(board, a);
    pts.push(toShape(d.x * R, d.z * R));
  }
  return pts;
}

/** Extrude a shape upward from y=0 to y=depth (+bevel). */
export function extrudeUp(shape: THREE.Shape, depth: number, bevel = 0, segments = 4): THREE.ExtrudeGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: segments,
    curveSegments: 24,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function roundedRect(halfW: number, halfH: number, radius: number): THREE.Shape {
  return roundedPolygon(
    [new THREE.Vector2(-halfW, -halfH), new THREE.Vector2(halfW, -halfH), new THREE.Vector2(halfW, halfH), new THREE.Vector2(-halfW, halfH)],
    radius,
  );
}

export function starShape(outer: number, inner: number, points = 5): THREE.Shape {
  const shape = new THREE.Shape();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/**
 * Low pyramid in the centre: one coloured triangular face per arm, meeting at a
 * raised apex. Vertex-coloured so it is a single draw call.
 */
export function homePyramid(board: BoardGeometry, colors: THREE.Color[], apexHeight: number): THREE.BufferGeometry {
  const A = board.armCount;
  const R = (board.innerRadius / Math.cos(Math.PI / A)) * 0.985;
  const positions: number[] = [];
  const cols: number[] = [];
  for (let a = 0; a < A; a += 1) {
    const c1 = yardDirection(board, (a - 1 + A) % A);
    const c2 = yardDirection(board, a);
    const color = colors[a]!;
    // Apex, corner (counter-clockwise when viewed from above so normals point up).
    const verts = [
      [0, apexHeight, 0],
      [c2.x * R, 0.02, c2.z * R],
      [c1.x * R, 0.02, c1.z * R],
    ];
    for (const v of verts) {
      positions.push(v[0]!, v[1]!, v[2]!);
      cols.push(color.r, color.g, color.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  // Make sure faces point upward regardless of winding.
  const normals = geo.getAttribute('normal') as THREE.BufferAttribute;
  if (normals.getY(0) < 0) {
    for (let i = 0; i < positions.length / 9; i += 1) {
      const idx = i * 3;
      const tmp = [positions[(idx + 1) * 3], positions[(idx + 1) * 3 + 1], positions[(idx + 1) * 3 + 2]];
      for (let k = 0; k < 3; k += 1) positions[(idx + 1) * 3 + k] = positions[(idx + 2) * 3 + k]!;
      for (let k = 0; k < 3; k += 1) positions[(idx + 2) * 3 + k] = tmp[k]!;
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
  }
  return geo;
}

export function armRotation(board: BoardGeometry, arm: number): number {
  return -armAngle(board, arm);
}

/**
 * Tile material: standard PBR with (a) per-instance colour glow and (b) light pulses
 * that travel clockwise around the track — the board's signature animated path.
 */
export function createTileMaterial(): THREE.MeshStandardMaterial & { userData: { uniforms: { uTime: { value: number } } } } {
  const uniforms = { uTime: { value: 0 } };
  const material = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.05 });
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader =
      'attribute float aTrack;\nattribute float aGlow;\nvarying float vTrack;\nvarying float vGlow;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTrack = aTrack;\nvGlow = aGlow;');
    shader.fragmentShader =
      'uniform float uTime;\nvarying float vTrack;\nvarying float vGlow;\n' +
      shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #if defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR )
          totalEmissiveRadiance += vColor.rgb * vGlow * 0.42;
        #endif
        if (vTrack >= 0.0) {
          float d = mod(uTime * 5.0 - vTrack, 13.0);
          float pulse = exp(-d * 0.55);
          totalEmissiveRadiance += vec3(0.62, 0.52, 1.0) * pulse * 0.32;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'ludo-tile-v1';
  return material as THREE.MeshStandardMaterial & { userData: { uniforms: { uTime: { value: number } } } };
}

/** Soft radial-gradient playfield with faint slowly rotating rings. */
export function createFeltMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uInner: { value: new THREE.Color('#3a2f86') }, uOuter: { value: new THREE.Color('#15103a') } },
    vertexShader: `varying vec2 vPos; void main(){ vPos = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uInner; uniform vec3 uOuter; varying vec2 vPos;
      void main(){
        float r = length(vPos);
        vec3 col = mix(uInner, uOuter, smoothstep(0.0, 11.0, r));
        float rings = smoothstep(0.92, 1.0, sin(r * 3.2 - uTime * 0.6)) * 0.06 * (1.0 - smoothstep(4.0, 11.0, r));
        float ang = atan(vPos.y, vPos.x);
        float rays = pow(max(0.0, sin(ang * 8.0 + uTime * 0.15)), 18.0) * 0.04 * (1.0 - smoothstep(1.0, 10.0, r));
        gl_FragColor = vec4(col + vec3(0.6, 0.5, 1.0) * (rings + rays), 1.0);
        #include <colorspace_fragment>
      }`,
  });
}
