import type { AppError, GameEvent, GameSnapshotMessage, GameState, PlayerState } from '@ludo/shared-types';
import { applyEvent, applyEvents, finishProgress, createBoard, type ArmCount, isSafeSquare, progressToSquare } from '@ludo/game-engine';
import { audio } from '../services/audio';
import { haptic } from '../services/haptics';
import { useGame, selectCanAct } from '../store/gameStore';
import {
  addEffect,
  initialPresentation,
  presentation,
  type TokenVisual,
} from '../store/presentationStore';
import { useSettings } from '../store/settingsStore';
import { toast } from '../store/uiStore';
import { boardRotationFor, computePlacements, PLAYER_HEX, type Placement, progressPoint, tokenKey } from './layout';
import type { GameTransport } from './transport';

export const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

interface Timings {
  dice: number;
  step: number;
  release: number;
  capture: number;
  beat: number;
  finish: number;
}

function timings(): Timings {
  return useSettings.getState().reduceMotion
    ? { dice: 260, step: 70, release: 160, capture: 260, beat: 60, finish: 400 }
    : { dice: 950, step: 170, release: 430, capture: 760, beat: 240, finish: 1100 };
}

/** Friendly copy for action errors (never raw server text for internal errors). */
function friendly(err: AppError): string {
  return err.message || 'Something went wrong.';
}

/**
 * Consumes the authoritative event stream and plays it on the board one event at a
 * time. Authoritative state (`useGame.state`) updates immediately; the visual
 * state (`useGame.visual`) follows the animations.
 */
export class GameDirector {
  private queue: GameEvent[] = [];
  private processing = false;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private awaitingSeq: number | null = null;
  private pendingTimer: number | null = null;
  private emoteId = 1;
  private bannerId = 1;

  constructor(
    readonly transport: GameTransport,
    readonly myId: string,
  ) {}

  start(): void {
    presentation.setState(initialPresentation());
    useGame.setState({ mode: this.transport.mode, myId: this.myId, gone: false });
    this.unsubscribe = this.transport.subscribe({
      onSnapshot: (s) => this.onSnapshot(s),
      onEvents: (e) => this.onEvents(e),
      onFinish: (r) => useGame.setState({ rankings: r }),
      onPresence: (id, connected) => this.onPresence(id, connected),
      onPause: (paused, deadline) => this.onPause(paused, deadline),
      onEmote: (id, emote) => this.onEmote(id, emote),
      onGone: () => useGame.setState({ gone: true }),
    });
    this.transport.requestSnapshot();
  }

