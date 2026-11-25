// Playable event rules. Timers run on real (unpaused) seconds so Focus slow
// motion never stretches a scored clock.
import * as THREE from 'three';
import type { District } from '../map/District';
import { REHEARSAL, VENUE, venueFrame } from '../map/places';
import type { MiniMarker } from '../ui/Hud';
import type { Medal, Ghost } from '../save/Save';
import type { Contact, StaticWorld } from '../sim/Physics';
import type { HeatState } from '../sim/heat';
import type { Vehicle } from '../sim/Vehicle';
import type { Ability } from '../sim/abilities';
import { CARS, type CarId } from '../sim/cars';
import type { DifficultyLevel } from '../game/difficulty';
import type { Skill } from '../sim/AIDriver';
import { Course } from './Course';
import { ENCORE_PRIZES, EVENTS, airScore, lastSetPayout, medalFor, type EventDef, type EventId, type EventKind } from './defs';
import { beacon, boostPad, floorBox, gate, setGateColor, textSprite } from './visuals';

export interface Racer {
  v: Vehicle;
  progress: number;
}

export interface GhostRunner {
  model: THREE.Object3D;
}

export interface EventHost {
  d: District;
  /** Surface height at a point (terrain or deck). */
  groundAt(x: number, z: number): number;
  /** Current difficulty (rival pace, time limits, cargo damage). */
  difficulty: DifficultyLevel;
  scene: THREE.Scene;
  statics: StaticWorld;
  heat: HeatState;
  player: Vehicle;
  ability: Ability;
  carId: CarId;
  frozen: boolean;
  placePlayer(x: number, z: number, h: number, speed?: number): void;
  addRacer(id: CarId, paint: string, path: number[], skill: Skill, x: number, z: number, h: number, loop?: boolean): Racer;
  removeRacer(r: Racer): void;
  showGhost(g: Ghost | null): void;
  ghostTime(t: number): void;
  gpsRoute(x: number, z: number): number[] | null;
  confirmPressed(): boolean;
  cue(name: string): void;
  finishEvent(run: EventRun, result: EventResult): void;
  toast(big: string, small?: string, seconds?: number): void;
  /** Call off every unit and clear the heat (a chase event is over). */
  endPursuit(): void;
}

export interface EventResult {
  outcome: 'win' | 'complete' | 'fail' | 'invalid' | 'banked';
  headline: string;
  detail: string;
  score: number | null;
  scoreText: string;
  payout: number;
  medal: Medal | null;
  lines: [string, string][];
  ghost?: Ghost;
  splits?: number[];
  time?: number;
}

let attemptCounter = 0;
export const fmtTime = (t: number) => {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000), s = (cs % 6000) / 100;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

export abstract class EventRun {
  readonly attemptId: string;
  readonly def: EventDef;
  state: 'countdown' | 'running' | 'done' = 'countdown';
  countdown = 3;
  time = 0;
  readonly group = new THREE.Group();
  protected low: number[] = []; // static segment ids to disable on dispose
  protected lastGo = 3;
  /** Online race grid slot (0 = pole); staggered pairs, 8 m apart. */
  gridSlot = 0;
  protected get gridRow() { return Math.floor(this.gridSlot / 2); }
  protected get gridSide() { return this.gridSlot % 2 ? 1 : -1; }

  constructor(protected host: EventHost, id: EventId, kind: EventKind) {
    this.def = EVENTS[id];
    if (!this.def || this.def.kind !== kind) throw new Error(`event ${id} is not a ${kind} on this map`);
    this.attemptId = `${id}-${Date.now().toString(36)}-${(attemptCounter++).toString(36)}`;
    host.scene.add(this.group);
  }

  abstract begin(): void;
  protected abstract tick(dt: number): void;
  abstract hud(): string;
  abstract markers(): MiniMarker[];
  route(): number[] | null {
    return null;
  }

  /** How far along the run is, for live online standings (bigger is better). */
  raceProgress(): number {
    return 0;
  }

  frame(dt: number) {
    if (this.state === 'countdown') {
      this.host.frozen = true;
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n !== this.lastGo && n > 0) {
        this.lastGo = n;
        this.host.toast(String(n), this.def.name, 0.9);
        this.host.cue('count');
      }
      if (this.countdown <= 0) {
        this.state = 'running';
        this.host.frozen = false;
        this.host.toast('GO', '', 0.8);
        this.host.cue('go');
        this.onGo();
      }
      return;
    }
    if (this.state === 'running') {
      this.time += dt;
      this.tick(dt);
    }
  }

  protected onGo() {}
  onContact(_c: Contact) {}
  /** The player landed after `air` seconds airborne at `speed` m/s. */
  onLand(_air: number, _speed: number) {}
  onCaught() {}

  /** The car was totaled: the run is over. */
  onTotaled() {
    if (this.state === 'done') return;
    this.end({
      outcome: 'fail', headline: 'Car totaled', detail: 'The run ends here. Reset at the garage and try again.',
      score: null, scoreText: '—', payout: 0, medal: null, lines: [['Elapsed', fmtTime(this.time)]],
    });
  }

  /** Recovering to the road during a timed event invalidates the attempt. */
  onRecover() {
    if (this.state === 'done') return;
    this.end({
      outcome: 'invalid', headline: 'Attempt invalidated', detail: 'Recovering to the road resets the clock. Retry for a counted run.',
      score: null, scoreText: '—', payout: 0, medal: null, lines: [['Elapsed', fmtTime(this.time)]],
    });
  }

  protected end(result: EventResult) {
    if (this.state === 'done') return;
    this.state = 'done';
    this.host.frozen = false;
    this.host.finishEvent(this, result);
  }

  abort() {
    this.state = 'done';
    this.host.frozen = false;
  }

  dispose() {
    this.host.scene.remove(this.group);
    for (const id of this.low) this.host.statics.disabled.add(id);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh || (o as THREE.Sprite).isSprite) {
        m.geometry?.dispose();
      }
    });
  }

  protected place(obj: THREE.Object3D, x: number, z: number, h: number) {
    obj.position.set(x, this.host.groundAt(x, z), z);
    obj.rotation.y = h;
    this.group.add(obj);
    return obj;
  }

  protected gy(x: number, z: number) {
    return this.host.groundAt(x, z);
  }

  /** Place a flat road item, pitched to the slope along heading h. */
  protected placeOnRoad(obj: THREE.Object3D, x: number, z: number, h: number) {
    const fx = Math.sin(h), fz = Math.cos(h);
    const ahead = this.gy(x + fx * 2.5, z + fz * 2.5), behind = this.gy(x - fx * 2.5, z - fz * 2.5);
    obj.position.set(x, (ahead + behind) / 2, z);
    obj.rotation.order = 'YXZ';
    obj.rotation.y = h;
    obj.rotation.x = -Math.atan2(ahead - behind, 5);
    this.group.add(obj);
    return obj;
  }
}

