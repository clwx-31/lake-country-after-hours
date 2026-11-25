// All sound is synthesized at runtime with Web Audio (nothing is fetched):
// engine voices per drivetrain, tires, wind, impacts, sirens, ability cues, a
// layered pursuit score, and the garage radio.
import type { EngineVoice } from '../sim/cars';
import { Music } from './Music';

export interface EngineState {
  rpm: number;
  redline: number;
  idle: number;
  throttle: number;
  speed: number;
  squeal: number;
  nitro: boolean;
  boost: number; // ability thrust 0..1
  load: number;
}

export interface SirenVoice {
  id: number;
  dist: number;
  pan: number;
  closing: number; // m/s toward listener
  yelp: boolean;
}

function noiseBuffer(ctx: BaseAudioContext, seconds = 2) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function shaper(ctx: BaseAudioContext, amount: number) {
  const ws = ctx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  ws.curve = curve;
  return ws;
}

class EngineSynth {
  readonly out: GainNode;
  private o1: OscillatorNode;
  private o2: OscillatorNode;
  private o3: OscillatorNode;
  private g1: GainNode;
  private g2: GainNode;
  private g3: GainNode;
  private noiseGain: GainNode;
  private noiseFilter: BiquadFilterNode;
  private lp: BiquadFilterNode;
  private lfo: OscillatorNode;
  private lfoGain: GainNode;
  private whistle: GainNode;
  private whistleFilter: BiquadFilterNode;
  private lastThrottle = 0;

