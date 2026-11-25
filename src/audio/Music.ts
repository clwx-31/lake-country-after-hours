// Original generative instrumental: clean, spacious Karplus-Strong guitar and a
// synthesized live-style kit. Layers fade in with heat and strip away as the
// search meter clears. The same engine plays a different tune on the garage radio.

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** Plucked string via Karplus-Strong, rendered once into a buffer. */
function pluck(ctx: BaseAudioContext, midi: number, seconds: number, bright: number, rate = 24000) {
  const n = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  const period = Math.max(2, Math.round(rate / midiHz(midi)));
  const ring = new Float32Array(period);
  for (let i = 0; i < period; i++) ring[i] = (Math.random() * 2 - 1) * (0.6 + 0.4 * Math.sin((i / period) * Math.PI));
  let idx = 0;
  let prev = 0;
  const decay = 0.996 - (midi > 64 ? 0.002 : 0);
  for (let i = 0; i < n; i++) {
    const cur = ring[idx];
    const next = ring[(idx + 1) % period];
    const v = (cur * bright + next * (1 - bright)) * decay;
    ring[idx] = v;
    d[i] = cur * 0.6 + prev * 0.4;
    prev = cur;
    idx = (idx + 1) % period;
  }
  // gentle fade at the tail
  for (let i = Math.max(0, n - 400); i < n; i++) d[i] *= (n - i) / 400;
  return buf;
}

function drum(ctx: BaseAudioContext, kind: string, rate = 32000) {
  const len = kind === 'crash' ? 2.2 : kind === 'ride' ? 1.4 : kind === 'ohat' ? 0.45 : kind === 'kick' ? 0.5 : kind.startsWith('tom') ? 0.6 : 0.3;
  const n = Math.floor(rate * len);
  const buf = ctx.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  let lp = 0, hp = 0, prevIn = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const r = Math.random() * 2 - 1;
    let v = 0;
    switch (kind) {
      case 'kick': {
        const f = 48 + 110 * Math.exp(-t * 28);
        v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 7) + r * 0.25 * Math.exp(-t * 90);
        break;
      }
      case 'snare': {
        lp += (r - lp) * 0.45;
        v = lp * Math.exp(-t * 16) * 0.9 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 22) * 0.6;
        break;
      }
      case 'ghost': {
        lp += (r - lp) * 0.45;
        v = lp * Math.exp(-t * 30) * 0.3;
        break;
      }
      case 'hat': case 'ohat': {
        hp = 0.92 * (hp + r - prevIn);
        prevIn = r;
        v = hp * Math.exp(-t * (kind === 'hat' ? 60 : 9)) * 0.5;
        break;
      }
      case 'ride': {
        hp = 0.9 * (hp + r - prevIn);
        prevIn = r;
        const ping = Math.sin(2 * Math.PI * 520 * t) + Math.sin(2 * Math.PI * 1347 * t) * 0.6 + Math.sin(2 * Math.PI * 2210 * t) * 0.4;
        v = (hp * 0.25 + ping * 0.12) * Math.exp(-t * 3.2);
        break;
      }
      case 'crash': {
        hp = 0.9 * (hp + r - prevIn);
        prevIn = r;
        v = hp * Math.exp(-t * 1.7) * 0.6;
        break;
      }
      case 'tom1': case 'tom2': {
        const base = kind === 'tom1' ? 150 : 105;
        const f = base + 40 * Math.exp(-t * 20);
        v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 8) + r * 0.1 * Math.exp(-t * 40);
        break;
      }
    }
    d[i] = v;
  }
  return buf;
}

function impulse(ctx: BaseAudioContext, seconds: number) {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * seconds);
  const b = ctx.createBuffer(2, n, rate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2.6;
  }
  return b;
}

type Mode = 'score' | 'radio';