/** Boost pads along a course: driving over one fires a short boost. */
class PadSet {
  private pads: { x: number; z: number; h: number }[] = [];
  /** Per-car cooldowns so the rival and the player never share a pad's timer. */
  private cool = new Map<Vehicle, Float32Array>();
  constructor(run: { placePad(o: THREE.Object3D, x: number, z: number, h: number): void }, course: Course, spots: { s: number; lateral: number }[]) {
    for (const { s, lateral } of spots) {
      const p = course.pose(s, lateral);
      this.pads.push({ x: p.x, z: p.z, h: p.h });
      run.placePad(boostPad(), p.x, p.z, p.h);
    }
  }
  update(v: Vehicle, dt: number) {
    let cool = this.cool.get(v);
    if (!cool) this.cool.set(v, (cool = new Float32Array(this.pads.length)));
    this.pads.forEach((pad, i) => {
      cool![i] = Math.max(0, cool![i] - dt);
      if (cool![i] > 0 || v.airborne) return;
      const dx = v.x - pad.x, dz = v.z - pad.z;
      const f = dx * Math.sin(pad.h) + dz * Math.cos(pad.h);
      const r = -dx * Math.cos(pad.h) + dz * Math.sin(pad.h);
      if (Math.abs(f) < 3 && Math.abs(r) < 2.4) {
        v.addBoost(1.1, 9);
        cool![i] = 2;
      }
    });
  }
}

/** Pad spots: the middle of every straight longer than `minGap` meters, alternating sides. */
function padSpots(course: Course, from: number, to: number, minGap = 150) {
  const marks = [from, ...course.corners(0.45, 12).map((c) => c.s).filter((s) => s > from && s < to), to];
  const out: { s: number; lateral: number }[] = [];
  for (let i = 1; i < marks.length; i++) {
    if (marks[i] - marks[i - 1] < minGap) continue;
    const s = (marks[i] + marks[i - 1]) / 2;
    out.push({ s, lateral: (out.length % 2 ? 1 : -1) * Math.max(1.2, course.widthAt(s) / 4) });
  }
  return out;
}

/** Tracks unwrapped arc-length progress of a car around an open or looped course. */
export class Progress {
  s = 0;
  lateral = 0;
  constructor(private course: Course, private loop: boolean, start: number) {
    this.s = start;
  }
  update(x: number, z: number) {
    const L = this.course.length;
    const local = this.loop ? ((this.s % L) + L) % L : this.s;
    const pr = this.course.path.project(x, z, Math.max(0, local - 25), local + 70);
    let pr2 = pr;
    if (this.loop && local > L - 70) {
      const wrap = this.course.path.project(x, z, 0, 70);
      if (wrap.d < pr.d) pr2 = { ...wrap, s: wrap.s + L };
    }
    let delta = pr2.s - local;
    if (this.loop) {
      if (delta > L / 2) delta -= L;
      if (delta < -L / 2) delta += L;
    }
    if (pr2.d < 40 && Math.abs(delta) < 60) {
      this.s += delta;
      this.lateral = pr2.d;
      return;
    }
    // Lost the course (ran wide off a crest, missed a corner): find the car again
    // on the road a little further on, never more than 600 m ahead.
    const ahead = this.course.path.project(x, z, local, Math.min(local + 600, this.loop ? L + 600 : L));
    if (ahead.d < 15) {
      let d2 = ahead.s - local;
      if (this.loop && d2 > L / 2) d2 -= L;
      if (d2 > 0) this.s += d2;
    }
    this.lateral = Math.min(pr2.d, ahead.d);
  }
}

// ------------------------------------------------------------------ Warm-Up
export class WarmUpRun extends EventRun {
  course: Course;
  private prog!: Progress;
  private stage = 0; // 0 brake, 1 drift, 2 nitro trap, 3 signature, 4 finish
  private tasks = [false, false, false, false];
  private boxS: number;
  private driftStart: number;
  private driftEnd: number;
  private trapS: number;
  private sigGate: number;
  private abilityAtSig = 0;
  private trapSpeed = 0;

  constructor(host: EventHost, id: EventId = 'warmup') {
    super(host, id, 'warmup');
    this.course = new Course(host.d, id, this.def.waypoints);
    const corner = this.course.nodeS[1];
    this.boxS = corner - 120;
    this.driftStart = this.boxS + 12;
    this.driftEnd = corner + 140;
    this.trapS = this.course.nodeS[2] + 200;
    this.sigGate = this.course.length - 12;
  }

  begin() {
    const p = this.course.pose(this.def.startAlong, 2);
    this.host.placePlayer(p.x, p.z, p.h, 0);
    this.prog = new Progress(this.course, false, this.def.startAlong);
    const box = floorBox(7, 10, 0x79d98a);
    const bp = this.course.pose(this.boxS, 1.5);
    this.place(box, bp.x, bp.z, bp.h);
    const label = textSprite('STOP IN THE BOX', { color: '#79d98a' });
    label.position.set(bp.x, this.gy(bp.x, bp.z) + 3, bp.z);
    label.scale.multiplyScalar(1.8);
    this.group.add(label);
    const corner = this.course.pose(this.course.nodeS[1]);
    const dl = textSprite('DRIFT HERE · HOLD SPACE', { color: '#ffb347' });
    dl.position.set(corner.x, this.gy(corner.x, corner.z) + 5, corner.z);
    dl.scale.multiplyScalar(2);
    this.group.add(dl);
    for (const [s, color, text] of [[this.trapS, 0x5aa8ff, 'SPEED TRAP 60'], [this.sigGate, 0xffffff, 'FINISH']] as const) {
      const p2 = this.course.pose(s);
      this.place(gate(this.course.widthAt(s) + 3, color, text), p2.x, p2.z, p2.h);
    }
  }

  protected onGo() {
    this.host.toast('Brake', 'Stop inside the green box', 2);
  }

