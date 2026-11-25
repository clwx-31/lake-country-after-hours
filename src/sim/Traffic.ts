// Pooled civil traffic: cars follow right-hand lanes, keep distance (IDM), take
// turns at junctions one conflicting movement at a time, and go loose when hit.
import * as THREE from 'three';
import { clamp, lerpAngle } from '../core/math';
import { Rng } from '../core/rng';
import type { Conn, LaneGraph } from '../map/lanes';
import { CarModel, MODEL_DIMS, type ModelId, type TrafficType } from '../render/CarModel';
import type { PhysBody } from './Physics';

export interface Actor {
  id: number;
  x: number;
  z: number;
  h: number;
  speed: number;
  halfLength: number;
}

export interface TrafficCar {
  id: number;
  type: ModelId;
  model: CarModel;
  body: PhysBody;
  lane: number;
  conn: Conn | null;
  next: Conn | null;
  s: number;
  speed: number;
  v0: number;
  mode: 'drive' | 'loose';
  looseTime: number;
  wait: number;
  patrol: boolean;
  px: number;
  pz: number;
  ph: number;
  active: boolean;
  hits: number;
}

const TYPES: { t: TrafficType; w: number }[] = [
  { t: 'sedan', w: 34 }, { t: 'compact', w: 20 }, { t: 'suv', w: 26 }, { t: 'pickup', w: 12 }, { t: 'van', w: 8 },
];
const COLORS = ['#3a3f45', '#6d7178', '#a7a9ab', '#1b1e23', '#5a1d20', '#203a5c', '#c9c6bd', '#2e4a35', '#7a6a55', '#8a8f94', '#4a2f2a', '#e0ddd5'];
let nextId = 1000;

export class Traffic {
  readonly cars: TrafficCar[] = [];
  private occupancy = new Map<number, Set<TrafficCar>>();
  private rng = new Rng(2024);
  private spawnTimer = 0;
  private laneMid: { x: number; z: number }[];
  density = 22;
  patrols = 2;
  /** Which police car the patrols in traffic drive. */
  patrolType: ModelId = 'cruiser';
  /** Surface height (terrain or bridge deck chosen by the height hint). */
  ground: (x: number, z: number, yHint?: number) => number = () => 0;
  private frustum = new THREE.Frustum();
  private mat = new THREE.Matrix4();
  private sphere = new THREE.Sphere();

  constructor(readonly lanes: LaneGraph, private scene: THREE.Scene, private beamTex: THREE.Texture) {
    this.laneMid = lanes.lanes.map((l) => l.path.pointAt(l.path.length / 2));
  }

  private pickType(): TrafficType {
    let r = this.rng.next() * 100;
    for (const t of TYPES) { if ((r -= t.w) < 0) return t.t; }
    return 'sedan';
  }

  private makeCar(type: ModelId, patrol: boolean): TrafficCar {
    const color = patrol ? (type === 'warden' ? '#0b0b0d' : '#16243a') : this.rng.pick(COLORS);
    const model = new CarModel(type, color, { beamTex: this.beamTex });
    const dims = MODEL_DIMS(type);
    const mass = type === 'van' || type === 'pickup' ? 2100 : type === 'suv' ? 1900 : 1450;
    const body: PhysBody = {
      id: nextId++, x: 0, z: 0, h: 0, vx: 0, vz: 0, w: 0, y: 0, mass,
      inertia: (mass * (dims.length ** 2 + dims.width ** 2)) / 12, halfLength: dims.length / 2, halfWidth: dims.width / 2, solid: true,
    };
    return {
      id: body.id, type, model, body, lane: 0, conn: null, next: null, s: 0, speed: 0, v0: 10, mode: 'drive', looseTime: 0,
      wait: 0, patrol, px: 0, pz: 0, ph: 0, active: false, hits: 0,
    };
  }

  private chooseNext(laneId: number): Conn | null {
    const L = this.lanes.lanes[laneId];
    if (!L.outs.length) return null;
    const opts = L.outs.map((c) => this.lanes.conns[c]);
    const straight = opts.filter((c) => c.turn === 'straight');
    const turns = opts.filter((c) => c.turn === 'left' || c.turn === 'right');
    if (straight.length && this.rng.chance(0.55)) return this.rng.pick(straight);
    if (turns.length) return this.rng.pick(turns);
    return this.rng.pick(opts);
  }

