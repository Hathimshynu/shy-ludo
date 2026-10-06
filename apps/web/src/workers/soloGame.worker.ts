/// <reference lib="webworker" />
import { seededRandom } from '@ludo/game-engine';
import { type HostInbound, LocalGameHost } from '../game/localHost';

declare const self: DedicatedWorkerGlobalScope;

// End-to-end test builds only (VITE_E2E is never set for production, so this branch is
// compiled away): a seed passed in the worker name makes solo dice and AI reproducible.
const seed = import.meta.env.VITE_E2E === 'true' ? Number.parseInt(self.name.replace(/^ludo-e2e-seed:/, ''), 10) : Number.NaN;
const host = new LocalGameHost((msg) => self.postMessage(msg), Number.isFinite(seed) ? { random: seededRandom(seed) } : {});
self.onmessage = (e: MessageEvent<HostInbound>) => host.handle(e.data);