  protected tick() {
    const p = this.host.player;
    this.prog.update(p.x, p.z);
    const s = this.prog.s;
    if (this.stage === 0) {
      if (s > this.boxS && s < this.boxS + 10 && p.speed < 0.8) {
        this.tasks[0] = true;
        this.stage = 1;
        this.host.cue('check');
        this.host.toast('Clean stop', 'Now drift the right turn onto North Avenue: hold Space while steering', 3);
      } else if (s > this.boxS + 12) {
        this.stage = 1;
        this.host.toast('Missed the box', 'Drift the turn onto North Avenue: hold Space while steering', 3);
      }
    } else if (this.stage === 1) {
      if (s >= this.driftStart && s <= this.driftEnd && (p.driftTier >= 1 || (p.boostTime > 0 && p.miniTurbo))) {
        this.tasks[1] = true;
        this.stage = 2;
        this.host.cue('check');
        this.host.toast('Mini-turbo!', 'Now 60 mph through the trap: Shift for nitro', 2.6);
      } else if (s > this.driftEnd) {
        this.stage = 2;
        this.host.toast('No mini-turbo', 'Hit 60 mph at the trap: Shift for nitro', 2.6);
      }
    } else if (this.stage === 2) {
      if (s >= this.trapS) {
        this.trapSpeed = p.speed / 0.44704;
        this.tasks[2] = this.trapSpeed >= 60;
        this.stage = 3;
        this.abilityAtSig = this.host.ability.activations;
        this.host.cue(this.tasks[2] ? 'check' : 'miss');
        this.host.toast(`${Math.round(this.trapSpeed)} mph`, `Fire your ${this.host.ability.name} (E) before the finish`, 2.4);
      }
    } else if (this.stage === 3) {
      if (this.host.ability.activations > this.abilityAtSig && !this.tasks[3]) { this.tasks[3] = true; this.host.cue('check'); }
      if (s >= this.sigGate) {
        const n = this.tasks.filter(Boolean).length;
        const payout = 400 + n * 100;
        this.end({
          outcome: 'complete', headline: 'Warm-Up complete', detail: 'Retry for a cleaner run, or carry on up North Avenue.',
          score: Math.max(1, n), scoreText: `${n}/4 tasks`, payout, medal: medalFor(this.def, Math.max(1, n)),
          lines: [
            ['Brake box', this.tasks[0] ? 'Clean stop' : 'Missed'],
            ['Drift mini-turbo', this.tasks[1] ? 'Earned ✓' : 'Not earned'],
            ['Speed trap', `${Math.round(this.trapSpeed)} mph ${this.tasks[2] ? '✓' : '(need 60)'}`],
            ['Signature', this.tasks[3] ? 'Used ✓' : 'Not used'],
            ['Time', fmtTime(this.time)],
          ],
          time: this.time,
        });
      }
    }
  }

  hud() {
    const labels = ['Stop in the box', 'Drift the corner (hold Space)', 'Speed trap: 60 mph', 'Signature (E)', 'Finish'];
    const marks = this.tasks.map((t) => (t ? '✓' : '·')).join(' ');
    return `<div class="title">${this.def.name}</div><div class="main">${labels[this.stage]}</div><div class="rows"><span>Tasks <b>${marks}</b></span><span>Time <b>${fmtTime(this.time)}</b></span></div>`;
  }

  markers(): MiniMarker[] {
    const s = [this.boxS, this.course.nodeS[1], this.trapS, this.sigGate, this.sigGate][this.stage];
    const p = this.course.pose(s);
    return [{ x: p.x, z: p.z, color: '#79d98a', kind: 'checkpoint' }];
  }

  route() {
    return this.course.offsetPoints(0);
  }
}

// ------------------------------------------------------------------ Circuit
export class CircuitRun extends EventRun {
  course: Course;
  readonly laps: number;
  /** Closed loop (laps) or a point-to-point sprint. */
  readonly loop: boolean;
  private prog!: Progress;
  private cps: number[] = [];
  private next = 0;
  splits: number[] = [];
  private bestSplits: number[] | null = null;
  private rival: Racer | null = null;
  private rivalProg: Progress | null = null;
  private rivalFinish = -1;
  private ghostSamples: number[] = [];
  private sampleClock = 0;
  private lastDelta: number | null = null;
  private gateObjs: THREE.Group[] = [];
  private turnS: number[] = [];
  private pads: PadSet | null = null;

  constructor(host: EventHost, readonly mode: 'rival' | 'ghost' | 'online', bestSplits: number[] | null, id: EventId = 'circuit') {
    super(host, id, 'circuit');
    this.course = new Course(host.d, id, this.def.waypoints);
    this.bestSplits = bestSplits;
    this.loop = this.def.loop ?? true;
    this.laps = this.loop ? (this.def.laps ?? 2) : 1;
    // A sprint's distance runs from the start line to just before the route's end.
    const L = this.raceLength;
    for (let lap = 0; lap < this.laps; lap++) for (let k = 1; k <= 5; k++) this.cps.push(lap * L + (L * k) / 5);
    this.turnS = this.course.nodeS.slice(1, this.loop ? 5 : -1).slice(0, 4).map((s) => s - this.def.startAlong);
  }

  /** Distance of one lap (loop) or of the whole sprint. */
  get raceLength() {
    return this.loop ? this.course.length : this.course.length - this.def.startAlong - 6;
  }

  get version() {
    return this.course.version;
  }

  private posAt(progress: number, lateral = 0) {
    const L = this.course.length;
    const s = this.loop ? (((progress + this.def.startAlong) % L) + L) % L : Math.max(0.5, Math.min(L, progress + this.def.startAlong));
    return this.course.pose(s, lateral);
  }

  begin() {
    const start = this.posAt(-this.gridRow * 8, 1.9 * this.gridSide);
    this.host.placePlayer(start.x, start.z, start.h, 0);
    this.prog = new Progress(this.course, this.loop, this.def.startAlong);
    const L = this.raceLength;
    const gates = this.loop ? 5 : 6;
    for (let k = 0; k < gates; k++) {
      const pr = k === 0 ? 0 : (L * k) / 5;
      const p = this.posAt(pr);
      const label = k === 0 ? (this.loop ? 'START / FINISH' : 'START') : k === 5 ? 'FINISH' : `CHECKPOINT ${k}`;
      const g = gate(this.course.widthAt(this.loop ? (pr + this.def.startAlong) % L : pr + this.def.startAlong) + 3, k === 0 || k === 5 ? 0xffffff : this.def.color, label);
      this.place(g, p.x, p.z, p.h);
      this.gateObjs.push(g);
    }
    // Numbered turns at the corners (a sprint's last waypoint is its finish).
    this.course.nodeS.slice(1, this.loop ? 5 : -1).slice(0, 4).forEach((s, i) => {
      const p = this.course.path.pointAt(s);
      const t = textSprite(`T${i + 1}`, { color: '#ffb347', size: 80, width: 256 });
      t.position.set(p.x, this.gy(p.x, p.z) + 6, p.z);
      t.scale.multiplyScalar(2.2);
      this.group.add(t);
    });
    this.pads = new PadSet({ placePad: (o, x, z, h) => this.placeOnRoad(o, x, z, h) }, this.course, padSpots(this.course, 0, this.course.length));
    if (this.mode === 'rival') {
      const rs = this.posAt(7, 2.3);
      const pace = this.host.difficulty.rivalPace;
      const skill: Skill = { latBudget: 9.5 * Math.sqrt(pace), brakeDecel: 9, brakeOptimism: 1.05, maxSpeed: 52 * pace, lookahead: 8 };
      const rivalCar: CarId = this.host.carId === 'vesper' ? 'finch' : 'vesper';
      this.rival = this.host.addRacer(rivalCar, '#2a9d8f', this.course.offsetPoints(2.3), skill, rs.x, rs.z, rs.h, this.loop);
      this.rivalProg = new Progress(this.course, this.loop, this.def.startAlong + 7);
    }
  }