  private placeOnPath(c: TrafficCar) {
    const path = c.conn ? c.conn.path : this.lanes.lanes[c.lane].path;
    const p = path.pointAt(c.s);
    const h = path.headingAt(Math.min(c.s + 1.5, path.length));
    c.body.x = p.x;
    c.body.z = p.z;
    c.body.y = this.ground(p.x, p.z, c.body.y);
    const prevH = c.body.h;
    c.body.h = lerpAngle(prevH, h, 0.35);
    c.body.vx = Math.sin(c.body.h) * c.speed;
    c.body.vz = Math.cos(c.body.h) * c.speed;
  }

  spawnAt(laneId: number, s: number, patrol = false, type?: ModelId) {
    const c = this.makeCar(type ?? (patrol ? this.patrolType : this.pickType()), patrol);
    c.lane = laneId;
    c.s = s;
    c.v0 = this.lanes.lanes[laneId].speed * this.rng.range(0.85, 1.08);
    c.speed = c.v0 * 0.8;
    c.next = this.chooseNext(laneId);
    c.active = true;
    const L = this.lanes.lanes[laneId];
    c.body.h = L.path.headingAt(s);
    // Start at the lane's own level (stacked decks and tunnels share x, z).
    const E = this.lanes.d.edges[L.edge];
    const p0 = L.path.pointAt(s);
    c.body.y = E.ys.length ? this.lanes.d.heightOnEdge(L.edge, E.path.project(p0.x, p0.z).s) : E.bridge ? Infinity : -Infinity;
    this.placeOnPath(c);
    c.px = c.body.x; c.pz = c.body.z; c.ph = c.body.h;
    this.cars.push(c);
    this.scene.add(c.model.root);
    return c;
  }

  remove(c: TrafficCar) {
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
    this.release(c);
    this.scene.remove(c.model.root);
    c.model.dispose();
    c.active = false;
  }

  private release(c: TrafficCar) {
    if (c.conn) this.occupancy.get(c.conn.node)?.delete(c);
  }

  clear() {
    for (const c of [...this.cars]) this.remove(c);
  }

  private visible(x: number, z: number, camera: THREE.Camera) {
    this.sphere.set(new THREE.Vector3(x, 1, z), 4);
    return this.frustum.intersectsSphere(this.sphere);
  }

  private trySpawn(fx: number, fz: number, camera: THREE.Camera, actors: Actor[], patrol: boolean) {
    for (let attempt = 0; attempt < 14; attempt++) {
      const id = this.rng.int(0, this.lanes.lanes.length - 1);
      const m = this.laneMid[id];
      const d = Math.hypot(m.x - fx, m.z - fz);
      if (d < 110 || d > 380) continue;
      const L = this.lanes.lanes[id];
      if (L.path.length < 20) continue;
      const s = this.rng.range(4, L.path.length - 4);
      const p = L.path.pointAt(s);
      if (d < 240 && this.visible(p.x, p.z, camera)) continue;
      if (actors.some((a) => Math.hypot(a.x - p.x, a.z - p.z) < 28)) continue;
      if (this.cars.some((c) => Math.hypot(c.body.x - p.x, c.body.z - p.z) < 22)) continue;
      return this.spawnAt(id, s, patrol);
    }
    return null;
  }

  /** Leader gap along the car's heading (cone check over every actor). */
  private gapAhead(c: TrafficCar, actors: Actor[]) {
    const fx = Math.sin(c.body.h), fz = Math.cos(c.body.h);
    let gap = Infinity, leadSpeed = 0;
    for (const a of actors) {
      if (a.id === c.id) continue;
      const dx = a.x - c.body.x, dz = a.z - c.body.z;
      const along = dx * fx + dz * fz;
      if (along <= 0 || along > 45) continue;
      const lat = Math.abs(dx * -fz + dz * fx);
      if (lat > 2.3 + along * 0.02) continue;
      const g = along - a.halfLength - c.body.halfLength;
      if (g < gap) {
        gap = g;
        // Speed of the leader along our direction.
        leadSpeed = a.speed * Math.max(0, Math.cos(a.h - c.body.h));
      }
    }
    return { gap, leadSpeed };
  }

