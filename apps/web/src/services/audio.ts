/**
 * Sound manager. Every sound effect and the background music are synthesised at
 * runtime with the Web Audio API — no audio files, so nothing third-party is shipped.
 *
 * Graph: [voices] → sfxBus ─┐
 *                            ├→ master → destination
 *        [music]  → musicBus ┘   (music is low-passed and ducked under SFX)
 */
export type SoundName =
  | 'click'
  | 'diceRoll'
  | 'diceLand'
  | 'step'
  | 'capture'
  | 'extraTurn'
  | 'safe'
  | 'home'
  | 'win'
  | 'tick'
  | 'notify'
  | 'yourTurn'
  | 'error';

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private sfxEnabled = true;
  private musicEnabled = false;
  private sfxVolume = 0.8;
  private musicVolume = 0.35;
  private musicTimer: number | null = null;
  private nextBarTime = 0;
  private bar = 0;
  private readonly listeners = new Set<(unlocked: boolean) => void>();

  /** True once the browser allowed audio (after a user gesture). */
  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  onUnlockChange(fn: (unlocked: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emitUnlock(): void {
    const v = this.unlocked;
    this.listeners.forEach((l) => l(v));
  }

  /** Must be called from a user gesture at least once (autoplay policies). */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus = this.ctx.createGain();
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      this.musicBus.connect(lp).connect(this.master);
      this.noise = this.makeNoise();
      this.applyVolumes();
      this.ctx.addEventListener('statechange', () => this.emitUnlock());
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().then(() => this.emitUnlock(), () => undefined);
    else this.emitUnlock();
    if (this.musicEnabled) this.startMusic();
  }

  configure(opts: { sfx: boolean; music: boolean; sfxVolume: number; musicVolume: number }): void {
    this.sfxEnabled = opts.sfx;
    this.sfxVolume = opts.sfxVolume;
    this.musicVolume = opts.musicVolume;
    const wantMusic = opts.music;
    this.musicEnabled = wantMusic;
    this.applyVolumes();
    if (!this.ctx) return;
    if (wantMusic) this.startMusic();
    else this.stopMusic();
  }

  play(name: SoundName, opts: { pitch?: number } = {}): void {
    if (!this.ctx || !this.sfxEnabled || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime + 0.005;
    const p = opts.pitch ?? 1;
    this.duck(t);
    switch (name) {
      case 'click':
        this.tone({ t, freq: 880 * p, to: 620 * p, dur: 0.07, type: 'sine', gain: 0.25 });
        break;
      case 'diceRoll':
        for (let i = 0; i < 9; i += 1) {
          const at = t + i * 0.065 + Math.random() * 0.02;
          this.noiseBurst({ t: at, dur: 0.04, freq: 1800 + Math.random() * 2200, q: 4, gain: 0.35 - i * 0.025 });
        }
        break;
      case 'diceLand':
        this.tone({ t, freq: 150, to: 60, dur: 0.18, type: 'sine', gain: 0.6 });
        this.noiseBurst({ t, dur: 0.05, freq: 2500, q: 2, gain: 0.3 });
        break;
      case 'step':
        this.tone({ t, freq: 420 * p, to: 380 * p, dur: 0.09, type: 'triangle', gain: 0.3 });
        this.noiseBurst({ t, dur: 0.02, freq: 4000, q: 3, gain: 0.08 });
        break;
      case 'capture':
        this.noiseSweep(t, 0.45);
        this.tone({ t: t + 0.02, freq: 900, to: 90, dur: 0.42, type: 'sawtooth', gain: 0.22 });
        this.tone({ t: t + 0.05, freq: 220, to: 55, dur: 0.35, type: 'sine', gain: 0.5 });
        break;
      case 'extraTurn':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
          this.tone({ t: t + i * 0.07, freq: f, dur: 0.16, type: 'triangle', gain: 0.22 }),
        );
        break;
      case 'safe':
        this.tone({ t, freq: 1318.5, dur: 0.5, type: 'sine', gain: 0.18 });
        this.tone({ t, freq: 1975.5, dur: 0.35, type: 'sine', gain: 0.08 });
        break;
      case 'home':
        [783.99, 987.77, 1174.66, 1567.98, 1975.53].forEach((f, i) =>
          this.tone({ t: t + i * 0.06, freq: f, dur: 0.25, type: 'sine', gain: 0.18 }),
        );
        break;
      case 'win': {
        const melody = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5];
        const lengths = [0.14, 0.14, 0.14, 0.3, 0.14, 0.18, 0.7];
        let at = t;
        melody.forEach((f, i) => {
          this.tone({ t: at, freq: f, dur: lengths[i]! + 0.1, type: 'square', gain: 0.1 });
          this.tone({ t: at, freq: f / 2, dur: lengths[i]! + 0.1, type: 'triangle', gain: 0.16 });
          at += lengths[i]!;
        });
        break;
      }
      case 'tick':
        this.tone({ t, freq: 1200, dur: 0.04, type: 'square', gain: 0.07 });
        break;
      case 'notify':
        this.tone({ t, freq: 880, dur: 0.12, type: 'sine', gain: 0.2 });
        this.tone({ t: t + 0.12, freq: 1320, dur: 0.2, type: 'sine', gain: 0.2 });
        break;
      case 'yourTurn':
        this.tone({ t, freq: 659.25, dur: 0.12, type: 'triangle', gain: 0.22 });
        this.tone({ t: t + 0.1, freq: 987.77, dur: 0.22, type: 'triangle', gain: 0.22 });
        break;
      case 'error':
        this.tone({ t, freq: 220, to: 180, dur: 0.18, type: 'square', gain: 0.08 });
        break;
    }
  }

  // ---- Music: a slow generative pad + pluck arpeggio -------------------------------

  private startMusic(): void {
    if (!this.ctx || this.musicTimer !== null) return;
    this.nextBarTime = this.ctx.currentTime + 0.1;
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 250);
  }

  private stopMusic(): void {
    if (this.musicTimer !== null) window.clearInterval(this.musicTimer);
    this.musicTimer = null;
  }

  private scheduleMusic(): void {
    if (!this.ctx) return;
    // Am9 – Fmaj7 – Cadd9 – G6 (original, generic progression)
    const chords = [
      [220.0, 261.63, 329.63, 493.88],
      [174.61, 220.0, 261.63, 329.63],
      [130.81, 196.0, 261.63, 293.66],
      [196.0, 246.94, 293.66, 329.63],
    ];
    const barLen = 4.8;
    while (this.nextBarTime < this.ctx.currentTime + 1.5) {
      const chord = chords[this.bar % chords.length]!;
      const t = this.nextBarTime;
      chord.forEach((f, i) => this.pad(t, f * (i === 0 ? 0.5 : 1), barLen));
      for (let i = 0; i < 8; i += 1) {
        const f = chord[(i * 3 + this.bar) % chord.length]! * (i % 4 === 3 ? 2 : 1);
        this.tone({ t: t + i * (barLen / 8), freq: f * 2, dur: 0.5, type: 'sine', gain: 0.035, bus: 'music' });
      }
      this.nextBarTime += barLen;
      this.bar += 1;
    }
  }

  private pad(t: number, freq: number, dur: number): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.03, t + 1.2);
    g.gain.setValueAtTime(0.03, t + dur - 1.0);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.6);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    g.connect(f).connect(this.musicBus);
    for (const detune of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(g);
      o.start(t);
      o.stop(t + dur + 0.7);
    }
  }

  // ---- Synth primitives ---------------------------------------------------------------

  private tone(o: {
    t: number;
    freq: number;
    to?: number;
    dur: number;
    type: OscillatorType;
    gain: number;
    bus?: 'sfx' | 'music';
  }): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.freq, o.t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), o.t + o.dur);
    g.gain.setValueAtTime(0.0001, o.t);
    g.gain.exponentialRampToValueAtTime(o.gain, o.t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur);
    osc.connect(g).connect(o.bus === 'music' ? this.musicBus : this.sfxBus);
    osc.start(o.t);
    osc.stop(o.t + o.dur + 0.05);
  }

  private noiseBurst(o: { t: number; dur: number; freq: number; q: number; gain: number }): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = o.freq;
    bp.Q.value = o.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, o.gain), o.t);
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(o.t, Math.random() * 0.5);
    src.stop(o.t + o.dur + 0.02);
  }

  private noiseSweep(t: number, dur: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.5;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(5000, t + dur * 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** Briefly lower the music so gameplay sounds stay clear. */
  private duck(t: number): void {
    if (!this.musicEnabled) return;
    const g = this.musicBus.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(this.musicVolume * 0.45, t, 0.03);
    g.setTargetAtTime(this.musicVolume, t + 0.4, 0.4);
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    this.sfxBus.gain.value = this.sfxEnabled ? this.sfxVolume : 0;
    this.musicBus.gain.value = this.musicEnabled ? this.musicVolume : 0;
  }

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buf;
  }
}

export const audio = new AudioEngine();