  protected tick(dt: number) {
    const p = this.host.player;
    this.prog.update(p.x, p.z);
    this.pads?.update(p, dt);
    if (this.rival) this.pads?.update(this.rival.v, dt);
    const progress = this.prog.s - this.def.startAlong;
    if (this.rival && this.rivalProg) {
      this.rivalProg.update(this.rival.v.x, this.rival.v.z);
      this.rival.progress = this.rivalProg.s - this.def.startAlong;
      if (this.rivalFinish < 0 && this.rival.progress >= this.laps * this.raceLength) {
        this.rivalFinish = this.time;
        this.host.toast('Rival finished', fmtTime(this.time), 1.5);
      }
    }
    this.sampleClock += dt;
    while (this.sampleClock >= 0.05) {
      this.sampleClock -= 0.05;
      this.ghostSamples.push(Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10, Math.round(p.h * 100) / 100);
    }
    this.host.ghostTime(this.time);
    if (this.next < this.cps.length && progress >= this.cps[this.next] && this.prog.lateral < 18) {
      this.splits.push(this.time);
      const best = this.bestSplits?.[this.next];
      this.lastDelta = best !== undefined ? this.time - best : null;
      this.next++;
      this.host.cue('check');
      if (this.next === 5 && this.laps > 1) this.host.toast('Lap 2', fmtTime(this.time), 1.4);
      const gi = this.next % 5;
      this.gateObjs.forEach((g, i) => setGateColor(g, i === gi ? 0x79d98a : i === 0 ? 0xffffff : 0xffb347));
      if (this.next === this.cps.length) this.finishRace();
    }
  }

  private finishRace() {
    const t = this.time;
    const won = this.mode === 'rival' ? this.rivalFinish < 0 : true;
    const base = 1000 + (this.mode === 'rival' && won ? 500 : 0);
    const headline = this.mode === 'rival' ? (won ? 'You beat the rival' : 'Rival took it') : this.mode === 'online' ? 'Race finished' : 'Solo run complete';
    const ghost: Ghost = { course: this.def.id, version: this.course.version, car: this.host.carId, time: t, dt: 0.05, samples: this.ghostSamples };
    this.end({
      outcome: won ? 'win' : 'complete',
      headline,
      detail: `${this.def.detail ?? this.def.name} In the ${CARS[this.host.carId].name}.`,
      score: t, scoreText: fmtTime(t), payout: base, medal: medalFor(this.def, t),
      lines: [
        ['Time', fmtTime(t)],
        ['Best split delta', this.lastDelta !== null ? `${this.lastDelta >= 0 ? '+' : ''}${this.lastDelta.toFixed(2)}s` : '—'],
        ...(this.laps > 1 ? [['Lap 1', fmtTime(this.splits[4] ?? 0)], ['Lap 2', fmtTime(t - (this.splits[4] ?? 0))]] as [string, string][] : [['Average', `${Math.round((this.raceLength * this.laps) / Math.max(1, t) / 0.44704)} mph`]] as [string, string][]),
        ...(this.mode === 'rival' ? [['Rival', this.rivalFinish > 0 ? fmtTime(this.rivalFinish) : 'Still racing'] as [string, string]] : []),
      ],
      ghost, splits: this.splits, time: t,
    });
  }

  raceProgress() {
    return this.prog ? this.prog.s - this.def.startAlong : 0;
  }

  dispose() {
    if (this.rival) this.host.removeRacer(this.rival);
    this.host.showGhost(null);
    super.dispose();
  }

  hud() {
    const lap = Math.min(this.laps, Math.floor(this.next / 5) + 1);
    const pos = this.rival ? (this.rival.progress > this.prog.s - this.def.startAlong ? 'P2' : 'P1') : this.mode === 'online' ? 'ONLINE' : 'SOLO';
    const turn = this.turnS.findIndex((s) => s > ((this.prog.s - this.def.startAlong) % this.course.length));
    const delta = this.lastDelta === null ? '' : `<span class="delta ${this.lastDelta <= 0 ? 'good' : 'bad'}">${this.lastDelta >= 0 ? '+' : ''}${this.lastDelta.toFixed(2)}</span>`;
    return `<div class="title">${this.def.name} · ${pos}</div><div class="main">${fmtTime(this.time)}</div>
      <div class="rows">${this.laps > 1 ? `<span>Lap <b>${lap}/${this.laps}</b></span>` : ''}<span>CP <b>${this.next % 5}/5</b></span><span>Next <b>T${turn < 0 ? 1 : turn + 1}</b></span>${delta}</div>`;
  }

  markers(): MiniMarker[] {
    const m: MiniMarker[] = [];
    if (this.next < this.cps.length) {
      const p = this.posAt(this.cps[this.next] % this.course.length);
      m.push({ x: p.x, z: p.z, color: '#79d98a', kind: 'checkpoint' });
    }
    if (this.rival) m.push({ x: this.rival.v.x, z: this.rival.v.z, color: '#2a9d8f', kind: 'rival' });
    return m;
  }

  route() {
    return this.course.offsetPoints(0);
  }
}

// ------------------------------------------------------------------ Last Set
export class LastSetRun extends EventRun {
  condition = 100;
  get item() { return this.def.item ?? 'snare'; }
  impacts = 0;
  private dest: { x: number; z: number };
  private gps: number[] | null = null;
  private gpsTimer = 0;
  private stillTime = 0;
  readonly limit: number;

  constructor(host: EventHost, id: EventId = 'lastset') {
    super(host, id, 'lastset');
    const f = venueFrame(host.d, VENUE);
    this.dest = f.curb;
    this.limit = Math.round((this.def.timeLimit ?? 150) * host.difficulty.timeLimit);
  }

