import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { createGame } from '@ludo/game-engine';
import { computePlacements, PLAYER_HEX, progressPoint, tokenKey } from '../game/layout';
import { initialPresentation, presentation } from '../store/presentationStore';
import { useSettings } from '../store/settingsStore';
import { Board } from './Board';
import { Tokens } from './Tokens';

/**
 * Self-playing demo for the landing page: a few tokens hop around the real track
 * using the same Board/Token components and layout maths as the game.
 */
function DemoDriver() {
  const progress = useRef<number[]>([0, 6, 13, 19, 26, 32, 39, 45]);
  const last = useRef(0);
  const demo = useMemo(
    () => createGame({ id: 'demo', players: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, avatar: 'comet', kind: 'human' as const })), now: 0 }),
    [],
  );

  useEffect(() => {
    // Two tokens per player on the track, the rest in base.
    demo.players.forEach((p, i) => {
      p.tokens = [progress.current[i * 2]!, progress.current[i * 2 + 1]!, -1, -1];
    });
    const placements = computePlacements(demo);
    const tokens: ReturnType<typeof initialPresentation>['tokens'] = {};
    demo.players.forEach((p) =>
      p.tokens.forEach((_, i) => {
        const key = tokenKey(p.id, i);
        tokens[key] = { key, playerId: p.id, index: i, color: PLAYER_HEX[p.color], rest: placements.get(key)!, anim: null, finished: false, out: false };
      }),
    );
    presentation.setState({ ...initialPresentation(), tokens, tokenKeys: Object.keys(tokens) });
    return () => presentation.setState(initialPresentation());
  }, [demo]);

  useFrame(() => {
    const now = performance.now();
    if (now - last.current < 1300 || useSettings.getState().reduceMotion) return;
    last.current = now;
    const which = Math.floor(Math.random() * 8);
    const player = demo.players[Math.floor(which / 2)]!;
    const index = which % 2;
    const from = player.tokens[index]!;
    const steps = 1 + Math.floor(Math.random() * 6);
    const to = (from + steps) % 50;
    const key = tokenKey(player.id, index);
    const s = presentation.getState();
    const t = s.tokens[key];
    if (!t) return;
    const points = [t.rest];
    for (let k = 1; k <= steps; k += 1) points.push(progressPoint(4, player.arm, (from + k) % 50));
    player.tokens[index] = to;
    const placements = computePlacements(demo);
    points[points.length - 1] = placements.get(key)!;
    const tokens = { ...s.tokens };
    for (const [k, v] of Object.entries(tokens)) tokens[k] = { ...v, rest: placements.get(k) ?? v.rest };
    tokens[key] = { ...tokens[key]!, anim: { kind: 'path', points, start: now, stepMs: 170, hop: 0.42 } };
    presentation.setState({ tokens, currentColor: PLAYER_HEX[player.color] });
  });
  return null;
}

export default function LandingBoard() {
  const reduce = useSettings((s) => s.reduceMotion);
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ fov: 34, position: [0, 21, 21] }}
      gl={{ alpha: true, antialias: true }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
      }}
    >
      <ambientLight intensity={0.4} color="#9a90ff" />
      <hemisphereLight args={['#c8c0ff', '#1a0f3a', 0.6]} />
      <directionalLight position={[6, 16, 9]} intensity={2} castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-12} shadow-camera-right={12} shadow-camera-top={12} shadow-camera-bottom={-12} />
      <pointLight position={[-9, 6, 4]} intensity={18} color="#ff5fc8" distance={30} />
      <pointLight position={[9, 6, -4]} intensity={18} color="#2fe0e8" distance={30} />
      <group rotation-y={Math.PI / 4}>
        <Board armCount={4} quality="medium" />
        <Tokens onSelect={() => undefined} />
      </group>
      <DemoDriver />
      <OrbitControls
        enablePan={false}
        enableZoom={false}
        autoRotate={!reduce}
        autoRotateSpeed={0.6}
        minPolarAngle={0.5}
        maxPolarAngle={1.1}
      />
    </Canvas>
  );
}
