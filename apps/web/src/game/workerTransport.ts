import type { AckResult, GameState } from '@ludo/shared-types';
import type { HostInbound, HostOutbound, SoloConfig } from './localHost';
import type { GameTransport, TransportHandlers } from './transport';

const SAVE_KEY = 'ludo-nova:solo';

export interface SavedSolo {
  config: SoloConfig;
  state: GameState;
}

export function loadSavedSolo(): SavedSolo | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? (JSON.parse(raw) as SavedSolo) : null;
  } catch {
    return null;
  }
}

export function clearSavedSolo(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

/** Solo games: the engine + AI run in a Web Worker; this adapts it to GameTransport. */
export class WorkerTransport implements GameTransport {
  readonly mode = 'solo' as const;
  private readonly worker: Worker;
  private handlers: TransportHandlers | null = null;
  private nextRequest = 1;
  private readonly pending = new Map<number, (r: AckResult<{ seq?: number }>) => void>();

  constructor(
    private readonly config: SoloConfig,
    resume: GameState | null,
  ) {
    this.worker = new Worker(new URL('../workers/soloGame.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<HostOutbound>) => this.receive(e.data);
    this.send({ type: 'init', config, saved: resume });
  }

  private send(msg: HostInbound): void {
    this.worker.postMessage(msg);
  }

  private receive(msg: HostOutbound): void {
    switch (msg.type) {
      case 'snapshot':
        this.handlers?.onSnapshot({ state: msg.state, connected: {}, paused: false });
        break;
      case 'events':
        this.handlers?.onEvents(msg.events);
        break;
      case 'finish':
        this.handlers?.onFinish(msg.rankings);
        break;
      case 'ack':
        this.pending.get(msg.requestId)?.(msg.result);
        this.pending.delete(msg.requestId);
        break;
      case 'save':
        try {
          if (msg.state) localStorage.setItem(SAVE_KEY, JSON.stringify({ config: this.config, state: msg.state }));
          else localStorage.removeItem(SAVE_KEY);
        } catch {
          /* storage unavailable: solo still works, just not resumable */
        }
        break;
    }
  }

  subscribe(handlers: TransportHandlers): () => void {
    this.handlers = handlers;
    return () => {
      this.handlers = null;
    };
  }

  dispose(): void {
    this.handlers = null;
    this.pending.clear();
    this.worker.terminate();
  }

  requestSnapshot(): void {
    this.send({ type: 'sync' });
  }

  private request(build: (requestId: number) => HostInbound): Promise<AckResult<{ seq?: number }>> {
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.send(build(requestId));
    });
  }

  roll(expectedSeq: number): Promise<AckResult<{ seq?: number }>> {
    return this.request((requestId) => ({ type: 'roll', requestId, expectedSeq }));
  }

  move(tokenIndex: number, expectedSeq: number): Promise<AckResult<{ seq?: number }>> {
    return this.request((requestId) => ({ type: 'move', requestId, expectedSeq, tokenIndex }));
  }

  async leave(): Promise<void> {
    clearSavedSolo();
  }

  async emote(): Promise<AckResult> {
    return { ok: true };
  }

  notifyIdle(seq: number): void {
    this.send({ type: 'idle', seq });
  }

  now(): number {
    return Date.now();
  }
}