  begin() {
    const f = venueFrame(this.host.d, REHEARSAL);
    const fx = Math.sin(f.street.h), fz = Math.cos(f.street.h);
    const back = this.gridRow * 8, side = this.gridSlot % 2 ? 2.6 : 0;
    const rx = -Math.cos(f.street.h), rz = Math.sin(f.street.h);
    const sideSign = Math.sign((f.curb.x - f.street.x) * rx + (f.curb.z - f.street.z) * rz) || 1;
    this.host.placePlayer(f.curb.x - fx * back - rx * side * sideSign, f.curb.z - fz * back - rz * side * sideSign, f.street.h, 0);
    const b = beacon(0x5aa8ff, VENUE.sign[0], `Deliver the ${this.item}`);
    this.place(b, this.dest.x, this.dest.z, 0);
  }

  protected onGo() {
    this.host.toast(this.def.cargo ?? 'Loaded', this.def.destLine ?? `Get to ${VENUE.name}`, 2.4);
  }

  onContact(c: Contact) {
    if (this.state !== 'running' || c.a !== this.host.player) return;
    if (c.dv < 1.2) return;
    const loss = (c.dv - 1.2) * 4.5 * this.host.difficulty.damage;
    this.condition = Math.max(0, this.condition - loss);
    this.impacts++;
    this.host.cue('case');
    if (this.condition <= 0) {
      this.end({
        outcome: 'fail', headline: this.item === 'cake' ? 'The cake gave out' : 'The case gave out', detail: this.item === 'cake' ? 'Too many hits — the cake is in pieces.' : 'Too many hits — the snare is in pieces.',
        score: null, scoreText: '—', payout: 0, medal: null, lines: [['Impacts', String(this.impacts)], ['Time', fmtTime(this.time)]],
      });
    }
  }

  protected tick(dt: number) {
    const p = this.host.player;
    this.gpsTimer -= dt;
    if (this.gpsTimer <= 0) {
      this.gpsTimer = 1.5;
      this.gps = this.host.gpsRoute(this.dest.x, this.dest.z);
    }
    const left = this.limit - this.time;
    const d = Math.hypot(p.x - this.dest.x, p.z - this.dest.z);
    if (d < 10 && p.speed < 3) {
      this.stillTime += dt;
      if (this.stillTime > 0.6) {
        const payout = lastSetPayout(left, this.condition);
        this.end({
          outcome: 'win', headline: this.item === 'cake' ? 'Cake delivered' : 'Snare delivered', detail: this.item === 'cake' ? (left > 30 ? 'Plenty of time before the toast.' : 'Just made the toast.') : left > 30 ? 'Plenty of time before the downbeat.' : 'Just made the downbeat.',
          score: payout, scoreText: `${payout.toLocaleString()} cr`, payout, medal: medalFor(this.def, payout),
          lines: [
            ['Time left', `${left.toFixed(1)}s × 4 = ${Math.round(4 * left)} cr`],
            [this.item === 'cake' ? 'Cake condition' : 'Case condition', `${Math.round(this.condition)}% × 9 = ${Math.round(9 * this.condition)} cr`],
            ['Delivery fee', '500 cr'],
            ['Impacts', String(this.impacts)],
          ],
          time: this.time,
        });
      }
    } else this.stillTime = 0;
    if (left <= 0) {
      this.end({
        outcome: 'fail', headline: this.item === 'cake' ? 'The toast went ahead without you' : 'The set started without you', detail: this.item === 'cake' ? 'They cut a grocery-store sheet cake instead.' : 'The band went on with a borrowed snare.',
        score: null, scoreText: '—', payout: 0, medal: null, lines: [['Case condition', `${Math.round(this.condition)}%`], ['Distance left', `${Math.round(d)} m`]],
      });
    }
  }

  hud() {
    const left = Math.max(0, this.limit - this.time);
    const est = lastSetPayout(left, this.condition);
    return `<div class="title">${this.def.name} · ${this.item === 'cake' ? 'the toast is in' : 'set starts in'}</div><div class="main">${fmtTime(left)}</div>
      <div class="rows"><span>${this.item === 'cake' ? 'Cake' : 'Case'} <b>${Math.round(this.condition)}%</b></span><span>Payout now <b>${est} cr</b></span></div>`;
  }

  markers(): MiniMarker[] {
    return [{ x: this.dest.x, z: this.dest.z, color: '#5aa8ff', kind: 'event', label: VENUE.name.replace(/^The /, '') }];
  }

  raceProgress() {
    const p = this.host.player;
    return 10000 - Math.hypot(p.x - this.dest.x, p.z - this.dest.z);
  }

  route() {
    return this.gps;
  }
}

// ------------------------------------------------------------------ Winkleman Air
export class AirRun extends EventRun {
  course: Course;
  private prog!: Progress;
  score = 0;
  chain = 0;
  bestChain = 0;
  jumps = 0;
  bestAir = 0;
  totalAir = 0;
  private lastLand = -99;
  private finishS: number;
  lastJump: { air: number; points: number; chain: number; t: number } | null = null;
  get timeLimit() { return Math.round((this.def.timeLimit ?? 110) * this.host.difficulty.timeLimit); }

  constructor(host: EventHost, id: EventId = 'air') {
    super(host, id, 'air');
    this.course = new Course(host.d, id, this.def.waypoints);
    this.finishS = this.course.length - 8;
  }

  begin() {
    const s0 = Math.max(1, this.def.startAlong - this.gridRow * 8);
    const p = this.course.pose(s0, 1.8 * (this.gridSlot % 2 ? -1 : 1));
    this.host.placePlayer(p.x, p.z, p.h, 0);
    this.prog = new Progress(this.course, false, s0);
    const st = this.course.pose(this.def.startAlong + 12);
    this.place(gate(this.course.widthAt(this.def.startAlong + 12) + 3, 0x7ad7ff, this.def.startLabel ?? this.def.name.toUpperCase()), st.x, st.z, st.h);
    const f = this.course.pose(this.finishS);
    this.place(gate(this.course.widthAt(this.finishS) + 3, 0xffffff, 'FINISH'), f.x, f.z, f.h);
  }

  protected onGo() {
    this.host.toast('Catch air', 'Hit the crests fast. Chain landings for a multiplier.', 2.4);
  }

  onLand(air: number, speed: number) {
    if (this.state !== 'running') return;
    this.chain = this.time - this.lastLand < 5 ? this.chain + 1 : 1;
    this.lastLand = this.time;
    const pts = airScore(air, speed, this.chain);
    this.score += pts;
    this.jumps++;
    this.totalAir += air;
    this.bestAir = Math.max(this.bestAir, air);
    this.bestChain = Math.max(this.bestChain, this.chain);
    this.lastJump = { air, points: pts, chain: this.chain, t: this.time };
    this.host.cue('bank');
  }