  constructor(private ctx: AudioContext, dest: AudioNode, readonly voice: EngineVoice, private cyl: number, noise: AudioBuffer) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = voice === 'v8' ? 2.5 : 1.2;
    const sh = shaper(ctx, voice === 'v8' ? 3.2 : voice === 'ev' ? 1.0 : 2.0);
    sh.connect(this.lp);
    this.lp.connect(this.out);
    const ev = voice === 'ev';
    this.o1 = ctx.createOscillator();
    this.o1.type = ev ? 'sine' : 'sawtooth';
    this.o2 = ctx.createOscillator();
    this.o2.type = ev ? 'sine' : voice === 'v8' ? 'square' : 'sawtooth';
    this.o3 = ctx.createOscillator();
    this.o3.type = ev ? 'triangle' : 'square';
    this.g1 = ctx.createGain();
    this.g2 = ctx.createGain();
    this.g3 = ctx.createGain();
    this.o1.connect(this.g1).connect(sh);
    this.o2.connect(this.g2).connect(sh);
    this.o3.connect(this.g3).connect(sh);
    // V8 lope: amplitude wobble at a quarter of the firing rate.
    this.lfo = ctx.createOscillator();
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = voice === 'v8' ? 0.35 : voice === 'v6' ? 0.1 : 0.05;
    this.lfo.connect(this.lfoGain).connect(this.g1.gain);
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.Q.value = 1.4;
    this.noiseGain = ctx.createGain();
    n.connect(this.noiseFilter).connect(this.noiseGain).connect(this.lp);
    // Turbo whistle / EV inverter shimmer.
    const w = ctx.createBufferSource();
    w.buffer = noise;
    w.loop = true;
    this.whistleFilter = ctx.createBiquadFilter();
    this.whistleFilter.type = 'bandpass';
    this.whistleFilter.Q.value = 18;
    this.whistle = ctx.createGain();
    this.whistle.gain.value = 0;
    w.connect(this.whistleFilter).connect(this.whistle).connect(this.out);
    for (const o of [this.o1, this.o2, this.o3, this.lfo]) o.start();
    n.start();
    w.start();
  }

  update(s: EngineState, master: number) {
    const t = this.ctx.currentTime;
    const k = 0.04;
    if (this.voice === 'ev') {
      // Motor whine follows wheel speed, not revs; a distinct rising tone.
      const f = 140 + s.speed * 62;
      this.o1.frequency.setTargetAtTime(f, t, k);
      this.o2.frequency.setTargetAtTime(f * 3.02, t, k);
      this.o3.frequency.setTargetAtTime(f * 0.5, t, k);
      this.g1.gain.setTargetAtTime(0.18 + s.throttle * 0.25, t, k);
      this.g2.gain.setTargetAtTime(0.05 + s.throttle * 0.12 + s.boost * 0.25, t, k);
      this.g3.gain.setTargetAtTime(0.08, t, k);
      this.lp.frequency.setTargetAtTime(1800 + s.throttle * 3000 + s.boost * 4000, t, k);
      this.noiseFilter.frequency.setTargetAtTime(600 + s.speed * 40, t, k);
      this.noiseGain.gain.setTargetAtTime(0.03 + s.speed * 0.002, t, k);
      this.whistleFilter.frequency.setTargetAtTime(f * 6.1, t, k);
      this.whistle.gain.setTargetAtTime((0.02 + s.boost * 0.12) * Math.min(1, s.speed / 6), t, k);
      this.out.gain.setTargetAtTime(master * (0.2 + Math.min(1, s.speed / 30) * 0.5 + s.throttle * 0.2), t, 0.05);
      return;
    }
    const fire = (s.rpm / 60) * (this.cyl / 2);
    this.o1.frequency.setTargetAtTime(fire, t, k);
    this.o2.frequency.setTargetAtTime(this.voice === 'v8' ? fire * 0.5 : fire * 2, t, k);
    this.o3.frequency.setTargetAtTime(fire * (this.voice === 'v10' ? 2 : 1.5), t, k);
    this.lfo.frequency.setTargetAtTime(fire / 4, t, k);
    const r = s.rpm / s.redline;
    const v = this.voice;
    this.g1.gain.setTargetAtTime(0.35 + s.throttle * 0.25, t, k);
    this.g2.gain.setTargetAtTime(v === 'v8' ? 0.45 : 0.12 + r * 0.1, t, k);
    this.g3.gain.setTargetAtTime(v === 'v10' ? 0.18 + r * 0.25 : v === 'i4' || v === 'turbo4' ? 0.15 : 0.06, t, k);
    const base = v === 'v8' ? 260 : v === 'v10' ? 700 : 450;
    this.lp.frequency.setTargetAtTime(base + s.throttle * (v === 'v10' ? 4200 : 2600) + r * 1400, t, k);
    this.noiseFilter.frequency.setTargetAtTime(fire * 2.2, t, k);
    this.noiseGain.gain.setTargetAtTime(0.05 + s.throttle * 0.22, t, k);
    if (v === 'turbo4') {
      const boost = Math.max(0, s.throttle * r - 0.15);
      this.whistleFilter.frequency.setTargetAtTime(2600 + boost * 5200, t, 0.08);
      this.whistle.gain.setTargetAtTime(boost * 0.22, t, 0.08);
      if (this.lastThrottle > 0.6 && s.throttle < 0.1 && r > 0.45) this.blowOff();
    }
    this.lastThrottle = s.throttle;
    this.out.gain.setTargetAtTime(master * (0.28 + s.throttle * 0.42 + r * 0.2), t, 0.05);
  }

  private blowOff() {
    const t = this.ctx.currentTime;
    this.whistleFilter.frequency.setValueAtTime(5200, t);
    this.whistleFilter.frequency.exponentialRampToValueAtTime(900, t + 0.35);
    this.whistle.gain.setValueAtTime(0.3, t);
    this.whistle.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  }

  stop() {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.05);
    setTimeout(() => {
      for (const o of [this.o1, this.o2, this.o3, this.lfo]) { try { o.stop(); } catch { /* already stopped */ } }
      this.out.disconnect();
    }, 400);
  }
}

class Siren {
  readonly out: GainNode;
  private osc: OscillatorNode;
  private pan: StereoPannerNode;
  private phase = Math.random() * 10;
  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.osc.connect(lp).connect(this.out).connect(this.pan).connect(dest);
    this.osc.start();
  }
  update(dt: number, v: SirenVoice | null) {
    const t = this.ctx.currentTime;
    if (!v) { this.out.gain.setTargetAtTime(0, t, 0.1); return; }
    this.phase += dt;
    const sweep = v.yelp ? 0.5 + 0.5 * Math.sin(this.phase * 2 * Math.PI * 3.2) : 0.5 - 0.5 * Math.cos(this.phase * 2 * Math.PI / 3.4);
    const doppler = 1 + Math.max(-0.2, Math.min(0.2, v.closing / 343));
    this.osc.frequency.setTargetAtTime((640 + sweep * 760) * doppler, t, 0.02);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, v.pan)), t, 0.05);
    this.out.gain.setTargetAtTime(0.16 / (1 + (v.dist / 45) ** 2), t, 0.08);
  }
}