// Chords as guitar voicings (MIDI), 2 bars each in the score.
const SCORE_CHORDS = [
  { bass: 40, notes: [52, 55, 59, 62, 66] }, // Em9
  { bass: 36, notes: [52, 55, 59, 64, 67] }, // Cmaj7
  { bass: 43, notes: [50, 55, 59, 62, 64] }, // G6
  { bass: 42, notes: [50, 54, 57, 62, 66] }, // D/F#
  { bass: 45, notes: [52, 55, 60, 64, 67] }, // Am7
  { bass: 36, notes: [52, 55, 59, 64, 71] }, // Cmaj7
  { bass: 40, notes: [52, 55, 59, 64, 67] }, // Em
  { bass: 47, notes: [51, 54, 59, 64, 66] }, // B7sus
];
const RADIO_CHORDS = [
  { bass: 45, notes: [57, 60, 64, 69] }, // A
  { bass: 50, notes: [57, 62, 66, 69] }, // D
  { bass: 52, notes: [56, 59, 64, 68] }, // E
  { bass: 50, notes: [57, 62, 66, 69] }, // D
];
const LEAD = [71, 69, 67, 66, 64, 66, 67, 71, 74, 71, 69, 67, 69, 66, 64, -1];

export class Music {
  private layerGains: GainNode[] = [];
  private targets = [1, 0, 0, 0, 0, 0];
  private step = 0;
  private nextTime = 0;
  private plucks = new Map<number, AudioBuffer>();
  private kit = new Map<string, AudioBuffer>();
  private ready = false;
  readonly bpm: number;
  private delay: DelayNode;