  onContact(c: Contact) {
    if (this.state !== 'running' || c.a !== this.host.player || c.dv < 2.5) return;
    if (this.chain > 1) this.host.toast('Chain broken', 'Crash: multiplier reset', 1.4);
    this.chain = 0;
    this.lastLand = -99;
    this.host.cue('miss');
  }

  protected tick() {
    const p = this.host.player;
    this.prog.update(p.x, p.z);
    if (this.prog.s >= this.finishS && this.prog.lateral < 18) {
      const score = Math.round(this.score);
      const medal = medalFor(this.def, score);
      this.end({
        outcome: medal ? 'win' : 'complete', headline: 'Off the hills', detail: this.def.detail ?? '',
        score, scoreText: score.toLocaleString(), payout: 400 + Math.min(1700, Math.round(score / 9)), medal,
        lines: [['Air score', score.toLocaleString()], ['Jumps', String(this.jumps)], ['Total air', `${this.totalAir.toFixed(1)}s`], ['Longest jump', `${this.bestAir.toFixed(2)}s`], ['Best chain', `×${this.bestChain}`], ['Time', fmtTime(this.time)]],
        time: this.time,
      });
    } else if (this.time >= this.timeLimit) {
      this.end({
        outcome: 'fail', headline: 'Out of time', detail: this.def.failDetail ?? 'The run counts only if you reach the finish.',
        score: null, scoreText: '—', payout: 0, medal: null, lines: [['Air score', Math.round(this.score).toLocaleString()], ['Jumps', String(this.jumps)]],
      });
    }
  }

  hud() {
    const left = Math.max(0, this.timeLimit - this.time);
    const chainLive = this.time - this.lastLand < 5 && this.chain > 0;
    const last = this.lastJump && this.time - this.lastJump.t < 2.5 ? `<span class="delta good">+${this.lastJump.points.toLocaleString()} · ${this.lastJump.air.toFixed(2)}s</span>` : '';
    return `<div class="title">${this.def.name}</div><div class="main">${Math.round(this.score).toLocaleString()}</div>
      <div class="rows"><span>Chain <b>${chainLive ? '×' + Math.min(this.chain + 1, 6) + ' next' : '—'}</b></span><span>Jumps <b>${this.jumps}</b></span><span>Time <b>${fmtTime(left)}</b></span>${last}</div>`;
  }

  markers(): MiniMarker[] {
    const p = this.course.pose(this.finishS);
    return [{ x: p.x, z: p.z, color: '#7ad7ff', kind: 'checkpoint' }];
  }

  raceProgress() {
    return this.prog?.s ?? 0;
  }

  route() {
    return this.course.offsetPoints(0);
  }
}

// ------------------------------------------------------------------ Five-Star Encore
export class EncoreRun extends EventRun {
  course: Course;
  private prog!: Progress;
  private gateS: number[];
  private gateStars = [2, 3, 0, 5];
  private nextGate = 0;
  private gates: THREE.Group[] = [];
  decision = 0;
  banked = false;
  prize = 0;
  private finishS: number;

  constructor(host: EventHost, id: EventId = 'encore') {
    super(host, id, 'encore');
    this.course = new Course(host.d, id, this.def.waypoints);
    const n = this.course.nodeS, L = this.course.length;
    this.gateS = this.def.gates ? this.def.gates(n, L) : [L * 0.15, L * 0.35, L * 0.55, L * 0.78];
    this.finishS = this.course.length - 4;
  }

  begin() {
    const p = this.course.pose(this.def.startAlong, 2);
    this.host.placePlayer(p.x, p.z, p.h, 0);
    this.prog = new Progress(this.course, false, this.def.startAlong);
    const labels = ['GATE 1 ★★', 'GATE 2 ★★★', 'BANK OR GO ★★★★', 'GATE 4 ★★★★★'];
    this.gateS.forEach((s, i) => {
      const q = this.course.pose(s);
      const g = gate(this.course.widthAt(s) + 3, i === 2 ? 0x79d98a : 0xff4b4b, labels[i], 5.5);
      this.place(g, q.x, q.z, q.h);
      this.gates.push(g);
    });
    const f = this.course.pose(this.finishS);
    this.place(gate(this.course.widthAt(this.finishS) + 4, 0xffffff, 'FIVE-STAR FINISH', 6), f.x, f.z, f.h);
  }

  protected onGo() {
    this.host.heat.forced = true;
    this.host.heat.hold = true;
    this.host.heat.setStars(1, 'Five-Star Encore');
    this.host.toast('Encore', 'Each gate raises the heat', 2);
  }

  nextPrize() {
    if (this.nextGate === 0) return ENCORE_PRIZES.gate1;
    if (this.nextGate === 1) return ENCORE_PRIZES.gate2;
    if (this.nextGate === 2) return ENCORE_PRIZES.bank;
    return ENCORE_PRIZES.finish;
  }

  onCaught() {
    if (this.state !== 'running') return;
    this.end({
      outcome: 'fail', headline: 'Caught', detail: 'The prize goes with the run. Retry to go again from the start.',
      score: null, scoreText: '—', payout: 0, medal: null, lines: [['Gates cleared', `${this.nextGate}/4`], ['Prize lost', `${this.prize} cr`]],
    });
  }

  protected tick(dt: number) {
    const p = this.host.player;
    this.prog.update(p.x, p.z);
    const s = this.prog.s;
    if (this.decision > 0) {
      this.decision -= dt;
      if (this.host.confirmPressed()) {
        this.banked = true;
        this.decision = 0;
        this.finishEncore('banked');
        return;
      }
      if (this.decision <= 0) {
        this.host.heat.setStars(4, 'Encore: kept driving');
        this.host.toast('Going for five', `Finish prize ${ENCORE_PRIZES.finish.toLocaleString()} cr`, 2);
      }
    }
    if (this.nextGate < this.gateS.length && s >= this.gateS[this.nextGate] && this.prog.lateral < 18) {
      const i = this.nextGate++;
      setGateColor(this.gates[i], 0x333333, 0.4);
      this.host.cue('gate');
      if (i === 0) this.prize = ENCORE_PRIZES.gate1;
      if (i === 1) this.prize = ENCORE_PRIZES.gate2;
      if (i === 2) {
        this.prize = ENCORE_PRIZES.bank;
        this.decision = 7;
        this.host.toast('Bank or go', `Enter: bank ${ENCORE_PRIZES.bank} cr · keep driving for ${ENCORE_PRIZES.finish} cr`, 3);
      } else {
        this.host.heat.setStars(this.gateStars[i], `Encore gate ${i + 1}`);
      }
    }
    if (this.nextGate >= 4 && s >= this.finishS) this.finishEncore('finish');
  }