export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private engineBus!: GainNode;
  private sfxBus!: GainNode;
  private noise!: AudioBuffer;
  private engine: EngineSynth | null = null;
  private squealGain!: GainNode;
  private windGain!: GainNode;
  private nitroGain!: GainNode;
  private sirens: Siren[] = [];
  music: Music | null = null;
  radio: Music | null = null;
  private radioGain!: GainNode;
  private radioFilter!: BiquadFilterNode;
  private radioPan!: StereoPannerNode;
  volumes = { master: 0.8, music: 0.6, engine: 0.75, effects: 0.8 };
  slowmo = false;
  private slowFilter!: BiquadFilterNode;
  unlocked = false;

  /** Must run from a user gesture (browser autoplay policy). */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.unlocked = true;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 3;
    this.slowFilter = ctx.createBiquadFilter();
    this.slowFilter.type = 'lowpass';
    this.slowFilter.frequency.value = 20000;
    this.master = ctx.createGain();
    this.master.connect(this.slowFilter).connect(comp).connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.engineBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.engineBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.noise = noiseBuffer(ctx);
    const loopNoise = (type: BiquadFilterType, f: number, q: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = type;
      filt.frequency.value = f;
      filt.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(filt).connect(g).connect(this.sfxBus);
      src.start();
      return g;
    };
    this.squealGain = loopNoise('bandpass', 1150, 7);
    this.windGain = loopNoise('lowpass', 420, 0.7);
    this.nitroGain = loopNoise('highpass', 1800, 0.7);
    for (let i = 0; i < 2; i++) this.sirens.push(new Siren(ctx, this.sfxBus));
    this.music = new Music(ctx, this.musicBus, 'score');
    // Garage radio: band-limited and positional.
    this.radioFilter = ctx.createBiquadFilter();
    this.radioFilter.type = 'bandpass';
    this.radioFilter.frequency.value = 1300;
    this.radioFilter.Q.value = 0.8;
    this.radioGain = ctx.createGain();
    this.radioGain.gain.value = 0;
    this.radioPan = ctx.createStereoPanner();
    const radioIn = ctx.createGain();
    radioIn.connect(this.radioFilter).connect(shaper(ctx, 1.6)).connect(this.radioGain).connect(this.radioPan).connect(this.musicBus);
    this.radio = new Music(ctx, radioIn, 'radio');
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.volumes.music, t, 0.05);
    this.engineBus.gain.setTargetAtTime(this.volumes.engine, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volumes.effects, t, 0.05);
  }

  setEngine(voice: EngineVoice, cylinders: number) {
    if (!this.ctx) return;
    if (this.engine?.voice === voice) return;
    this.engine?.stop();
    this.engine = new EngineSynth(this.ctx, this.engineBus, voice, cylinders || 4, this.noise);
  }

  /** Pause: duck everything but leave the context alive. */
  setPaused(p: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(p ? this.volumes.master * 0.25 : this.volumes.master, t, 0.08);
    this.engineBus.gain.setTargetAtTime(p ? 0 : this.volumes.engine, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(p ? 0 : this.volumes.effects, t, 0.05);
  }

  update(dt: number, s: EngineState | null, sirens: SirenVoice[], heatLayers: number, searchFade: number) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    if (this.engine && s) this.engine.update(s, 1);
    if (s) {
      this.squealGain.gain.setTargetAtTime(s.squeal * 0.35, t, 0.05);
      this.windGain.gain.setTargetAtTime(Math.min(0.4, (s.speed / 45) ** 2 * 0.4), t, 0.1);
      this.nitroGain.gain.setTargetAtTime(s.nitro ? 0.12 : 0, t, 0.05);
    }
    this.sirens.forEach((sv, i) => sv.update(dt, sirens[i] ?? null));
    this.slowFilter.frequency.setTargetAtTime(this.slowmo ? 900 : 20000, t, 0.1);
    this.music?.setLayers(heatLayers, searchFade);
    this.music?.tick();
    this.radio?.tick();
  }

  /** Radio volume from listener distance; `door` 0 closed .. 1 open. */
  setRadio(dist: number, pan: number, door: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = (0.55 / (1 + (dist / 14) ** 2)) * (0.08 + 0.92 * door);
    this.radioGain.gain.setTargetAtTime(g, t, 0.15);
    this.radioFilter.frequency.setTargetAtTime(600 + 900 * door, t, 0.2);
    this.radioPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.1);
  }

  /** One-shot effects. */
  cue(name: string, strength = 1) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const env = (g: GainNode, a: number, peak: number, d: number) => {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    };
    const tone = (type: OscillatorType, f0: number, f1: number, dur: number, peak: number, at = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      o.frequency.setValueAtTime(f0, t + at);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + at + dur);
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(peak, t + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(g).connect(this.sfxBus);
      o.start(t + at);
      o.stop(t + at + dur + 0.05);
    };
    const burst = (type: BiquadFilterType, f: number, dur: number, peak: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const filt = ctx.createBiquadFilter();
      filt.type = type;
      filt.frequency.value = f;
      const g = ctx.createGain();
      env(g, 0.005, peak, dur);
      src.connect(filt).connect(g).connect(this.sfxBus);
      src.start(t, Math.random());
      src.stop(t + dur + 0.1);
    };
    switch (name) {
      case 'impact': {
        const k = Math.min(1, strength);
        burst('lowpass', 900 + k * 1800, 0.25 + k * 0.3, 0.2 + k * 0.6);
        tone('sine', 120, 40, 0.35, 0.3 + k * 0.4);
        break;
      }
      case 'scrape': burst('bandpass', 2600, 0.18, 0.12); break;
      case 'apex': tone('square', 900, 1800, 0.12, 0.12); tone('sine', 1800, 2400, 0.25, 0.1, 0.08); break;
      case 'bank': burst('highpass', 1200, 0.6, 0.25); tone('sawtooth', 200, 700, 0.6, 0.12); break;
      case 'surge': tone('sawtooth', 60, 140, 0.9, 0.3); burst('lowpass', 400, 0.8, 0.3); break;
      case 'overclock': tone('sine', 600, 3800, 0.7, 0.18); tone('triangle', 1200, 7600, 0.7, 0.06); break;
      case 'hop': tone('sine', 180, 420, 0.25, 0.3); break;
      case 'land-clean': tone('sine', 90, 50, 0.2, 0.4); break;
      case 'land-rough': burst('lowpass', 700, 0.4, 0.6); tone('sine', 80, 40, 0.3, 0.5); break;
      case 'focus': tone('sine', 1400, 200, 0.8, 0.2); burst('bandpass', 500, 0.8, 0.15); break;
      case 'focus-end': tone('sine', 200, 1200, 0.4, 0.12); break;
      case 'nitro': burst('highpass', 2000, 0.4, 0.2); break;
      case 'count': tone('square', 660, 660, 0.12, 0.1); break;
      case 'go': tone('square', 990, 990, 0.35, 0.12); break;
      case 'check': tone('sine', 880, 880, 0.1, 0.15); tone('sine', 1320, 1320, 0.18, 0.12, 0.08); break;
      case 'gate': tone('sawtooth', 220, 880, 0.4, 0.12); break;
      case 'miss': tone('square', 200, 140, 0.25, 0.1); break;
      case 'case': tone('triangle', 330, 300, 0.15, 0.12); burst('bandpass', 3000, 0.08, 0.15); break;
      case 'star': tone('sawtooth', 440, 440, 0.15, 0.1); tone('sawtooth', 587, 587, 0.2, 0.1, 0.12); break;
      case 'escape': for (let i = 0; i < 4; i++) tone('sine', 523 * 2 ** (i / 4), 523 * 2 ** (i / 4), 0.3, 0.1, i * 0.1); break;
      case 'busted': tone('sawtooth', 300, 80, 1.2, 0.2); break;
      case 'medal': for (let i = 0; i < 5; i++) tone('triangle', [392, 494, 587, 784, 988][i], [392, 494, 587, 784, 988][i], 0.5, 0.12, i * 0.09); break;
      case 'click': tone('sine', 1200, 900, 0.05, 0.06); break;
      case 'door': burst('lowpass', 300, 1.4, 0.25); tone('sine', 70, 50, 1.2, 0.15); break;
      // Kart drift: hop, spark tiers rising in pitch, mini-turbo whoosh.
      case 'drift': tone('sine', 220, 330, 0.08, 0.12); break;
      case 'tier1': tone('square', 1046, 1046, 0.07, 0.06); break;
      case 'tier2': tone('square', 1318, 1318, 0.07, 0.07); tone('square', 1568, 1568, 0.06, 0.05, 0.05); break;
      case 'tier3': tone('square', 1568, 1568, 0.06, 0.07); tone('square', 2093, 2093, 0.1, 0.06, 0.05); break;
      case 'boost': burst('highpass', 1600, 0.55, 0.28); tone('sawtooth', 160, 520, 0.45, 0.12); break;
      case 'cancel': burst('bandpass', 900, 0.15, 0.1); break;
      case 'jump': tone('sine', 300, 520, 0.18, 0.08); break;
      case 'land': burst('lowpass', 500, 0.25, 0.45); tone('sine', 90, 45, 0.25, 0.35); break;
      case 'air': for (let i = 0; i < 3; i++) tone('triangle', 660 * 2 ** (i / 3), 660 * 2 ** (i / 3), 0.18, 0.09, i * 0.06); break;
      case 'radar': tone('square', 1760, 1760, 0.06, 0.05); tone('square', 1760, 1760, 0.06, 0.05, 0.12); break;
      // Police weapons and damage.
      case 'gunshot': burst('highpass', 1800, 0.07, 0.5 * strength); burst('bandpass', 400, 0.12, 0.35 * strength); break;
      case 'tirepop': burst('bandpass', 900, 0.12, 0.6); burst('highpass', 3000, 0.5, 0.18); break;
      case 'launch': burst('lowpass', 700, 0.5, 0.45); tone('sawtooth', 90, 260, 0.6, 0.12); break;
      case 'explosion': burst('lowpass', 220, 1.6, 0.9 * strength); burst('bandpass', 600, 0.5, 0.5 * strength); tone('sine', 60, 28, 1.2, 0.6 * strength); break;
      case 'lockbeep': tone('square', 2200, 2200, 0.05, 0.07); break;
      case 'rotor': burst('lowpass', 140, 0.06, 0.5 * strength); break;
      // Abilities.
      case 'superstar': for (let i = 0; i < 6; i++) tone('square', 523 * 2 ** (i / 6), 1046 * 2 ** (i / 6), 0.12, 0.07, i * 0.07); break;
      case 'grapple': tone('sawtooth', 1600, 300, 0.22, 0.1); burst('bandpass', 2400, 0.12, 0.2); break;
      case 'grapple-release': tone('sine', 300, 900, 0.2, 0.12); break;
      case 'phantom': tone('sine', 900, 300, 0.7, 0.14); tone('triangle', 1350, 450, 0.7, 0.06); break;
      case 'shockwave': burst('lowpass', 180, 1.0, 0.9); tone('sine', 120, 30, 0.9, 0.4); break;
      case 'oilSlick': burst('lowpass', 500, 0.5, 0.35); tone('sine', 140, 90, 0.4, 0.15); break;
      case 'caltrops': for (let i = 0; i < 5; i++) tone('square', 2400 + i * 180, 2000, 0.04, 0.05, i * 0.04); break;
      case 'smokeScreen': burst('highpass', 900, 1.2, 0.3); break;
      case 'patchKit': case 'repaired': tone('triangle', 660, 990, 0.18, 0.12); tone('triangle', 990, 1320, 0.2, 0.1, 0.12); break;
      case 'bubbleShield': tone('sine', 400, 1200, 0.5, 0.15); break;
      case 'shield-hit': tone('sine', 1500, 600, 0.25, 0.2); burst('bandpass', 3000, 0.15, 0.2); break;
      case 'glider': burst('highpass', 1200, 0.5, 0.25); tone('sine', 300, 600, 0.5, 0.1); break;
      case 'blink': tone('sine', 2600, 200, 0.25, 0.2); tone('sine', 200, 2600, 0.25, 0.1, 0.1); break;
      case 'tripleBoost': burst('highpass', 1600, 0.4, 0.25); tone('sawtooth', 200, 700, 0.35, 0.12); break;
      case 'homingMissile': burst('lowpass', 900, 0.4, 0.35); tone('sawtooth', 300, 1200, 0.4, 0.1); break;
      case 'emp': tone('square', 120, 60, 0.6, 0.2); tone('sine', 3000, 100, 0.6, 0.12); break;
      case 'moonJump': tone('sine', 150, 900, 0.45, 0.3); break;
      case 'timeWarp': tone('sine', 1200, 150, 1.0, 0.2); tone('triangle', 600, 75, 1.0, 0.1); break;
      case 'ability-miss': tone('square', 260, 180, 0.15, 0.08); break;
      case 'totaled': burst('lowpass', 300, 1.2, 0.7); tone('sawtooth', 160, 40, 1.4, 0.25); break;
    }
  }
}