  stop(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.queue = [];
    if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
    useGame.getState().reset();
    presentation.setState(initialPresentation());
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  private onSnapshot(snap: Pick<GameSnapshotMessage, 'state' | 'connected' | 'paused'>): void {
    this.queue = [];
    const state = snap.state;
    useGame.setState({
      gameId: state.id,
      state,
      visual: state,
      connected: snap.connected,
      paused: snap.paused,
      animating: false,
      pending: false,
      rankings: state.status === 'finished' ? state.rankings : null,
    });
    this.awaitingSeq = null;
    const me = state.players.find((p) => p.id === this.myId);
    presentation.setState({
      armCount: state.armCount,
      rotation: boardRotationFor(state.armCount, me?.arm ?? state.players[0]?.arm ?? null),
      winnerId: state.status === 'finished' ? (state.rankings[0] ?? null) : null,
    });
    this.rebuildTokens(state, true);
    this.afterDrain();
  }

  private onEvents(events: GameEvent[]): void {
    const auth = useGame.getState().state;
    if (!auth) {
      this.transport.requestSnapshot();
      return;
    }
    const fresh = events.filter((e) => e.seq > auth.seq);
    if (fresh.length === 0) return;
    if (fresh[0]!.seq !== auth.seq + 1) {
      // Missed something (e.g. while reconnecting): resync from the authority.
      this.transport.requestSnapshot();
      return;
    }
    let next: GameState;
    try {
      next = applyEvents(auth, fresh);
    } catch {
      this.transport.requestSnapshot();
      return;
    }
    useGame.setState({ state: next, animating: true });
    if (this.awaitingSeq !== null && next.seq >= this.awaitingSeq) this.clearPending();
    this.queue.push(...fresh);
    void this.pump();
  }

  private onPresence(playerId: string, connected: boolean): void {
    useGame.setState((s) => ({ connected: { ...s.connected, [playerId]: connected } }));
    const name = useGame.getState().visual?.players.find((p) => p.id === playerId)?.name;
    if (name && playerId !== this.myId) toast(connected ? `${name} reconnected` : `${name} disconnected`, connected ? 'success' : 'warning');
  }

  private onPause(paused: boolean, deadline?: number | null): void {
    useGame.setState((s) => {
      if (paused || deadline === undefined || !s.state || !s.visual) return { paused };
      return {
        paused,
        state: { ...s.state, turn: { ...s.state.turn, deadline } },
        visual: { ...s.visual, turn: { ...s.visual.turn, deadline } },
      };
    });
  }

  private onEmote(playerId: string, emote: string): void {
    if (!useSettings.getState().showEmotes) return;
    const id = this.emoteId++;
    useGame.setState((s) => ({ emotes: [...s.emotes.slice(-6), { id, playerId, emote }] }));
    window.setTimeout(() => useGame.setState((s) => ({ emotes: s.emotes.filter((e) => e.id !== id) })), 2600);
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    useGame.setState({ animating: true });
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const event = this.queue.shift()!;
        // Fast-forward when far behind or when the tab is hidden.
        const skip = this.queue.length > 12 || document.hidden;
        await this.play(event, skip);
      }
    } finally {
      this.processing = false;
      if (!this.disposed) this.afterDrain();
    }
  }

  private wait(ms: number, skip: boolean): Promise<void> {
    if (skip || ms <= 0) return Promise.resolve();
    return new Promise((r) => window.setTimeout(r, ms));
  }

  private player(state: GameState, id: string | null): PlayerState | undefined {
    return id ? state.players.find((p) => p.id === id) : undefined;
  }

  private async play(e: GameEvent, skip: boolean): Promise<void> {
    const t = timings();
    const visual = useGame.getState().visual!;
    const actor = this.player(visual, e.playerId);
    const color = actor ? PLAYER_HEX[actor.color] : '#ffc94d';
    const isMe = e.playerId === this.myId;
    const sound = !skip;

    switch (e.type) {
      case 'DICE_ROLLED': {
        const prev = presentation.getState().dice;
        presentation.setState({
          dice: { value: e.payload.value, rollId: prev.rollId + 1, spinning: false, color, by: e.playerId },
          flash: { color, at: performance.now() },
        });
        if (sound && !prev.spinning) audio.play('diceRoll');
        await this.wait(t.dice, skip);
        if (sound) audio.play('diceLand');
        if (e.payload.value === 6 && sound) addEffect({ kind: 'sparkle', x: 0, y: 1.2, z: 0, color, dur: 700 });
        if (isMe && e.payload.movableTokens.length === 0 && !(e.payload.value === 6 && e.payload.consecutiveSixes >= 3)) {
          toast('No legal moves this time.', 'info', 1800);
        }
        break;
      }
      case 'TOKEN_MOVED': {
        const p = e.payload;
        const key = tokenKey(e.playerId!, p.tokenIndex);
        const after = applyEvent(visual, e);
        const placements = computePlacements(after);
        const token = presentation.getState().tokens[key];
        const from = token ? this.currentPosition(token) : progressPoint(visual.armCount, actor!.arm, p.from, p.tokenIndex);
        const points: Placement[] = [from];
        p.path.forEach((progress) => points.push(progressPoint(visual.armCount, actor!.arm, progress, p.tokenIndex)));
        points[points.length - 1] = placements.get(key) ?? points[points.length - 1]!;
        const stepMs = p.kind === 'release' ? t.release : t.step;
        const total = stepMs * p.path.length;
        if (!skip) {
          this.patchToken(key, { anim: { kind: 'path', points, start: performance.now(), stepMs, hop: p.kind === 'release' ? 0.9 : 0.42 } });
          presentation.setState({ focus: { x: points[points.length - 1]!.x, z: points[points.length - 1]!.z, at: performance.now() } });
          p.path.forEach((_, i) =>
            window.setTimeout(() => {
              audio.play('step', { pitch: 1 + i * 0.06 });
              const pt = points[i + 1]!;
              addEffect({ kind: 'ring', x: pt.x, y: pt.y, z: pt.z, color, dur: 450 });
            }, stepMs * (i + 1) - 10),
          );
        }
        await this.wait(total + 40, skip);
        useGame.setState({ visual: after });
        this.applyPlacements(after, placements);
        const board = createBoard(visual.armCount as ArmCount);
        const square = progressToSquare(board, actor!.arm, p.to);
        const last = points[points.length - 1]!;
        if (p.to >= finishProgress(board)) {
          if (sound) audio.play('home');
          addEffect({ kind: 'home', x: last.x, y: last.y, z: last.z, color, dur: 1200 });
        } else if (square !== null && isSafeSquare(board, square) && p.kind !== 'release') {
          if (sound) audio.play('safe');
        }
        return;
      }
      case 'TOKEN_CAPTURED': {
        const v = e.payload.victim;
        const key = tokenKey(v.playerId, v.tokenIndex);
        const after = applyEvent(visual, e);
        const placements = computePlacements(after);
        const token = presentation.getState().tokens[key];
        const from = token ? this.currentPosition(token) : progressPoint(visual.armCount, actor!.arm, e.payload.from);
        const to = placements.get(key)!;
        const attacker = this.player(visual, e.payload.by.playerId);
        const attackColor = attacker ? PLAYER_HEX[attacker.color] : color;
        addEffect({ kind: 'burst', x: from.x, y: from.y + 0.3, z: from.z, color: attackColor, dur: 900 });
        presentation.setState({ shake: performance.now(), flash: { color: attackColor, at: performance.now() } });
        if (sound) audio.play('capture');
        if (e.payload.by.playerId === this.myId || v.playerId === this.myId) haptic('capture');
        if (!skip) {
          this.patchToken(key, { anim: { kind: 'capture', points: [from, to], start: performance.now() + 120, stepMs: t.capture, hop: 2.2 } });
        }
        await this.wait(t.capture + 160, skip);
        useGame.setState({ visual: after });
        this.applyPlacements(after, placements);
        if (e.payload.by.playerId === this.myId) this.showBanner('Captured!', `${actor?.name ?? 'Token'} sent home`, attackColor);
        else if (v.playerId === this.myId) this.showBanner('Ouch!', 'Your token was captured', color);
        return;
      }
      case 'EXTRA_TURN':
        if (isMe) {
          const why = e.payload.reasons.includes('capture') ? 'for the capture' : e.payload.reasons.includes('home') ? 'for reaching home' : 'for rolling a 6';
          this.showBanner('Extra turn!', why, color);
        }
        if (sound) audio.play('extraTurn');
        break;
      case 'TURN_PENALTY':
        this.showBanner('Three sixes!', `${actor?.name ?? 'Player'} loses the turn`, '#ff5d73');
        if (sound) audio.play('error');
        await this.wait(t.beat * 2, skip);
        break;
      case 'TURN_TIMEOUT':
        if (isMe) toast("Time's up — the server played your turn.", 'warning');
        break;
      case 'TURN_CHANGED':
        await this.wait(t.beat, skip);
        if (e.payload.playerId === this.myId) {
          if (sound) audio.play('yourTurn');
          haptic('yourTurn');
        }
        break;
      case 'PLAYER_FINISHED':
        this.showBanner(
          isMe ? 'You finished!' : `${actor?.name ?? 'Player'} finished`,
          `${ORDINAL[e.payload.rank - 1] ?? `#${e.payload.rank}`} place`,
          color,
        );
        if (sound) audio.play('home');
        await this.wait(t.finish, skip);
        break;
      case 'PLAYER_FORFEITED':
        if (!isMe) toast(`${actor?.name ?? 'A player'} left the game`, 'warning');
        break;
      case 'GAME_FINISHED':
        presentation.setState({ winnerId: e.payload.winnerId, celebrateAt: performance.now() });
        if (sound) audio.play('win');
        if (e.payload.winnerId === this.myId) haptic('win');
        break;
    }
    const next = applyEvent(visual, e);
    useGame.setState({ visual: next });
    if (e.type === 'PLAYER_FORFEITED' || e.type === 'GAME_FINISHED') this.applyPlacements(next, computePlacements(next));
    this.updateCurrent(next);
  }

  private afterDrain(): void {
    const g = useGame.getState();
    useGame.setState({ animating: false });
    const v = g.visual;
    if (!v) return;
    this.updateCurrent(v);
    const can = selectCanAct(useGame.getState());
    presentation.setState({
      selectable: can && v.turn.phase === 'move' ? v.turn.legalMoves.map((m) => tokenKey(this.myId, m.tokenIndex)) : [],
    });
    this.transport.notifyIdle(v.seq);
  }

  private updateCurrent(v: GameState): void {
    const current = v.players.find((p) => p.id === v.turn.playerId);
    if (current) presentation.setState({ currentColor: PLAYER_HEX[current.color] });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async roll(): Promise<void> {
    const g = useGame.getState();
    if (!selectCanAct(g) || g.visual!.turn.phase !== 'roll') return;
    // setPending() runs synchronously, so a second tap in the same frame is ignored above.
    this.setPending();
    haptic('roll');
    const me = g.visual!.players.find((p) => p.id === this.myId)!;
    presentation.setState((s) => ({ dice: { ...s.dice, spinning: true, color: PLAYER_HEX[me.color], by: this.myId } }));
    audio.play('diceRoll');
    const r = await this.transport.roll(g.state!.seq);
    this.handleAck(r);
  }

  async move(tokenIndex: number): Promise<void> {
    const g = useGame.getState();
    if (!selectCanAct(g) || g.visual!.turn.phase !== 'move') return;
    if (!g.visual!.turn.legalMoves.some((m) => m.tokenIndex === tokenIndex)) {
      toast('That token cannot move with this roll.', 'info', 1600);
      return;
    }
    this.setPending();
    haptic('select');
    presentation.setState({ selectable: [], selected: { key: tokenKey(this.myId, tokenIndex), at: performance.now() } });
    const r = await this.transport.move(tokenIndex, g.state!.seq);
    this.handleAck(r);
  }

  async emote(emote: string): Promise<void> {
    const r = await this.transport.emote(emote);
    if (!r.ok && r.error.code !== 'RATE_LIMITED') toast(friendly(r.error), 'error');
  }

  private setPending(): void {
    useGame.setState({ pending: true });
    if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
    // Safety net: if the result never arrives, resync rather than freezing the UI.
    this.pendingTimer = window.setTimeout(() => {
      if (useGame.getState().pending) {
        this.clearPending();
        this.transport.requestSnapshot();
      }
    }, 10_000);
  }

  private clearPending(): void {
    this.awaitingSeq = null;
    if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    useGame.setState({ pending: false });
  }

  private handleAck(r: { ok: true; seq?: number } | { ok: false; error: AppError }): void {
    if (r.ok) {
      const seq = r.seq;
      // Stay "pending" until the resulting events have arrived.
      if (seq !== undefined && (useGame.getState().state?.seq ?? 0) < seq) {
        this.awaitingSeq = seq;
        return;
      }
      this.clearPending();
      return;
    }
    this.clearPending();
    presentation.setState((s) => ({ dice: { ...s.dice, spinning: false } }));
    audio.play('error');
    if (r.error.code === 'STALE_STATE' || r.error.code === 'WRONG_PHASE') {
      this.transport.requestSnapshot();
      return;
    }
    toast(friendly(r.error), 'error');
    this.afterDrain();
  }

  // ---------------------------------------------------------------------------
  // Presentation helpers
  // ---------------------------------------------------------------------------

  private showBanner(text: string, sub: string, color: string): void {
    const id = this.bannerId++;
    useGame.setState({ banner: { id, text, sub, color } });
    window.setTimeout(() => {
      if (useGame.getState().banner?.id === id) useGame.setState({ banner: null });
    }, 1700);
  }

  private currentPosition(token: TokenVisual): Placement {
    // Animations finish on their final point, which becomes the new rest position.
    return token.rest;
  }

  private patchToken(key: string, patch: Partial<TokenVisual>): void {
    presentation.setState((s) => {
      const t = s.tokens[key];
      if (!t) return {};
      return { tokens: { ...s.tokens, [key]: { ...t, ...patch } } };
    });
  }

  private rebuildTokens(state: GameState, snap: boolean): void {
    const placements = computePlacements(state);
    const finish = finishProgress(createBoard(state.armCount as ArmCount));
    const tokens: Record<string, TokenVisual> = {};
    for (const p of state.players) {
      p.tokens.forEach((progress, index) => {
        const key = tokenKey(p.id, index);
        tokens[key] = {
          key,
          playerId: p.id,
          index,
          color: PLAYER_HEX[p.color],
          rest: placements.get(key)!,
          anim: snap ? null : (presentation.getState().tokens[key]?.anim ?? null),
          finished: progress >= finish,
          out: p.status === 'forfeited',
        };
      });
    }
    presentation.setState({ tokens, tokenKeys: Object.keys(tokens) });
  }

  private applyPlacements(state: GameState, placements: Map<string, Placement>): void {
    const finish = finishProgress(createBoard(state.armCount as ArmCount));
    presentation.setState((s) => {
      const tokens = { ...s.tokens };
      for (const p of state.players) {
        p.tokens.forEach((progress, index) => {
          const key = tokenKey(p.id, index);
          const prev = tokens[key];
          if (!prev) return;
          tokens[key] = { ...prev, rest: placements.get(key) ?? prev.rest, finished: progress >= finish, out: p.status === 'forfeited' };
        });
      }
      return { tokens };
    });
  }
}