  private finishEncore(kind: 'banked' | 'finish') {
    const heat = this.host.heat;
    const bonus = Math.round(heat.score);
    const payout = kind === 'banked' ? ENCORE_PRIZES.bank : ENCORE_PRIZES.finish + bonus;
    const medal: Medal = kind === 'banked' ? 'bronze' : this.time < 200 ? 'gold' : 'silver';
    heat.forced = false;
    heat.hold = false;
    heat.reset();
    this.end({
      outcome: kind === 'banked' ? 'banked' : 'win',
      headline: kind === 'banked' ? 'Prize banked' : 'Five-star finish',
      detail: kind === 'banked' ? this.def.bankDetail ?? 'You took the sure thing.' : this.def.detail ?? 'Five stars on you at the finish.',
      score: kind === 'banked' ? 1 : this.time < 200 ? 3 : 2, scoreText: kind === 'banked' ? 'Banked' : 'Finished',
      payout, medal,
      lines: [['Prize', `${(kind === 'banked' ? ENCORE_PRIZES.bank : ENCORE_PRIZES.finish).toLocaleString()} cr`], ['Pursuit bonus', kind === 'banked' ? '—' : `${bonus} cr`], ['Time', fmtTime(this.time)]],
      time: this.time,
    });
  }

  abort() {
    this.host.heat.forced = false;
    this.host.heat.hold = false;
    super.abort();
  }

  hud() {
    const stars = this.host.heat.stars;
    const dec = this.decision > 0
      ? `<div class="rows"><span><b>Enter</b> bank ${ENCORE_PRIZES.bank} cr</span><span>or drive on for <b>${ENCORE_PRIZES.finish} cr</b> (${Math.ceil(this.decision)}s)</span></div>`
      : `<div class="rows"><span>Gate <b>${Math.min(this.nextGate + 1, 4)}/4</b></span><span>Next payout <b>${this.nextPrize().toLocaleString()} cr</b></span><span>${'★'.repeat(stars)}</span></div>`;
    return `<div class="title">${this.def.name}</div><div class="main">${fmtTime(this.time)}</div>${dec}`;
  }

  markers(): MiniMarker[] {
    const s = this.nextGate < 4 ? this.gateS[this.nextGate] : this.finishS;
    const p = this.course.pose(s);
    return [{ x: p.x, z: p.z, color: '#ff4b4b', kind: 'gate' }];
  }

  route() {
    return this.course.offsetPoints(0);
  }
}

// ------------------------------------------------------------------ Ironport chases
const stars = (n: number) => '★'.repeat(Math.max(0, n));

/** Police-chase events: start on a street with the heat already on. */
abstract class ChaseRun extends EventRun {
  protected course: Course;

  constructor(host: EventHost, id: EventId, kind: EventKind) {
    super(host, id, kind);
    this.course = new Course(host.d, id, this.def.waypoints);
  }

  get startStars() {
    return this.def.stars ?? 2;
  }

  get limit() {
    return Math.round((this.def.timeLimit ?? 240) * this.host.difficulty.timeLimit);
  }

  begin() {
    const s0 = Math.max(1, this.def.startAlong - this.gridRow * 8);
    const p = this.course.pose(s0, 2 * this.gridSide);
    this.host.placePlayer(p.x, p.z, p.h, 0);
  }

  /** Heat on at GO. `hold`: the search can never clear it. */
  protected heatOn(hold: boolean) {
    const heat = this.host.heat;
    heat.forced = true;
    heat.hold = hold;
    heat.setStars(this.startStars, this.def.name);
  }

  protected heatOff() {
    this.host.heat.forced = false;
    this.host.heat.hold = false;
  }

  abort() {
    this.heatOff();
    super.abort();
  }

  onTotaled() {
    this.heatOff();
    super.onTotaled();
  }

  onCaught() {
    if (this.state !== 'running') return;
    this.heatOff();
    this.end({
      outcome: 'fail', headline: 'Busted', detail: 'They boxed you in. Retry to go again from the start.',
      score: null, scoreText: '—', payout: 0, medal: null, lines: [['Time', fmtTime(this.time)]],
    });
  }

  /** The search ran out (escape events only). */
  onEscaped(_stars: number) {}

  markers(): MiniMarker[] {
    return [];
  }

  protected heatRows() {
    const heat = this.host.heat;
    const phase = heat.phase === 'search' ? `Searching <b>${Math.round(heat.searchMeter * 100)}%</b>` : heat.phase === 'pursuit' ? 'In sight' : '';
    return `<span>${stars(heat.stars)}</span>${phase ? `<span>${phase}</span>` : ''}`;
  }
}

/** Hot Start, Underway Escape, Five Alarm: lose the police, as fast as you can. */
export class EscapeRun extends ChaseRun {
  constructor(host: EventHost, id: EventId) {
    super(host, id, 'escape');
  }

  protected onGo() {
    this.heatOn(false);
    this.host.toast(stars(this.startStars), 'Lose them', 2);
  }

  onEscaped(atStars: number) {
    if (this.state !== 'running') return;
    this.heatOff();
    const t = this.time;
    const medal = medalFor(this.def, t);
    const bonus = medal === 'gold' ? 900 : medal === 'silver' ? 500 : medal === 'bronze' ? 250 : 0;
    const payout = 300 * this.startStars + bonus;
    this.end({
      outcome: 'win', headline: 'Escaped', detail: medal ? `Lost them in ${fmtTime(t)}.` : 'Lost them, eventually.',
      score: t, scoreText: fmtTime(t), payout, medal,
      lines: [['Escape time', fmtTime(t)], ['Wanted level at the end', stars(atStars)], ['Escape fee', `${(300 * this.startStars).toLocaleString()} cr`], ['Medal bonus', bonus ? `${bonus} cr` : '—']],
      time: t,
    });
  }

  protected tick() {
    if (this.time < this.limit) return;
    // Out of time: the event is over, but the chase goes on in free roam.
    this.heatOff();
    this.end({
      outcome: 'fail', headline: 'Still hot', detail: 'Time ran out with them still on you. The event is over; the pursuit is not.',
      score: null, scoreText: '—', payout: 0, medal: null, lines: [['Wanted level', stars(this.host.heat.stars)], ['Time', fmtTime(this.time)]],
    });
  }

  hud() {
    return `<div class="title">${this.def.name} · lose them</div><div class="main">${fmtTime(this.time)}</div>
      <div class="rows">${this.heatRows()}<span>Limit ${fmtTime(this.limit)}</span></div>`;
  }
}