  constructor(private ctx: AudioContext, dest: AudioNode, private mode: Mode) {
    this.bpm = mode === 'score' ? 112 : 96;
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, mode === 'score' ? 2.8 : 0.9);
    const wet = ctx.createGain();
    wet.gain.value = mode === 'score' ? 0.38 : 0.15;
    const dry = ctx.createGain();
    dry.gain.value = 0.9;
    const bus = ctx.createGain();
    bus.connect(dry).connect(dest);
    bus.connect(verb).connect(wet).connect(dest);
    // Dotted-eighth delay for the clean guitar.
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = (60 / this.bpm) * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.36;
    const delayOut = ctx.createGain();
    delayOut.gain.value = 0.32;
    this.delay.connect(fb).connect(this.delay);
    this.delay.connect(delayOut).connect(bus);
    for (let i = 0; i < 6; i++) {
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 1 : 0;
      g.connect(bus);
      if (i === 0 || i === 4) g.connect(this.delay);
      this.layerGains.push(g);
    }
    if (mode === 'radio') this.targets = [1, 1, 1, 0, 0, 0];
    // Render instrument buffers in small chunks to avoid a long stall.
    const notes = new Set<number>();
    const chords = mode === 'score' ? SCORE_CHORDS : RADIO_CHORDS;
    for (const c of chords) { c.notes.forEach((n) => notes.add(n)); notes.add(c.bass); notes.add(c.bass + 12); }
    LEAD.forEach((n) => n > 0 && notes.add(n));
    const list = [...notes];
    const kitNames = ['kick', 'snare', 'ghost', 'hat', 'ohat', 'ride', 'crash', 'tom1', 'tom2'];
    let i = 0;
    const work = () => {
      const end = Math.min(list.length, i + 6);
      for (; i < end; i++) this.plucks.set(list[i], pluck(ctx, list[i], list[i] < 48 ? 2.2 : 2.6, 0.5));
      if (i < list.length) setTimeout(work, 0);
      else {
        for (const k of kitNames) this.kit.set(k, drum(ctx, k));
        this.ready = true;
        this.nextTime = ctx.currentTime + 0.1;
      }
    };
    setTimeout(work, 0);
  }

  setLayers(heatLayers: number, searchFade: number) {
    if (this.mode === 'radio') return;
    for (let i = 1; i < 6; i++) {
      const on = i <= heatLayers ? 1 : 0;
      // Searching strips drums and leads first as the meter shrinks.
      this.targets[i] = on * (i >= 2 ? searchFade : Math.max(0.5, searchFade));
    }
    this.targets[0] = heatLayers >= 3 ? 0.55 : 1;
  }

  private play(buf: AudioBuffer | undefined, when: number, layer: number, gain: number, rate = 1) {
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.layerGains[layer]);
    src.start(when);
  }

  private bassNote(midi: number, when: number, dur: number, gain: number) {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiHz(midi);
    const o2 = this.ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = midiHz(midi) * 0.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g);
    o2.connect(g);
    g.connect(this.layerGains[1]);
    o.start(when);
    o2.start(when);
    o.stop(when + dur + 0.05);
    o2.stop(when + dur + 0.05);
  }

  private pad(notes: number[], when: number, dur: number) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.035, when + dur * 0.4);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    g.connect(lp).connect(this.layerGains[5]);
    for (const n of notes) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiHz(n + 12);
      o.detune.value = (Math.random() - 0.5) * 12;
      o.connect(g);
      o.start(when);
      o.stop(when + dur + 0.05);
    }
  }

  tick() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (let i = 0; i < 6; i++) this.layerGains[i].gain.setTargetAtTime(this.targets[i], t, i >= 2 ? 0.4 : 0.8);
    if (this.nextTime < t - 0.5) this.nextTime = t + 0.05;
    const sixteenth = 60 / this.bpm / 4;
    while (this.nextTime < t + 0.15) {
      this.schedule(this.step, this.nextTime);
      this.nextTime += sixteenth;
      this.step++;
    }
  }

  private schedule(step: number, when: number) {
    const human = () => (Math.random() - 0.5) * 0.012;
    const s16 = step % 16;
    const bar = Math.floor(step / 16);
    if (this.mode === 'radio') {
      const chord = RADIO_CHORDS[bar % RADIO_CHORDS.length];
      if (s16 % 2 === 0) this.play(this.plucks.get(chord.notes[(s16 / 2) % chord.notes.length]), when + human(), 0, 0.35);
      if (s16 === 0 || s16 === 8) this.bassNote(chord.bass - 12, when, 0.5, 0.25);
      if (s16 % 8 === 4) this.play(this.kit.get('snare'), when, 2, 0.35);
      if (s16 % 8 === 0) this.play(this.kit.get('kick'), when, 2, 0.5);
      if (s16 % 2 === 0) this.play(this.kit.get('hat'), when, 2, 0.15);
      return;
    }
    const chord = SCORE_CHORDS[Math.floor(bar / 2) % SCORE_CHORDS.length];
    // L0: spacious arpeggio, one note per eighth, ringing.
    if (s16 % 2 === 0) {
      const pattern = [0, 2, 4, 3, 1, 3, 4, 2];
      const n = chord.notes[pattern[(s16 / 2) % 8] % chord.notes.length];
      this.play(this.plucks.get(n), when + human(), 0, 0.32 + (s16 === 0 ? 0.08 : 0));
    }
    // L1: bass and a muted chug on eighths.
    if (s16 === 0 || s16 === 10) this.bassNote(chord.bass, when, 0.6, 0.32);
    if (s16 === 6 || s16 === 14) this.bassNote(chord.bass + 12, when, 0.25, 0.18);
    if (s16 % 2 === 0) this.play(this.plucks.get(chord.notes[0]), when + human(), 1, 0.12, 1);
    // L2: kick, snare backbeat, eighth hats.
    if (s16 === 0 || s16 === 10) this.play(this.kit.get('kick'), when + human(), 2, 0.85);
    if (s16 === 4 || s16 === 12) this.play(this.kit.get('snare'), when + human(), 2, 0.6 + Math.random() * 0.1);
    if (s16 % 2 === 0) this.play(this.kit.get('hat'), when + human(), 2, 0.18 + (s16 % 4 === 0 ? 0.06 : 0));
    // L3: busier kit — sixteenth hats, ghost notes, tom fill every 4 bars.
    if (s16 % 2 === 1) this.play(this.kit.get('hat'), when + human(), 3, 0.1);
    if (s16 === 7 || s16 === 15) this.play(this.kit.get('ghost'), when + human(), 3, 0.5);
    if (s16 === 14 && bar % 2 === 1) this.play(this.kit.get('ohat'), when, 3, 0.2);
    if (bar % 4 === 3 && s16 >= 12) this.play(this.kit.get(s16 < 14 ? 'tom1' : 'tom2'), when + human(), 3, 0.55);
    // L4: lead melody with delay.
    if (s16 % 4 === 0) {
      const n = LEAD[(bar * 4 + s16 / 4) % LEAD.length];
      if (n > 0) this.play(this.plucks.get(n), when + human(), 4, 0.3);
    }
    // L5: crescendo — pad, crash on the one, ride quarters.
    if (s16 === 0 && bar % 2 === 0) this.pad(chord.notes.slice(0, 4), when, (60 / this.bpm) * 8);
    if (s16 === 0) this.play(this.kit.get('crash'), when, 5, 0.3);
    if (s16 % 4 === 0) this.play(this.kit.get('ride'), when + human(), 5, 0.25);
  }
}