  update(dt: number, focusX: number, focusZ: number, camera: THREE.Camera, actors: Actor[], allowSpawn = true) {
    this.mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.mat);
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && allowSpawn) {
      this.spawnTimer = 0.35;
      const civil = this.cars.filter((c) => !c.patrol).length;
      const patrols = this.cars.length - civil;
      // Patrols keep pace with the civilian traffic as it fills in (Ironport runs many).
      const patrolDue = patrols < this.patrols && (civil >= this.density || patrols < Math.ceil((this.patrols * civil) / Math.max(1, this.density)));
      if (patrolDue) this.trySpawn(focusX, focusZ, camera, actors, true);
      else if (civil < this.density) this.trySpawn(focusX, focusZ, camera, actors, false);
    }
    for (const c of [...this.cars]) {
      c.px = c.body.x; c.pz = c.body.z; c.ph = c.body.h;
      const dist = Math.hypot(c.body.x - focusX, c.body.z - focusZ);
      if (dist > 440 || (c.mode === 'loose' && c.looseTime > 7 && dist > 70 && !this.visible(c.body.x, c.body.z, camera))) {
        this.remove(c);
        continue;
      }
      if (c.mode === 'loose') {
        c.looseTime += dt;
        const b = c.body;
        const sp = Math.hypot(b.vx, b.vz);
        const dec = Math.min(sp, 7 * dt);
        if (sp > 1e-3) { b.vx -= (b.vx / sp) * dec; b.vz -= (b.vz / sp) * dec; }
        b.w *= Math.exp(-2.5 * dt);
        b.x += b.vx * dt;
        b.z += b.vz * dt;
        b.h += b.w * dt;
        continue;
      }
      this.drive(c, dt, actors);
    }
  }

  private drive(c: TrafficCar, dt: number, actors: Actor[]) {
    const lane = this.lanes.lanes[c.lane];
    const path = c.conn ? c.conn.path : lane.path;
    let v0 = c.v0;
    let stopAt = Infinity;
    if (!c.conn) {
      const toEnd = path.length - c.s;
      if (c.next) {
        // Slow for the turn ahead; wait if the junction is busy with a conflicting move.
        const vc = c.next.turn === 'straight' ? v0 : c.next.turn === 'uturn' ? 3 : 5.2;
        v0 = Math.min(v0, Math.sqrt(vc * vc + 2 * 2.2 * Math.max(0, toEnd - 2)));
        if (toEnd < 14) {
          const occ = this.occupancy.get(c.next.node);
          let blocked = false;
          if (occ) for (const o of occ) if (o !== c && o.conn && this.lanes.conflicts(o.conn.id, c.next.id)) { blocked = true; break; }
          if (blocked && c.wait < 6) { stopAt = toEnd - 1; c.wait += dt; } else c.wait = 0;
        }
      } else {
        stopAt = toEnd - 1; // dead end without connections
      }
    }
    const { gap, leadSpeed } = this.gapAhead(c, actors);
    const T = 1.3, a = 1.7, b = 2.6, s0 = 3;
    const v = c.speed;
    const tightGap = Math.min(gap, stopAt);
    const dv = v - (stopAt < gap ? 0 : leadSpeed);
    const sStar = s0 + v * T + (v * dv) / (2 * Math.sqrt(a * b));
    let acc = a * (1 - (v / Math.max(1, v0)) ** 4);
    if (tightGap < 80) acc -= a * (Math.max(0, sStar) / Math.max(0.5, tightGap)) ** 2;
    acc = clamp(acc, -8, a);
    c.speed = Math.max(0, v + acc * dt);
    if (tightGap < 0.8) c.speed = Math.min(c.speed, 0.5);
    c.s += c.speed * dt;
    if (c.s >= path.length) {
      const over = c.s - path.length;
      if (c.conn) {
        this.release(c);
        c.lane = c.conn.toLane;
        c.conn = null;
        c.s = over;
        c.next = this.chooseNext(c.lane);
      } else if (c.next) {
        c.conn = c.next;
        c.next = null;
        c.s = over;
        let occ = this.occupancy.get(c.conn.node);
        if (!occ) this.occupancy.set(c.conn.node, (occ = new Set()));
        occ.add(c);
      } else {
        c.s = path.length;
        c.speed = 0;
      }
    }
    this.placeOnPath(c);
  }

  /** Switch a car to loose physics after a real hit. */
  knock(c: TrafficCar) {
    if (c.mode === 'loose') return;
    c.mode = 'loose';
    c.looseTime = 0;
    this.release(c);
  }

  find(id: number) {
    return this.cars.find((c) => c.id === id);
  }

  render(alpha: number, t: number) {
    for (const c of this.cars) {
      const x = c.px + (c.body.x - c.px) * alpha;
      const z = c.pz + (c.body.z - c.pz) * alpha;
      const h = lerpAngle(c.ph, c.body.h, alpha);
      const fx = Math.sin(h) * 1.6, fz = Math.cos(h) * 1.6;
      const y = this.ground(x, z, c.body.y);
      const pitch = Math.atan((this.ground(x + fx, z + fz, c.body.y) - this.ground(x - fx, z - fz, c.body.y)) / 3.2);
      c.model.pose(x, y, z, h, -pitch, 0, 0, t * c.speed * 2.5);
      c.model.setLights(c.mode === 'drive' && c.speed < 2, false);
    }
  }
}