/** Siege: the heat stays at four stars or more; stay free until the clock runs out. */
export class SurviveRun extends ChaseRun {
  constructor(host: EventHost, id: EventId) {
    super(host, id, 'survive');
  }

  protected onGo() {
    this.heatOn(true);
    this.host.toast('Siege', `Stay free for ${fmtTime(this.limit).replace(/\.00$/, '')}`, 2);
  }

  private result(survived: number, how: 'clock' | 'busted' | 'totaled') {
    this.heatOff();
    if (how === 'clock') this.host.endPursuit();
    const secs = Math.floor(survived);
    const medal = medalFor(this.def, secs);
    const payout = secs * 12 + (medal === 'gold' ? 1200 : medal === 'silver' ? 600 : medal === 'bronze' ? 250 : 0);
    this.end({
      outcome: how === 'clock' ? 'win' : medal ? 'complete' : 'fail',
      headline: how === 'clock' ? 'You held out' : how === 'busted' ? 'Busted' : 'Car totaled',
      detail: how === 'clock' ? 'Three minutes with the whole city on you, and they never got you.' : medal ? `Free for ${secs} seconds before they got you.` : 'Not long enough for a medal. Retry and keep moving.',
      score: medal || how === 'clock' ? secs : null, scoreText: `${secs} s`, payout: medal || how === 'clock' ? payout : 0, medal,
      lines: [['Seconds free', String(secs)], ['Peak wanted level', stars(this.peak)], ['Pay', `${secs} s × 12 cr${medal ? ' + medal bonus' : ''}`]],
      time: survived,
    });
  }

  private peak = 0;

  onCaught() {
    if (this.state === 'running') this.result(this.time, 'busted');
  }

  onTotaled() {
    if (this.state === 'running') this.result(this.time, 'totaled');
  }

  protected tick() {
    this.peak = Math.max(this.peak, this.host.heat.stars);
    // The floor: never below the starting level while the siege lasts.
    if (this.host.heat.stars < this.startStars) this.host.heat.setStars(this.startStars, this.def.name);
    if (this.time >= this.limit) this.result(this.limit, 'clock');
  }

  hud() {
    const left = Math.max(0, this.limit - this.time);
    const next = this.def.medals;
    const t = Math.floor(this.time);
    const goal = t < next.bronze ? `Bronze at ${next.bronze}s` : t < next.silver ? `Silver at ${next.silver}s` : `Gold at ${next.gold}s`;
    return `<div class="title">${this.def.name} · stay free</div><div class="main">${fmtTime(left)}</div>
      <div class="rows">${this.heatRows()}<span>${goal}</span></div>`;
  }
}

/** Breakout: cross the city to the safehouse with the heat locked on. */
export class GetawayRun extends ChaseRun {
  private dest: { x: number; z: number };
  private gps: number[] | null = null;
  private gpsTimer = 0;
  private stillTime = 0;

  constructor(host: EventHost, id: EventId) {
    super(host, id, 'getaway');
    this.dest = venueFrame(host.d, VENUE).curb;
  }

  begin() {
    const f = venueFrame(this.host.d, REHEARSAL);
    const fx = Math.sin(f.street.h), fz = Math.cos(f.street.h);
    const back = this.gridRow * 8, side = this.gridSlot % 2 ? 2.6 : 0;
    const rx = -Math.cos(f.street.h), rz = Math.sin(f.street.h);
    const sideSign = Math.sign((f.curb.x - f.street.x) * rx + (f.curb.z - f.street.z) * rz) || 1;
    this.host.placePlayer(f.curb.x - fx * back - rx * side * sideSign, f.curb.z - fz * back - rz * side * sideSign, f.street.h, 0);
    this.place(beacon(this.def.color, VENUE.sign[0], 'Stop here'), this.dest.x, this.dest.z, 0);
  }

  protected onGo() {
    this.heatOn(true);
    this.host.toast(this.def.cargo ?? stars(this.startStars), this.def.destLine ?? `Get to ${VENUE.name}`, 2.4);
  }

  protected tick(dt: number) {
    const p = this.host.player;
    this.gpsTimer -= dt;
    if (this.gpsTimer <= 0) {
      this.gpsTimer = 1.5;
      this.gps = this.host.gpsRoute(this.dest.x, this.dest.z);
    }
    if (this.host.heat.stars < this.startStars) this.host.heat.setStars(this.startStars, this.def.name);
    const d = Math.hypot(p.x - this.dest.x, p.z - this.dest.z);
    if (d < 10 && p.speed < 3 && Math.abs(p.y - this.host.groundAt(this.dest.x, this.dest.z)) < 3) {
      this.stillTime += dt;
      if (this.stillTime > 0.6) {
        const t = this.time;
        const medal = medalFor(this.def, t);
        const atStars = this.host.heat.stars;
        this.heatOff();
        this.host.endPursuit();
        const payout = 900 + 150 * atStars + (medal === 'gold' ? 900 : medal === 'silver' ? 500 : medal === 'bronze' ? 250 : 0);
        this.end({
          outcome: 'win', headline: 'Made it', detail: `Into ${VENUE.name} with ${stars(atStars)} on your tail. The door shuts; the sirens go past.`,
          score: t, scoreText: fmtTime(t), payout, medal,
          lines: [['Time', fmtTime(t)], ['Wanted level on arrival', stars(atStars)], ['Pay', `900 cr + 150 per star${medal ? ' + medal bonus' : ''}`]],
          time: t,
        });
      }
    } else this.stillTime = 0;
    if (this.time >= this.limit) {
      this.heatOff();
      this.end({
        outcome: 'fail', headline: 'Too slow', detail: `${VENUE.name} closed the door. The pursuit goes on.`,
        score: null, scoreText: '—', payout: 0, medal: null, lines: [['Distance left', `${Math.round(d)} m`], ['Wanted level', stars(this.host.heat.stars)]],
      });
    }
  }

  hud() {
    const left = Math.max(0, this.limit - this.time);
    const p = this.host.player;
    const d = Math.hypot(p.x - this.dest.x, p.z - this.dest.z);
    return `<div class="title">${this.def.name} · get to ${VENUE.name}</div><div class="main">${fmtTime(left)}</div>
      <div class="rows">${this.heatRows()}<span><b>${Math.round(d)} m</b> to go</span></div>`;
  }

  markers(): MiniMarker[] {
    return [{ x: this.dest.x, z: this.dest.z, color: '#c08bff', kind: 'event', label: VENUE.name.replace(/^The /, '') }];
  }

  raceProgress() {
    const p = this.host.player;
    return 10000 - Math.hypot(p.x - this.dest.x, p.z - this.dest.z);
  }

  route() {
    return this.gps;
  }
}
