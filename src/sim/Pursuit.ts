// Police units on the shared road graph: virtual sight checks, last-seen chase,
// search patterns, out-of-view reinforcements, roadblocks, bonus and finish gates.
import { MAP } from '../map/maps';
import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { District } from '../map/District';
import { ROAD_RANK } from '../map/District';
import type { LaneGraph } from '../map/lanes';
import { CarModel } from '../render/CarModel';
import { barrier, gate, laneArrows, setGateColor } from '../events/visuals';
import { AIDriver, type Skill } from './AIDriver';
import { CARS } from './cars';
import { HEAT_AWARDS, HEAT_LEVELS, HeatState, CAUGHT, SHOOT_FROM_STARS, type UnitType } from './heat';
import type { Effects } from '../render/Effects';
import { HelicopterModel } from '../render/Helicopter';
import type { StaticWorld, StaticTag } from './Physics';
import type { Traffic, TrafficCar } from './Traffic';
import { Vehicle } from './Vehicle';

export interface Unit {
  id: number;
  type: UnitType;
  v: Vehicle;
  ai: AIDriver;
  model: CarModel;
  state: 'chase' | 'search' | 'disengage' | 'wrecked';
  /** Weapon damage it can take before it is wrecked. */
  hp: number;
  maxHp: number;
  /** Seconds since it was wrecked. */
  wreckedFor: number;
  sees: boolean;
  replan: number;
  retarget: number;
  goal: { x: number; z: number; y?: number } | null;
  age: number;
  /** How the unit joined: a reinforcement from off-screen, a promoted patrol, or a posted radar unit. */
  origin: 'reinforcement' | 'patrol' | 'posted';
  /** Weapons: seconds to the next shot, rocket reload, rocket lock-on progress. */
  shotCd: number;
  reload: number;
  lock: number;
  /** Ability effects: seconds stalled (no drive) and spin rate while stalled. */
  stall: number;
  spin: number;
}

/** Something an ability can knock out: police units and event rivals. */
export interface Knockable {
  v: Vehicle;
  stall: number;
  spin: number;
}

/** A hazard the player dropped behind them. */
interface Hazard {
  kind: 'oil' | 'caltrops';
  x: number;
  z: number;
  r: number;
  life: number;
  obj: THREE.Object3D;
  hit: Set<Vehicle>;
}

/** The player's homing missile. */
interface Missile {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  target: Knockable;
  life: number;
  mesh: THREE.Mesh;
}

/** In-flight rocket from an armored unit. */
export interface Rocket {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  mesh: THREE.Mesh;
}

/** The police helicopter (flight state; the model is visual only). */
export interface Heli {
  x: number; y: number; z: number;
  vx: number; vz: number;
  h: number;
  bank: number;
  sees: boolean;
  aim: number; // marksman laser time
  shotCd: number;
  model: HelicopterModel;
  leaving: boolean;
  /** Seconds since the crew last saw the car, and seconds of clear view since then. */
  lostFor: number;
  spot: number;
  hp: number;
}

/** Weapon hit points per unit type (armor: tanks shrug off bullets). */
export const UNIT_HP: Record<UnitType, number> = { cruiser: 100, interceptor: 110, tank: 420, warden: 170 };
const HELI_HP = 300;
/** Not wrecked, not driving home. */
export const engagedUnit = (u: Unit) => u.state !== 'disengage' && u.state !== 'wrecked';

/** A spike strip laid across the road ahead. */
interface SpikeStrip {
  gate: PursuitGate;
  obj: THREE.Group;
  created: number;
  hit: boolean;
}

/** What weapons did this frame, for sound, camera and HUD. */
export type CombatEvent =
  | { type: 'shot'; x: number; z: number; hit: boolean }
  | { type: 'launch'; x: number; z: number }
  | { type: 'explosion'; x: number; z: number; dist: number; damage: number }
  | { type: 'spikes'; popped: number }
  | { type: 'heli' };

export const ROCKET = { speed: 70, radius: 10, damage: 48, lockTime: 1.4, reload: 7, life: 4 };

export interface PursuitGate {
  x: number;
  z: number;
  /** Road height at the gate (gates in tunnels sit below the street). */
  y: number;
  h: number;
  width: number;
  edge: number;
  street: string;
}

/** A parked patrol watching traffic with radar (freeway medians, main roads). */
export interface PostedUnit {
  x: number;
  z: number;
  y: number;
  h: number; // model heading (faces oncoming traffic)
  roadH: number; // travel heading of the watched carriageway
  limit: number; // m/s
  road: string;
  model: CarModel | null;
  collider: number;
  away: number; // seconds until it is re-posted after joining a chase
}

interface Roadblock {
  gate: PursuitGate;
  obj: THREE.Group;
  segs: number[];
  openSide: 1 | -1;
  created: number;
  passed: boolean;
}

const BLOCKERS = new Set<StaticTag>(['building']);
const MISSILE_MAT = new THREE.MeshStandardMaterial({ color: 0xf2ede4, emissive: 0xff4b4b, emissiveIntensity: 1.4 });
const OIL_MAT = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.92 });
const OIL_GEO = new THREE.CircleGeometry(1, 18).rotateX(-Math.PI / 2);
const ROCKET_GEO = new THREE.CylinderGeometry(0.09, 0.12, 0.9, 8).rotateX(Math.PI / 2);
const ROCKET_MAT = new THREE.MeshStandardMaterial({ color: 0x2a2f36, emissive: 0xff7a20, emissiveIntensity: 0.6 });
const SPIKE_GEO = new THREE.ConeGeometry(0.05, 0.16, 4);
const SPIKE_MAT = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 0.9, roughness: 0.3 });
let unitIds = 5000;

export class Pursuit {
  readonly heat = new HeatState();
  readonly units: Unit[] = [];
  lastSeen: { x: number; z: number; y?: number } | null = null;
  readonly gates: PursuitGate[] = [];
  bonus: { gate: PursuitGate; obj: THREE.Group; expires: number } | null = null;
  private bonusCooldown = 0;
  roadblocks: Roadblock[] = [];
  finish: { gate: PursuitGate; obj: THREE.Group } | null = null;
  private spawnTimer = 0;
  private rng = new Rng(77);
  private clock = 0;
  warning: string | null = null;
  messages: { big: string; small: string }[] = [];
  /** Credits banked by bonus gates during this pursuit. */
  bonusCredits = 0;
  reducedFlashing = false;
  /** Surface height at a point (terrain or deck chosen by the height hint). */
  ground: (x: number, z: number, yHint?: number) => number = () => 0;
  /** Roof over a point (stacked maps), so airborne units bump decks instead of passing through. */
  ceiling: ((x: number, z: number, y: number) => number) | null = null;
  readonly posted: PostedUnit[] = [];
  /** Visual effects (smoke, tracers, explosions); set by the game. */
  effects: Effects | null = null;
  /** Is the player hidden from the air here (tree canopy, under a bridge deck)? Set by the game. */
  coverAt: (x: number, z: number, y: number) => boolean = () => false;
  readonly rockets: Rocket[] = [];
  heli: Heli | null = null;
  // ---- the player's abilities
  /** Seconds the player is invisible to police (Phantom). */
  cloak = 0;
  /** Seconds police kit is jammed: no shots, locks, radar or helicopter eyes (EMP). */
  jam = 0;
  /** Smoke clouds that block police sight (Smoke Screen). */
  readonly smoke: { x: number; z: number; r: number; life: number }[] = [];
  readonly hazards: Hazard[] = [];
  readonly missiles: Missile[] = [];
  /** Event rivals that abilities can also hit (set by the game). */
  others: Knockable[] = [];
  spikes: SpikeStrip[] = [];
  readonly combat: CombatEvent[] = [];
  /** A unit has its sights on the player (rocket lock or marksman laser). */
  locked: 'rocket' | 'marksman' | null = null;
  /** Difficulty: hit chance and rocket reload multipliers. */
  copAccuracy = 1;
  rocketReload = 1;
  private spikeCooldown = 0;
  /** Difficulty: police pace and sight multipliers; m/s over the limit radar allows. */
  copPace = 1;
  copSight = 1;
  radarTolerance = 2.2;
  /** Set during timed events: posted units clock you but do not give chase. */
  radarWarnOnly = false;
  /** Ironport: any officer who sees you starts a chase. The game turns this off in events and near the garage. */
  spotting = false;
  private spotCooldown = 0;
  /** Extra units on top of each heat level's cap (Ironport: the city is full of police). */
  extraUnits = 0;
  /** The map's own police force ('warden' on Hollowpeak), or the usual mix. */
  force: 'standard' | 'warden' = 'standard';
  /** Seconds before a new helicopter can come after one was shot down. */
  private heliCooldown = 0;
  /** Police units wrecked by the player's weapons (this session). */
  takedowns = 0;
  /** Last radar reading for the HUD: `{ mph, road, t }`. */
  radar: { mph: number; road: string; t: number } | null = null;

  constructor(
    private d: District,
    private lanes: LaneGraph,
    private scene: THREE.Scene,
    private statics: StaticWorld,
    private traffic: Traffic,
    private beamTex: THREE.Texture,
  ) {
    // Designated pursuit gates: mid-block points on collector streets, spread out.
    const cands = d.edges
      .filter((e) => (ROAD_RANK[e.cls] ?? 1) >= 3 && !e.bridge && e.length > 90)
      .map((e) => {
        const p = e.path.pointAt(e.length / 2);
        return { x: p.x, z: p.z, y: d.heightOnEdge(e.index, e.length / 2), h: e.path.headingAt(e.length / 2), width: e.width, edge: e.index, street: e.name };
      });
    for (const c of cands) if (this.gates.every((g) => Math.hypot(g.x - c.x, g.z - c.z) > 170)) this.gates.push(c);
  }

  get active() {
    return this.heat.stars > 0;
  }

  /** Can a patrol or unit see the point? Used to decide whether a crash was witnessed. */
  witness(x: number, z: number, y?: number): { unit?: Unit; patrol?: TrafficCar } | null {
    const range = 125;
    for (const u of this.units) {
      if (!engagedUnit(u)) continue;
      if (Math.hypot(u.v.x - x, u.v.z - z) < range && this.los(u.v.x, u.v.z, x, z, u.v.y, y)) return { unit: u };
    }
    for (const c of this.traffic.cars) {
      if (!c.patrol || c.mode !== 'drive') continue;
      if (Math.hypot(c.body.x - x, c.body.z - z) < range && this.los(c.body.x, c.body.z, x, z, c.body.y, y)) return { patrol: c };
    }
    return null;
  }

  /**
   * Line of sight. With heights: when one of the two is under a roof that the other
   * is above (a deck, a tunnel lid, a cave or a tube), they cannot see each other
   * unless they are close. A plain height difference (hills) does not block.
   */
  los(ax: number, az: number, bx: number, bz: number, ay?: number, by?: number) {
    const d = Math.hypot(bx - ax, bz - az);
    if (d < 1) return true;
    if (ay !== undefined && by !== undefined && Math.abs(ay - by) > 6 && d > 28 && this.ceiling) {
      const low = ay < by ? { x: ax, z: az, y: ay } : { x: bx, z: bz, y: by };
      if (this.ceiling(low.x, low.z, low.y) < Math.max(ay, by)) return false;
    }
    const y = ay !== undefined && by !== undefined ? Math.min(ay, by) + 1.2 : undefined;
    return this.statics.raycast(ax, az, bx - ax, bz - az, d - 1, BLOCKERS, y) === Infinity;
  }

  /** Posted units: the freeway median every ~800 m each way (Lake Country), plus the main roads. */
  setupPosted() {
    const spots: { x: number; z: number; h: number; roadH: number; limit: number; road: string }[] = [];
    const along = (cls: (c: string, e: { name: string; oneway: boolean }) => boolean, spacing: number, limit: number, lateral: (w: number) => number) => {
      let acc = spacing * 0.5;
      for (const e of this.d.edges) {
        if (!cls(e.cls, e) || e.bridge || e.level < 0) continue;
        for (let s = 0; s < e.length; s += 10) {
          acc += 10;
          if (acc < spacing || s < 25 || s > e.length - 25) continue;
          const p = e.path.pointAt(s);
          if (spots.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < spacing * 0.6)) continue;
          acc = 0;
          const h = e.path.headingAt(s);
          const lat = lateral(e.width);
          const x = p.x - Math.cos(h) * lat, z = p.z + Math.sin(h) * lat;
          spots.push({ x, z, h: h + Math.PI - 0.25 * Math.sign(lat), roadH: h, limit, road: e.name || 'the freeway' });
        }
      }
    };
    // Freeway: in the grass median (left of each one-way carriageway), facing oncoming cars.
    const fw = MAP.postedFreeway;
    if (fw) along((c, e) => c === 'motorway' && e.name === fw, 800, 75 * 0.44704, (w) => -(w / 2 + 4.2));
    // Main roads: on the right shoulder, nose out.
    along((c) => MAP.postedRoads.includes(c), MAP.postedSpacing, 55 * 0.44704, (w) => w / 2 + 3.2);
    for (const sp of spots) {
      const y = this.ground(sp.x, sp.z, -1e9);
      const collider = this.statics.addCircle(sp.x, sp.z, 1.6, 'parked', y - 1, y + 2);
      this.posted.push({ ...sp, y, model: null, collider, away: 0 });
    }
  }

  private updatePosted(dt: number, player: Vehicle, quiet: boolean) {
    const sp = Math.hypot(player.vx, player.vz);
    for (const p of this.posted) {
      const d = Math.hypot(p.x - player.x, p.z - player.z);
      if (p.away > 0) {
        p.away -= dt;
        if (p.away <= 0 && d < 300) p.away = 5; // never re-post in plain sight
        if (p.away <= 0) this.statics.disabledCircles.delete(p.collider);
        continue;
      }
      // Models only near the player.
      if (d < 650 && !p.model) {
        p.model = new CarModel('cruiser', CARS.cruiser.paints[0], { beamTex: this.beamTex });
        p.model.pose(p.x, p.y, p.z, p.h, 0, 0, 0, 0);
        p.model.setLights(false, false);
        this.scene.add(p.model.root);
      } else if (d > 720 && p.model) {
        this.scene.remove(p.model.root);
        p.model.dispose();
        p.model = null;
      }
      if (p.model) p.model.setSiren(false, 0, this.reducedFlashing);
      if (d > 95 || Math.abs(player.y - p.y) > 6) continue;
      const speeding = sp > p.limit + this.radarTolerance;
      // Ironport: a known car, so the unit pulls out at any speed.
      const known = this.spotting && this.heat.stars === 0 && this.spotCooldown <= 0 && this.cloak <= 0;
      if (!(speeding || known) || this.jam > 0 || !this.los(p.x, p.z, player.x, player.z, p.y + 1, player.y)) continue;
      const mph = Math.round(sp / 0.44704);
      if (speeding) this.radar = { mph, road: p.road, t: this.clock };
      // Quiet Drive, and timed events (other than the opt-in chases), only get a warning.
      if ((quiet || this.radarWarnOnly) && !this.heat.forced) continue;
      // Clocked: this unit pulls out and joins (or starts) the pursuit.
      const before = this.heat.stars;
      if (speeding) this.heat.award(HEAT_AWARDS.speedTrap, `Clocked at ${mph} mph on ${p.road}`, this.clock, p.collider + 900000);
      else this.heat.award(HEAT_AWARDS.spotted, `Spotted by a posted unit on ${p.road}`, this.clock, p.collider + 900000);
      if (this.heat.stars === 0 && before === 0) continue;
      // Join the chase only while the heat level has room for another unit.
      const engaged = this.units.filter(engagedUnit).length;
      if (engaged >= Math.max(1, HEAT_LEVELS[this.heat.stars].maxUnits + this.extraUnits)) { this.lastSeen = { x: player.x, z: player.z, y: player.y }; continue; }
      const u = this.makeUnit(this.heat.stars >= 3 ? 'interceptor' : 'cruiser', p.x, p.z, p.roadH, 0, p.y);
      u.state = 'chase';
      u.origin = 'posted';
      u.goal = { x: player.x, z: player.z, y: player.y };
      u.replan = 0;
      this.lastSeen = { x: player.x, z: player.z, y: player.y };
      if (p.model) { this.scene.remove(p.model.root); p.model.dispose(); p.model = null; }
      this.statics.disabledCircles.add(p.collider);
      p.away = 60;
      this.messages.push(speeding ? { big: `Clocked · ${mph} mph`, small: `Posted unit on ${p.road} is pulling out` } : { big: 'Spotted', small: `Posted unit on ${p.road} is pulling out` });
    }
  }

  private makeUnit(type: UnitType, x: number, z: number, h: number, speed: number, yHint = -1e9): Unit {
    const spec = CARS[type];
    const v = new Vehicle(spec);
    v.id = unitIds++;
    v.ground = this.ground;
    v.ceiling = this.ceiling;
    v.placeAt(x, z, yHint, h);
    v.vx = Math.sin(h) * speed;
    v.vz = Math.cos(h) * speed;
    const skill: Skill = type === 'warden'
      ? { latBudget: 11.5 * Math.sqrt(this.copPace), brakeDecel: 12, brakeOptimism: this.rng.range(1.0, 1.2), maxSpeed: 105 * this.copPace, lookahead: 8.5 }
      : type === 'interceptor'
      ? { latBudget: 10 * Math.sqrt(this.copPace), brakeDecel: 10.5, brakeOptimism: this.rng.range(0.95, 1.25), maxSpeed: 84 * this.copPace, lookahead: 7.5 }
      : type === 'tank'
        ? { latBudget: 6.6 * Math.sqrt(this.copPace), brakeDecel: 7.5, brakeOptimism: 1, maxSpeed: 46 * this.copPace, lookahead: 8.5 }
        : { latBudget: 8.8 * Math.sqrt(this.copPace), brakeDecel: 9.8, brakeOptimism: this.rng.range(0.95, 1.35), maxSpeed: 64 * this.copPace, lookahead: 7 };
    const ai = new AIDriver(skill);
    const model = new CarModel(type, spec.paints[0], { beamTex: this.beamTex });
    this.scene.add(model.root);
    const u: Unit = { id: v.id, type, v, ai, model, state: 'chase', hp: UNIT_HP[type], maxHp: UNIT_HP[type], wreckedFor: 0, sees: false, replan: 0, retarget: 0, goal: null, age: 0, origin: 'reinforcement', shotCd: this.rng.range(1, 3), reload: this.rng.range(2, 4), lock: 0, stall: 0, spin: 0 };
    this.units.push(u);
    return u;
  }

  private removeUnit(u: Unit) {
    const i = this.units.indexOf(u);
    if (i >= 0) this.units.splice(i, 1);
    this.scene.remove(u.model.root);
    u.model.dispose();
  }

  /** Turn a cruising patrol into the first engaged unit. */
  promote(c: TrafficCar) {
    const u = this.makeUnit(c.type === 'warden' ? 'warden' : this.force === 'warden' ? 'warden' : 'cruiser', c.body.x, c.body.z, c.body.h, c.speed, c.body.y);
    u.origin = 'patrol';
    this.traffic.remove(c);
    return u;
  }

  /** Spawn a reinforcement on a connected road, out of view and at a fair distance. */
  spawnReinforcement(type: UnitType, px: number, pz: number, frustum: THREE.Frustum, minDist = 170) {
    const sphere = new THREE.Sphere(new THREE.Vector3(), 5);
    let best: { lane: number; s: number; score: number } | null = null;
    for (let i = 0; i < 60; i++) {
      // Sample around the player (not the whole map): a random point in the ring,
      // then a lane on the road nearest it.
      const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(minDist, 430);
      const hit = this.d.nearestEdge(px + Math.cos(a) * r, pz + Math.sin(a) * r, 80);
      if (!hit) continue;
      const laneIds = this.lanes.lanesByEdge[hit.edge];
      if (!laneIds?.length) continue;
      const id = laneIds[this.rng.int(0, laneIds.length - 1)];
      const L = this.lanes.lanes[id];
      if (L.path.length < 20) continue;
      const s = Math.max(5, Math.min(L.path.length - 5, L.path.project(hit.x, hit.z).s));
      const p = L.path.pointAt(s);
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d < minDist || d > 430) continue;
      sphere.center.set(p.x, 1, p.z);
      if (frustum.intersectsSphere(sphere)) continue;
      if (this.units.some((u) => Math.hypot(u.v.x - p.x, u.v.z - p.z) < 40)) continue;
      if (this.traffic.cars.some((c) => Math.hypot(c.body.x - p.x, c.body.z - p.z) < 14)) continue;
      const score = Math.abs(d - (minDist + 70)) + this.rng.range(0, 60);
      if (!best || score < best.score) best = { lane: id, s, score };
    }
    if (!best) return null;
    const L = this.lanes.lanes[best.lane];
    const p = L.path.pointAt(best.s);
    const E = this.d.edges[L.edge];
    const y = E.ys.length ? this.d.heightOnEdge(L.edge, E.path.project(p.x, p.z).s) : E.bridge ? 1e9 : -1e9;
    return this.makeUnit(type, p.x, p.z, L.path.headingAt(best.s), 12, y);
  }

  private routeTo(u: Unit, x: number, z: number, y?: number) {
    const pts = this.d.pathBetween(u.v.x, u.v.z, x, z, false, undefined, u.v.y, y);
    u.ai.setPath(pts ?? [u.v.x, u.v.z, x, z]);
  }

  update(dt: number, player: Vehicle, camera: THREE.Camera, frustum: THREE.Frustum, quiet: boolean) {
    this.clock += dt;
    this.heat.quiet = quiet;
    this.cloak = Math.max(0, this.cloak - dt);
    this.jam = Math.max(0, this.jam - dt);
    this.updateAbilityFx(dt, player);
    this.spotCooldown = Math.max(0, this.spotCooldown - dt);
    if (this.spotting && !quiet && this.heat.stars === 0 && this.spotCooldown <= 0 && this.jam <= 0) this.spotByPatrol(player);
    const lvl = HEAT_LEVELS[this.heat.stars];
    let anySees = false;
    let pinned = false;
    for (const u of [...this.units]) {
      u.age += dt;
      const dx = player.x - u.v.x, dz = player.z - u.v.z;
      const dist = Math.hypot(dx, dz);
      if (u.state === 'wrecked') {
        u.sees = false;
        u.wreckedFor += dt;
        if (this.rng.next() < dt * 8) this.effects?.smokePuff(u.v.x, u.v.y + 1.2, u.v.z, 1);
        if (u.wreckedFor < 6 && this.rng.next() < dt * 10) this.effects?.fire(u.v.x, u.v.y + 0.9, u.v.z);
        if (u.wreckedFor > 20 || (dist > 320 && u.wreckedFor > 4)) this.removeUnit(u);
        continue;
      }
      if (u.state === 'disengage') {
        u.sees = false;
        const sphere = new THREE.Sphere(new THREE.Vector3(u.v.x, 1, u.v.z), 4);
        if ((dist > 220 && !frustum.intersectsSphere(sphere)) || u.age > 40 || dist > 500) this.removeUnit(u);
        continue;
      }
      // Wardens know the car: Phantom and smoke do not fool them, and they see further.
      const warden = u.type === 'warden';
      u.sees = (warden || this.cloak <= 0) && u.stall <= 0 && dist < lvl.sight * this.copSight * (warden ? 1.5 : 1) && this.los(u.v.x, u.v.z, player.x, player.z, u.v.y, player.y) && (warden || !this.smokeBetween(u.v.x, u.v.z, player.x, player.z));
      if (u.sees) anySees = true;
      if (dist < CAUGHT.radius && player.speed < CAUGHT.speed && u.sees && !player.mods.invincible) pinned = true;
    }
    // The helicopter keeps sight from the air unless the player is under cover.
    if (this.updateHeli(dt, player)) anySees = true;
    if (anySees || (this.heat.active && !this.heat.contact)) this.lastSeen = { x: player.x, z: player.z, y: player.y };

    // Unit behaviour.
    for (const u of this.units) {
      if (!engagedUnit(u)) continue;
      u.replan -= dt;
      u.retarget -= dt;
      const dist = Math.hypot(player.x - u.v.x, player.z - u.v.z);
      // Before first contact, dispatch knows roughly where the call came from.
      if (this.heat.phase === 'pursuit' && (u.sees || anySees || !this.heat.contact)) {
        u.state = 'chase';
        // Radio: units that cannot see still head for the shared position.
        if (u.retarget <= 0) {
          u.retarget = 0.3;
          const lead = Math.min(1.2, dist / 40);
          u.goal = { x: player.x + player.vx * lead, z: player.z + player.vz * lead, y: player.y };
        }
        // Box in a stopped player: hold position close by instead of ramming.
        u.ai.hold = u.sees && dist < CAUGHT.radius - 1.5 && player.speed < CAUGHT.speed;
        if (dist < 42 && u.sees) {
          u.ai.directTarget = u.goal;
          u.ai.speedCap = dist < 18 ? Math.max(4, dist * 0.6) : Infinity;
        } else {
          u.ai.directTarget = null;
          if (u.replan <= 0 && u.goal) {
            u.replan = 0.9;
            this.routeTo(u, u.goal.x, u.goal.z, u.goal.y);
          }
        }
      } else if (this.heat.active && this.lastSeen) {
        // Search: drive to the last-seen spot, then sweep nearby junctions.
        u.ai.directTarget = null;
        u.ai.hold = false;
        const atGoal = u.goal && Math.hypot(u.goal.x - u.v.x, u.goal.z - u.v.z) < 22;
        if (u.state !== 'search') {
          u.state = 'search';
          u.goal = { ...this.lastSeen };
          u.replan = 0;
        } else if (atGoal) {
          const near = this.d.nodes.filter((n) => Math.hypot(n.x - this.lastSeen!.x, n.z - this.lastSeen!.z) < 260);
          const n = near.length ? this.rng.pick(near) : this.rng.pick(this.d.nodes);
          u.goal = { x: n.x, z: n.z, y: this.d.data.nodeY?.[n.index] };
          u.replan = 0;
        }
        u.ai.speedCap = 22;
        if (u.replan <= 0 && u.goal) {
          u.replan = 4;
          this.routeTo(u, u.goal.x, u.goal.z, u.goal.y);
        }
      }
    }

    // Reinforcements up to the cap for the current heat.
    if (this.heat.active) {
      this.spawnTimer -= dt;
      const engaged = this.units.filter(engagedUnit);
      if (engaged.length < lvl.maxUnits + this.extraUnits && this.spawnTimer <= 0) {
        this.spawnTimer = engaged.length === 0 ? 0.5 : this.extraUnits > 0 ? 2.2 : 3.5;
        const rostered = lvl.roster[engaged.length] ?? 'cruiser';
        // A map's own force (the Wardens) replaces the patrol cars and interceptors.
        const type = this.force === 'warden' && rostered !== 'tank' ? 'warden' : rostered;
        const u = this.spawnReinforcement(type, player.x, player.z, frustum, engaged.length === 0 ? 120 : 170);
        if (u && this.lastSeen) { u.goal = { ...this.lastSeen }; u.replan = 0; }
      }
    }

    this.updatePosted(dt, player, quiet);
    this.updateWeapons(dt, player);
    this.heat.update(dt, anySees, pinned);
    this.updateSetPieces(dt, player);
    for (const ev of this.heat.events) {
      if (ev.type === 'escaped' || ev.type === 'caught') {
        this.standDown();
        // A breather before the next patrol picks you up again.
        this.spotCooldown = 25;
      }
    }
  }

  /** Ironport: a patrol car that sees you pulls over and becomes the first unit. */
  private spotByPatrol(player: Vehicle) {
    for (const c of this.traffic.cars) {
      if (!c.patrol || c.mode !== 'drive') continue;
      const warden = c.type === 'warden';
      if (!warden && this.cloak > 0) continue;
      if (Math.hypot(c.body.x - player.x, c.body.z - player.z) > (warden ? 230 : 110)) continue;
      if (!this.los(c.body.x, c.body.z, player.x, player.z, c.body.y, player.y)) continue;
      const street = this.d.streetNameAt(player.x, player.z, undefined, player.y);
      if (warden) {
        // A Warden knows the car on sight: straight to two stars.
        if (this.heat.quiet && !this.heat.forced) return;
        this.heat.setStars(2, `A Warden made you${street ? ` on ${street}` : ''}`);
      } else if (!this.heat.award(HEAT_AWARDS.spotted, `Spotted by a patrol${street ? ` on ${street}` : ''}`, this.clock)) return;
      const u = this.promote(c);
      u.state = 'chase';
      u.goal = { x: player.x, z: player.z, y: player.y };
      u.replan = 0;
      this.lastSeen = { x: player.x, z: player.z, y: player.y };
      this.messages.push(warden ? { big: 'Warden', small: 'They know this car. Run.' } : { big: 'Spotted', small: 'A patrol car has you' });
      return;
    }
  }

  /** All units disengage and set pieces are cleared. */
  standDown() {
    for (const u of this.units) {
      if (u.state === 'wrecked') continue;
      u.state = 'disengage';
      u.ai.hold = false;
      u.ai.directTarget = null;
      u.ai.speedCap = 14;
      const far = this.rng.pick(this.d.nodes);
      this.routeTo(u, far.x, far.z);
      u.age = 0;
    }
    this.clearSetPieces();
    this.lastSeen = null;
  }

  clearSetPieces() {
    for (const s of this.spikes) this.scene.remove(s.obj);
    this.spikes = [];
    for (const r of this.rockets) this.scene.remove(r.mesh);
    this.rockets.length = 0;
    for (const m of this.missiles) this.scene.remove(m.mesh);
    this.missiles.length = 0;
    for (const hz of this.hazards) this.scene.remove(hz.obj);
    this.hazards.length = 0;
    this.smoke.length = 0;
    this.cloak = 0;
    this.jam = 0;
    if (this.heli) this.heli.leaving = true;
    this.locked = null;
    if (this.bonus) { this.scene.remove(this.bonus.obj); this.bonus = null; }
    for (const r of this.roadblocks) this.removeRoadblock(r);
    this.roadblocks = [];
    if (this.finish) { this.scene.remove(this.finish.obj); this.finish = null; }
    this.warning = null;
  }

  /** Remove every unit immediately (garage restart). */
  clearAll() {
    for (const u of [...this.units]) this.removeUnit(u);
    this.radar = null;
    this.removeHeli();
    this.clearSetPieces();
    this.heat.reset();
    this.heat.forced = false;
    this.heat.hold = false;
    this.lastSeen = null;
  }

  private gateCrossed(g: PursuitGate, player: Vehicle) {
    const fx = Math.sin(g.h), fz = Math.cos(g.h);
    const dx = player.x - g.x, dz = player.z - g.z;
    const along = dx * fx + dz * fz;
    const lat = Math.abs(dx * -fz + dz * fx);
    return Math.abs(along) < 3 && lat < g.width / 2 + 1.5;
  }

  private pickGate(player: Vehicle, minD: number, maxD: number, ahead: boolean) {
    const sp = Math.hypot(player.vx, player.vz);
    const cands = this.gates.filter((g) => {
      const d = Math.hypot(g.x - player.x, g.z - player.z);
      if (d < minD || d > maxD) return false;
      if (this.roadblocks.some((r) => r.gate === g) || this.bonus?.gate === g || this.finish?.gate === g) return false;
      // Same level as the player (no roadblocks in a tunnel under someone on a viaduct).
      if (Math.abs(g.y - player.y) > 6) return false;
      if (ahead && sp > 3) return ((g.x - player.x) * player.vx + (g.z - player.z) * player.vz) / (d * sp) > 0.35;
      return true;
    });
    return cands.length ? this.rng.pick(cands) : null;
  }

  private updateSetPieces(dt: number, player: Vehicle) {
    const lvl = HEAT_LEVELS[this.heat.stars];
    const t = this.clock;
    // Heat 3+: optional bonus gate.
    this.bonusCooldown -= dt;
    if (lvl.bonusGate && !this.bonus && this.bonusCooldown <= 0 && this.heat.phase === 'pursuit') {
      const g = this.pickGate(player, 220, 600, false);
      if (g) {
        const obj = gate(g.width + 3, 0xffd34d, 'BONUS GATE', 5.5);
        obj.position.set(g.x, this.ground(g.x, g.z, -1e9), g.z);
        obj.rotation.y = g.h;
        this.scene.add(obj);
        this.bonus = { gate: g, obj, expires: t + 70 };
        this.messages.push({ big: 'Bonus gate', small: `${g.street || 'Marked street'} · ${Math.round(600 * lvl.multiplier)} cr` });
      }
    }
    if (this.bonus) {
      if (this.gateCrossed(this.bonus.gate, player)) {
        const amount = Math.round(600 * lvl.multiplier);
        this.bonusCredits += amount;
        this.heat.score += amount;
        this.heat.award(HEAT_AWARDS.bonusGate, 'Bonus gate run', t);
        this.messages.push({ big: `+${amount} cr`, small: 'Bonus gate' });
        this.scene.remove(this.bonus.obj);
        this.bonus = null;
        this.bonusCooldown = 40;
      } else if (t > this.bonus.expires || !lvl.bonusGate) {
        this.scene.remove(this.bonus.obj);
        this.bonus = null;
        this.bonusCooldown = 20;
      }
    }
    // Heat 4+: telegraphed roadblocks with a readable open lane.
    if (lvl.roadblocks && this.roadblocks.length < 2 && this.heat.phase === 'pursuit' && Math.floor(t * 2) % 6 === 0) {
      const g = this.pickGate(player, 190, 460, true);
      if (g) this.addRoadblock(g, t);
    }
    let warn: string | null = null;
    for (const r of [...this.roadblocks]) {
      const d = Math.hypot(r.gate.x - player.x, r.gate.z - player.z);
      if (!r.passed && this.gateCrossed(r.gate, player)) {
        r.passed = true;
        this.heat.award(HEAT_AWARDS.roadblockRun, 'Ran a roadblock', t);
        this.messages.push({ big: 'Through the gap', small: 'Roadblock cleared' });
      }
      if (d > 520 || t - r.created > 50 || !lvl.roadblocks) {
        this.removeRoadblock(r);
        this.roadblocks.splice(this.roadblocks.indexOf(r), 1);
        continue;
      }
      if (!r.passed && d < 470) warn = `ROADBLOCK AHEAD · ${r.gate.street || 'next block'} · open lane on the ${r.openSide > 0 ? 'right' : 'left'}`;
      const lamp = r.obj.userData.lampMat as THREE.MeshStandardMaterial;
      lamp.emissiveIntensity = this.reducedFlashing ? 3 : Math.floor(t * 4) % 2 ? 6 : 0.6;
    }
    // Heat 5: crescendo finish gate.
    for (const ev of this.heat.events) {
      if (ev.type === 'crescendo-start' && !this.heat.forced) {
        const g = this.pickGate(player, 450, 950, false) ?? this.pickGate(player, 250, 1400, false);
        if (g) {
          const obj = gate(g.width + 4, 0xffffff, 'FINISH — END THE RUN', 6.5);
          obj.position.set(g.x, this.ground(g.x, g.z, -1e9), g.z);
          obj.rotation.y = g.h;
          this.scene.add(obj);
          this.finish = { gate: g, obj };
          this.messages.push({ big: 'Five stars', small: `Reach the finish gate on ${g.street || 'the marked street'} before the crescendo ends` });
        }
      }
      if (ev.type === 'crescendo-end' && this.finish) {
        this.scene.remove(this.finish.obj);
        this.finish = null;
        this.messages.push({ big: 'Finish gate closed', small: 'Lose them the old-fashioned way' });
      }
    }
    if (this.finish) {
      setGateColor(this.finish.obj, Math.floor(t * 2) % 2 ? 0xffffff : 0xffd34d);
      if (this.gateCrossed(this.finish.gate, player)) this.finishReached = true;
    }
    if (this.heat.crescendo > 0 && this.finish) warn = `CRESCENDO ${Math.ceil(this.heat.crescendo)}s · finish gate on ${this.finish.gate.street || 'the marked street'}`;
    this.warning = warn ?? this.spikeWarning;
  }
  finishReached = false;

  private addRoadblock(g: PursuitGate, t: number) {
    const openSide: 1 | -1 = this.rng.chance(0.5) ? 1 : -1;
    const lane = 3.8;
    const blockLen = g.width - lane;
    const obj = new THREE.Group();
    const gy = this.ground(g.x, g.z, -1e9);
    obj.position.set(g.x, gy, g.z);
    obj.rotation.y = g.h;
    // Local +x is the driver's left when facing +z. openSide +1 = open lane on the right.
    const b = barrier(blockLen);
    b.position.x = (openSide * lane) / 2;
    obj.add(b);
    obj.userData.lampMat = b.userData.lampMat;
    const arrows = laneArrows(0x79d98a);
    arrows.position.x = -openSide * (g.width / 2 - lane / 2);
    obj.add(arrows);
    this.scene.add(obj);
    obj.updateMatrixWorld(true);
    const a = new THREE.Vector3(-blockLen / 2, 0, 0).applyMatrix4(b.matrixWorld);
    const c = new THREE.Vector3(blockLen / 2, 0, 0).applyMatrix4(b.matrixWorld);
    const segs = [this.statics.addSegment(a.x, a.z, c.x, c.z, 'barrier', gy - 1, gy + 1.6)];
    this.roadblocks.push({ gate: g, obj, segs, openSide, created: t, passed: false });
    this.messages.push({ big: 'Roadblock ahead', small: `${g.street || 'Marked street'} · look for the green arrows` });
  }

  private removeRoadblock(r: Roadblock) {
    this.scene.remove(r.obj);
    for (const s of r.segs) this.statics.disabled.add(s);
  }

  // ------------------------------------------------------------------ weapons
  private rand = () => this.rng.next();

  private spikeWarning: string | null = null;

  private updateWeapons(dt: number, player: Vehicle) {
    this.locked = null;
    const stars = this.heat.stars;
    const lvl = HEAT_LEVELS[stars];
    const fx = this.effects;
    if (this.heat.active && this.heat.phase === 'pursuit' && !player.totaled && this.jam <= 0) {
      for (const u of this.units) {
        if (u.state !== 'chase' || u.stall > 0) continue;
        const dx = player.x - u.v.x, dz = player.z - u.v.z;
        const dist = Math.hypot(dx, dz);
        if (u.type === 'tank') { this.tankWeapon(u, dt, player, dist); continue; }
        // Tire shots: from 3 stars, close behind or beside, in the unit's forward arc.
        if (stars < SHOOT_FROM_STARS || !u.sees || dist < 9 || dist > 55) continue;
        const ahead = (dx * Math.sin(u.v.h) + dz * Math.cos(u.v.h)) / Math.max(1, dist);
        if (ahead < 0.2) continue;
        u.shotCd -= dt;
        if (u.shotCd > 0) continue;
        u.shotCd = this.rng.range(1.6, 2.6) / Math.max(0.3, this.copAccuracy);
        const side = this.rng.chance(0.5) ? 1 : -1;
        const mx = u.v.x - Math.cos(u.v.h) * side * 1.05, mz = u.v.z + Math.sin(u.v.h) * side * 1.05, my = u.v.y + 1.3;
        const rel = Math.hypot(player.vx - u.v.vx, player.vz - u.v.vz);
        const p = (0.16 + 0.05 * (stars - SHOOT_FROM_STARS)) * this.copAccuracy * (1 - Math.min(0.5, Math.max(0, (rel - 5) / 40))) * (dist < 30 ? 1 : 0.7);
        const hit = !player.airborne && this.rand() < p;
        const tx = player.x + (this.rng.next() - 0.5) * (hit ? 0.8 : 4), tz = player.z + (this.rng.next() - 0.5) * (hit ? 0.8 : 4);
        fx?.muzzle(mx, my, mz);
        fx?.tracer(mx, my, mz, tx, player.y + 0.4, tz);
        if (hit) {
          const t = player.popTire(undefined, this.rand);
          if (t < 0) player.hurt(3);
          fx?.sparks(tx, player.y + 0.3, tz, 10);
        } else fx?.sparks(tx, this.ground(tx, tz, player.y) + 0.05, tz, 4);
        this.combat.push({ type: 'shot', x: mx, z: mz, hit });
      }
    }
    // Rockets in flight.
    for (const r of [...this.rockets]) {
      const px = r.x, pz = r.z;
      r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
      r.life -= dt;
      r.mesh.position.set(r.x, r.y, r.z);
      r.mesh.lookAt(r.x + r.vx, r.y + r.vy, r.z + r.vz);
      fx?.trail(r.x - r.vx * 0.02, r.y - r.vy * 0.02, r.z - r.vz * 0.02);
      const ground = this.ground(r.x, r.z, r.y);
      const toCar = Math.hypot(r.x - player.x, r.y - (player.y + 0.8), r.z - player.z);
      const seg = Math.hypot(r.x - px, r.z - pz);
      const wall = seg > 0 && r.y < ground + 9 ? this.statics.raycast(px, pz, r.x - px, r.z - pz, seg, BLOCKERS) : Infinity;
      if (toCar < 2.4 || r.y < ground + 0.2 || wall < Infinity || r.life <= 0) {
        if (wall < Infinity) { r.x = px + ((r.x - px) / seg) * wall; r.z = pz + ((r.z - pz) / seg) * wall; }
        this.explode(r.x, Math.max(r.y, ground), r.z, player);
        this.scene.remove(r.mesh);
        this.rockets.splice(this.rockets.indexOf(r), 1);
      }
    }
    // Spike strips (4 stars+): laid across the road ahead, shoulders left open.
    this.spikeCooldown -= dt;
    if (lvl.spikes && this.heat.phase === 'pursuit' && this.spikes.length < 1 && this.spikeCooldown <= 0) {
      const g = this.pickGate(player, 150, 380, true);
      if (g) this.addSpikes(g);
      this.spikeCooldown = 14;
    }
    let spikeWarn: string | null = null;
    for (const s of [...this.spikes]) {
      const d = Math.hypot(s.gate.x - player.x, s.gate.z - player.z);
      if (!s.hit && !player.airborne) {
        const ffx = Math.sin(s.gate.h), ffz = Math.cos(s.gate.h);
        const ddx = player.x - s.gate.x, ddz = player.z - s.gate.z;
        const along = ddx * ffx + ddz * ffz, lat = Math.abs(-ddx * ffz + ddz * ffx);
        if (Math.abs(along) < 1.6 && lat < s.gate.width / 2 - 0.5 + player.halfWidth * 0.5) {
          s.hit = true;
          let popped = 0;
          for (const i of [0, 1]) if (player.popTire(i) >= 0) popped++;
          for (const i of [2, 3]) if (this.rand() < 0.7 && player.popTire(i) >= 0) popped++;
          fx?.sparks(player.x, player.y + 0.3, player.z, 24);
          this.combat.push({ type: 'spikes', popped });
          this.messages.push({ big: 'Spike strip', small: popped ? `${popped} tire${popped > 1 ? 's' : ''} gone` : 'Missed you' });
        }
      }
      if (d > 520 || this.clock - s.created > 45 || (s.hit && d > 60)) {
        this.scene.remove(s.obj);
        this.spikes.splice(this.spikes.indexOf(s), 1);
      } else if (!s.hit && d < 420) {
        spikeWarn = `SPIKE STRIP AHEAD · ${s.gate.street || 'next block'} · use the shoulder or jump it`;
      }
    }
    this.spikeWarning = spikeWarn;
  }

  /** Armored unit: turret tracks the player; a held lock fires a led rocket. */
  private tankWeapon(u: Unit, dt: number, player: Vehicle, dist: number) {
    const turret = u.model.turret;
    const yaw = Math.atan2(player.x - u.v.x, player.z - u.v.z) - u.v.h;
    if (turret) {
      const cur = turret.rotation.y;
      const d = Math.atan2(Math.sin(yaw - cur), Math.cos(yaw - cur));
      turret.rotation.y = cur + Math.max(-2.2 * dt, Math.min(2.2 * dt, d));
    }
    u.reload -= dt;
    const aimed = turret ? Math.abs(Math.atan2(Math.sin(yaw - turret.rotation.y), Math.cos(yaw - turret.rotation.y))) < 0.12 : true;
    if (u.sees && dist > 25 && dist < 230 && u.reload <= 0 && aimed) {
      u.lock += dt;
      this.locked = 'rocket';
      const m = this.muzzleOf(u);
      this.effects?.laser(m.x, m.y, m.z, player.x, player.y + 0.8, player.z, 0.6 + 0.4 * Math.min(1, u.lock / ROCKET.lockTime));
      if (u.lock >= ROCKET.lockTime) {
        // Lead the target: aim where the car will be when the rocket arrives.
        const t = dist / ROCKET.speed;
        const tx = player.x + player.vx * t * 0.8, tz = player.z + player.vz * t * 0.8, ty = player.y + 0.6;
        const dx = tx - m.x, dy = ty - m.y, dz = tz - m.z, l = Math.hypot(dx, dy, dz) || 1;
        const mesh = new THREE.Mesh(ROCKET_GEO, ROCKET_MAT);
        mesh.position.copy(m);
        this.scene.add(mesh);
        this.rockets.push({ x: m.x, y: m.y, z: m.z, vx: (dx / l) * ROCKET.speed, vy: (dy / l) * ROCKET.speed, vz: (dz / l) * ROCKET.speed, life: ROCKET.life, mesh });
        this.effects?.muzzle(m.x, m.y, m.z);
        this.combat.push({ type: 'launch', x: m.x, z: m.z });
        u.lock = 0;
        u.reload = ROCKET.reload * this.rocketReload * this.rng.range(0.85, 1.15);
      }
    } else u.lock = Math.max(0, u.lock - dt * 2);
  }

  private muzzleOf(u: Unit) {
    const t = u.model.turret;
    if (!t) return new THREE.Vector3(u.v.x, u.v.y + 2.8, u.v.z);
    u.model.root.updateMatrixWorld(true);
    return t.localToWorld(u.model.muzzle.clone());
  }

  /** Blast: falloff damage, a launch away from the centre, maybe a tire. Knocks traffic too. */
  explode(x: number, y: number, z: number, player: Vehicle) {
    this.effects?.explosion(x, y, z, ROCKET.radius);
    const d = Math.hypot(player.x - x, player.y + 0.6 - y, player.z - z);
    let damage = 0;
    if (d < ROCKET.radius && !player.totaled && !player.absorb()) {
      const k = 1 - d / ROCKET.radius;
      damage = player.hurt(ROCKET.damage * k * k + 6);
      const hx = player.x - x, hz = player.z - z, hl = Math.hypot(hx, hz) || 1;
      player.vx += (hx / hl) * 9 * k;
      player.vz += (hz / hl) * 9 * k;
      player.vy = Math.max(player.vy, 3 + 6 * k);
      player.airborne = true;
      player.airTime = 0;
      player.w += (this.rand() - 0.5) * 3 * k;
      if (d < 4.5 && this.rand() < 0.6) player.popTire(undefined, this.rand);
    }
    for (const c of this.traffic.cars) if (Math.hypot(c.body.x - x, c.body.z - z) < ROCKET.radius) this.traffic.knock(c);
    this.combat.push({ type: 'explosion', x, z, dist: d, damage });
  }

  private addSpikes(g: PursuitGate) {
    const obj = new THREE.Group();
    const gy = this.ground(g.x, g.z, -1e9);
    obj.position.set(g.x, gy + 0.04, g.z);
    obj.rotation.y = g.h;
    const len = g.width - 1;
    const base = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, 0.5), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 }));
    obj.add(base);
    const n = Math.floor(len / 0.35);
    const spikes = new THREE.InstancedMesh(SPIKE_GEO, SPIKE_MAT, n * 2);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) for (const zz of [-0.12, 0.12]) {
      m.makeTranslation(-len / 2 + (i + 0.5) * (len / n), 0.1, zz);
      spikes.setMatrixAt(i * 2 + (zz > 0 ? 1 : 0), m);
    }
    obj.add(spikes);
    // Orange marker cones at both ends so the strip reads from a distance.
    for (const s of [-1, 1]) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.7, 10), new THREE.MeshStandardMaterial({ color: 0xff6a10, emissive: 0xff4a00, emissiveIntensity: 0.6 }));
      cone.position.set((s * len) / 2, 0.35, 0);
      obj.add(cone);
    }
    this.scene.add(obj);
    this.spikes.push({ gate: g, obj, created: this.clock, hit: false });
    this.messages.push({ big: 'Spike strip ahead', small: `${g.street || 'Marked street'} · steer onto the shoulder or jump it` });
  }

  // ------------------------------------------------------------------ player abilities
  /** Every police unit and rival an ability can act on. */
  private knockables(): Knockable[] {
    return [...this.units.filter(engagedUnit), ...this.others];
  }

  /** Stop a car in its tracks for a while, spinning if asked. */
  stallCar(k: Knockable, seconds: number, spin = 0) {
    k.stall = Math.max(k.stall, seconds);
    k.spin = spin;
  }

  /** Shockwave: throw cars away from the player, stall police, swat rockets. */
  shockwave(player: Vehicle, radius: number) {
    let n = 0;
    for (const k of this.knockables()) {
      const dx = k.v.x - player.x, dz = k.v.z - player.z, d = Math.hypot(dx, dz);
      if (d > radius || d < 0.1) continue;
      const f = 1 - d / radius;
      k.v.vx += (dx / d) * (10 + 18 * f);
      k.v.vz += (dz / d) * (10 + 18 * f);
      k.v.vy = Math.max(k.v.vy, 3 + 5 * f);
      k.v.airborne = true;
      this.stallCar(k, 2.5, (Math.random() < 0.5 ? -1 : 1) * 5);
      n++;
    }
    for (const c of this.traffic.cars) if (Math.hypot(c.body.x - player.x, c.body.z - player.z) < radius) { this.traffic.knock(c); n++; }
    for (const r of [...this.rockets]) {
      if (Math.hypot(r.x - player.x, r.z - player.z) > radius * 1.5) continue;
      this.effects?.explosion(r.x, r.y, r.z, 4);
      this.scene.remove(r.mesh);
      this.rockets.splice(this.rockets.indexOf(r), 1);
    }
    return n;
  }

  /** EMP: stall units in range and jam police kit for a while. */
  emp(player: Vehicle, radius: number, seconds: number) {
    let n = 0;
    for (const u of this.units) {
      if (!engagedUnit(u) || Math.hypot(u.v.x - player.x, u.v.z - player.z) > radius) continue;
      this.stallCar(u, seconds * 0.5);
      u.lock = 0;
      this.effects?.sparks(u.v.x, u.v.y + 1.2, u.v.z, 14);
      n++;
    }
    this.jam = Math.max(this.jam, seconds);
    this.locked = null;
    return n;
  }

  /** Drop an oil slick or caltrops a few metres behind the car. */
  dropHazard(kind: 'oil' | 'caltrops', player: Vehicle) {
    const fx = Math.sin(player.h), fz = Math.cos(player.h);
    const x = player.x - fx * (player.halfLength + 2.5), z = player.z - fz * (player.halfLength + 2.5);
    const y = this.ground(x, z, player.y);
    const obj = new THREE.Group();
    obj.position.set(x, y + 0.03, z);
    const r = kind === 'oil' ? 4.2 : 3.6;
    if (kind === 'oil') {
      const m = new THREE.Mesh(OIL_GEO, OIL_MAT);
      m.scale.set(r, 1, r * 0.8);
      m.rotation.y = player.h;
      obj.add(m);
    } else {
      const n = 60;
      const spikes = new THREE.InstancedMesh(SPIKE_GEO, SPIKE_MAT, n);
      const mtx = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * r;
        mtx.makeTranslation(Math.cos(a) * rr, 0.08, Math.sin(a) * rr);
        spikes.setMatrixAt(i, mtx);
      }
      obj.add(spikes);
    }
    this.scene.add(obj);
    this.hazards.push({ kind, x, z, r, life: 25, obj, hit: new Set() });
  }

  /** Smoke Screen: a cloud behind the car that hides it from police behind. */
  addSmoke(player: Vehicle) {
    const fx = Math.sin(player.h), fz = Math.cos(player.h);
    this.smoke.push({ x: player.x - fx * 4, z: player.z - fz * 4, r: 7, life: 6 });
    if (this.smoke.length > 60) this.smoke.shift();
  }

  /** Does any smoke cloud sit on the line between two points? */
  private smokeBetween(ax: number, az: number, bx: number, bz: number) {
    if (!this.smoke.length) return false;
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    for (const c of this.smoke) {
      const t = Math.max(0, Math.min(1, ((c.x - ax) * dx + (c.z - az) * dz) / L2));
      if (Math.hypot(ax + dx * t - c.x, az + dz * t - c.z) < c.r) return true;
    }
    return false;
  }

  /** Homing missile at the nearest police unit or rival in front; false if none. */
  fireMissile(player: Vehicle) {
    const fx = Math.sin(player.h), fz = Math.cos(player.h);
    let best: Knockable | null = null, bestScore = Infinity;
    for (const k of this.knockables()) {
      const dx = k.v.x - player.x, dz = k.v.z - player.z, d = Math.hypot(dx, dz);
      if (d < 4 || d > 170) continue;
      const ahead = (dx * fx + dz * fz) / d;
      if (ahead < 0.35) continue;
      const score = d * (1.6 - ahead);
      if (score < bestScore) { bestScore = score; best = k; }
    }
    if (!best) return false;
    const mesh = new THREE.Mesh(ROCKET_GEO, MISSILE_MAT);
    const y = player.y + 1.4;
    mesh.position.set(player.x, y, player.z);
    this.scene.add(mesh);
    const sp = Math.max(60, player.speed + 40);
    this.missiles.push({ x: player.x + fx * 2, y, z: player.z + fz * 2, vx: fx * sp, vy: 2, vz: fz * sp, target: best, life: 4, mesh });
    return true;
  }

  /** Hazards, missiles and smoke run every frame (on the warped clock). */
  private updateAbilityFx(dt: number, player: Vehicle) {
    for (const k of this.knockables()) k.stall = Math.max(0, k.stall - dt);
    for (const c of [...this.smoke]) {
      c.life -= dt;
      if (c.life <= 0) this.smoke.splice(this.smoke.indexOf(c), 1);
    }
    for (const hz of [...this.hazards]) {
      hz.life -= dt;
      for (const k of this.knockables()) {
        if (hz.hit.has(k.v) || k.v.airborne || Math.hypot(k.v.x - hz.x, k.v.z - hz.z) > hz.r) continue;
        hz.hit.add(k.v);
        if (hz.kind === 'oil') this.stallCar(k, 1.8, (Math.random() < 0.5 ? -1 : 1) * 7);
        else {
          k.v.popTire(0);
          k.v.popTire(1);
          this.stallCar(k, 2.2);
          this.effects?.sparks(k.v.x, k.v.y + 0.3, k.v.z, 16);
        }
      }
      if (hz.life <= 0 || Math.hypot(hz.x - player.x, hz.z - player.z) > 900) {
        this.scene.remove(hz.obj);
        this.hazards.splice(this.hazards.indexOf(hz), 1);
      }
    }
    for (const m of [...this.missiles]) {
      const t = m.target.v;
      const dx = t.x - m.x, dy = t.y + 0.8 - m.y, dz = t.z - m.z, d = Math.hypot(dx, dy, dz) || 1;
      const sp = Math.max(70, Math.hypot(m.vx, m.vz) + 30 * dt);
      const k = Math.min(1, 6 * dt);
      m.vx += ((dx / d) * sp - m.vx) * k;
      m.vy += ((dy / d) * sp - m.vy) * k;
      m.vz += ((dz / d) * sp - m.vz) * k;
      m.x += m.vx * dt; m.y += m.vy * dt; m.z += m.vz * dt;
      m.life -= dt;
      m.mesh.position.set(m.x, m.y, m.z);
      m.mesh.lookAt(m.x + m.vx, m.y + m.vy, m.z + m.vz);
      this.effects?.trail(m.x - m.vx * 0.02, m.y - m.vy * 0.02, m.z - m.vz * 0.02);
      if (d < 2.6 || m.life <= 0) {
        this.effects?.explosion(m.x, m.y, m.z, 6);
        if (d < 2.6) {
          t.vy = Math.max(t.vy, 7);
          t.airborne = true;
          t.vx *= 0.3;
          t.vz *= 0.3;
          this.stallCar(m.target, 5, (Math.random() < 0.5 ? -1 : 1) * 6);
          this.combat.push({ type: 'explosion', x: m.x, z: m.z, dist: Math.hypot(m.x - player.x, m.z - player.z), damage: 0 });
          const unit = this.units.find((u) => u === m.target);
          if (unit) this.messages.push({ big: 'Direct hit', small: unit.type === 'tank' ? 'Armored unit stalled' : 'Unit knocked out' });
        }
        this.scene.remove(m.mesh);
        this.missiles.splice(this.missiles.indexOf(m), 1);
      }
    }
  }

  // ------------------------------------------------------------------ helicopter
  /** Flies the helicopter; returns true while it has eyes on the player. */
  private updateHeli(dt: number, player: Vehicle) {
    const lvl = HEAT_LEVELS[this.heat.stars];
    this.heliCooldown = Math.max(0, this.heliCooldown - dt);
    if (!this.heli && lvl.helicopter && this.heat.active && this.heliCooldown <= 0) {
      const a = this.rng.range(0, Math.PI * 2);
      const model = new HelicopterModel();
      this.scene.add(model.root, model.beamMesh);
      const gy = this.ground(player.x, player.z, player.y);
      this.heli = { x: player.x + Math.cos(a) * 380, y: gy + 70, z: player.z + Math.sin(a) * 380, vx: 0, vz: 0, h: a + Math.PI, bank: 0, sees: false, aim: 0, shotCd: 4, model, leaving: false, lostFor: 0, spot: 0, hp: HELI_HP };
      this.combat.push({ type: 'heli' });
      this.messages.push({ big: 'Helicopter', small: 'Lose it under trees or a bridge, or outrun it' });
    }
    const h = this.heli;
    if (!h) return false;
    if (!this.heat.active || !lvl.helicopter) h.leaving = true;
    const gy = this.ground(player.x, player.z, player.y);
    // Hold a position just behind and above the car, leading its motion. Once the crew
    // has lost the car (under a roof, a deck or trees), it circles where it last saw it.
    const fx = Math.sin(player.h), fz = Math.cos(player.h);
    let tx = player.x + player.vx * 1.2 - fx * 22, tz = player.z + player.vz * 1.2 - fz * 22, ty = gy + 38;
    if (h.lostFor > 1.5 && this.lastSeen) {
      const a = this.clock * 0.35;
      tx = this.lastSeen.x + Math.cos(a) * 70;
      tz = this.lastSeen.z + Math.sin(a) * 70;
    }
    if (h.leaving) { tx = h.x + (h.x - player.x) * 2; tz = h.z + (h.z - player.z) * 2; ty = h.y + 20; }
    const max = 75 * this.copPace;
    let dvx = (tx - h.x) * 1.1, dvz = (tz - h.z) * 1.1;
    const sp = Math.hypot(dvx, dvz);
    if (sp > max) { dvx *= max / sp; dvz *= max / sp; }
    const k = Math.min(1, 1.4 * dt);
    const ax = (dvx - h.vx) * k, az = (dvz - h.vz) * k;
    h.vx += ax; h.vz += az;
    h.x += h.vx * dt; h.z += h.vz * dt;
    h.y += (ty - h.y) * Math.min(1, 0.8 * dt);
    const speed = Math.hypot(h.vx, h.vz);
    if (speed > 3) h.h = Math.atan2(h.vx, h.vz);
    h.bank += ((-(ax * Math.cos(h.h) - az * Math.sin(h.h)) / Math.max(dt, 1e-3)) * 0.01 - h.bank) * Math.min(1, 3 * dt);
    const dist = Math.hypot(h.x - player.x, h.z - player.z);
    if (h.leaving && dist > 700) { this.removeHeli(); return false; }
    const visible = !h.leaving && !player.totaled && this.cloak <= 0 && this.jam <= 0 && dist < 320 && !this.coverAt(player.x, player.z, player.y);
    h.spot = visible ? h.spot + dt : 0;
    // Picking the car up again takes a moment of clear view (a skylight flash is not enough).
    h.sees = visible && (h.lostFor < 1.5 || h.spot >= 0.9);
    h.lostFor = h.sees ? 0 : h.lostFor + dt;
    // Marksman (5 stars): a laser on the car for a second, then a shot at a tire.
    if (h.sees && lvl.marksman && this.heat.phase === 'pursuit') {
      h.shotCd -= dt;
      if (h.shotCd <= 0) {
        h.aim += dt;
        this.locked = this.locked ?? 'marksman';
        this.effects?.laser(h.x, h.y - 1.4, h.z, player.x, player.y + 0.5, player.z, 0.5 + 0.5 * h.aim);
        if (h.aim >= 1.0) {
          h.aim = 0;
          h.shotCd = 5 / Math.max(0.3, this.copAccuracy);
          const hit = !player.airborne && this.rand() < 0.45 * this.copAccuracy;
          this.effects?.tracer(h.x, h.y - 1.4, h.z, player.x, player.y + 0.3, player.z);
          if (hit) { player.popTire(undefined, this.rand); this.effects?.sparks(player.x, player.y + 0.3, player.z, 12); }
          this.combat.push({ type: 'shot', x: h.x, z: h.z, hit });
        }
      }
    } else h.aim = 0;
    return h.sees;
  }

  private removeHeli() {
    if (!this.heli) return;
    this.scene.remove(this.heli.model.root, this.heli.model.beamMesh);
    this.heli = null;
  }

  /** Pose the helicopter (called from render with the frame time). */
  renderHeli(t: number, player: Vehicle, night: number) {
    const h = this.heli;
    if (!h) return;
    const pitch = Math.min(0.25, Math.hypot(h.vx, h.vz) / 200);
    h.model.update(t, h.x, h.y, h.z, h.h, h.bank, pitch, new THREE.Vector3(player.x, player.y, player.z), night, h.sees);
  }

  // ------------------------------------------------------------------ the player's weapons
  /** A weapon hit on a unit. Explosives shove it; at zero it is wrecked. */
  damageUnit(u: Unit, damage: number, explosive: boolean, fromX: number, fromZ: number) {
    if (u.state === 'wrecked') return;
    const armor = u.type === 'tank' ? (explosive ? 0.6 : 0.25) : 1;
    u.hp -= damage * armor;
    if (explosive) {
      const dx = u.v.x - fromX, dz = u.v.z - fromZ, d = Math.hypot(dx, dz) || 1;
      const k = u.type === 'tank' ? 0.3 : 1;
      u.v.vx += (dx / d) * 8 * k;
      u.v.vz += (dz / d) * 8 * k;
      u.v.vy = Math.max(u.v.vy, 3 * k);
      u.v.airborne = u.v.airborne || k > 0.5;
    }
    if (u.hp <= 0) this.wreck(u);
  }

  private wreck(u: Unit) {
    u.state = 'wrecked';
    u.wreckedFor = 0;
    u.sees = false;
    u.ai.hold = false;
    u.stall = 1e9;
    u.spin = (this.rng.next() < 0.5 ? -1 : 1) * 2.5;
    this.takedowns++;
    this.effects?.explosion(u.v.x, u.v.y + 0.8, u.v.z, 6);
    this.combat.push({ type: 'explosion', x: u.v.x, z: u.v.z, dist: 99, damage: 0 });
    const stars = Math.max(1, this.heat.stars);
    this.bonusCredits += 120 * stars;
    this.heat.award(HEAT_AWARDS.copDown, `Wrecked a ${u.type === 'tank' ? 'armored unit' : u.type === 'warden' ? 'Warden' : 'police car'}`, this.clock, u.id + 700000);
    this.messages.push({ big: u.type === 'tank' ? 'Armor down' : 'Unit down', small: `+${(120 * stars).toLocaleString()} cr when you get away` });
  }

  /** A weapon hit on the helicopter. */
  damageHeli(damage: number) {
    const h = this.heli;
    if (!h || h.leaving) return;
    h.hp -= damage;
    this.effects?.sparks(h.x, h.y, h.z, 8);
    if (h.hp > 0) return;
    this.effects?.explosion(h.x, h.y, h.z, 10);
    this.combat.push({ type: 'explosion', x: h.x, z: h.z, dist: 99, damage: 0 });
    this.removeHeli();
    this.heliCooldown = 45;
    this.takedowns++;
    const stars = Math.max(1, this.heat.stars);
    this.bonusCredits += 300 * stars;
    this.heat.award(HEAT_AWARDS.copDown, 'Shot down the helicopter', this.clock, 799999);
    this.messages.push({ big: 'Helicopter down', small: 'No eyes in the sky for 45 seconds' });
  }

  /**
   * Shots fired: with no heat yet, any officer who can see it starts a chase.
   * Debounced so a burst counts once.
   */
  shotsFired(player: Vehicle) {
    if (this.heat.stars > 0) return;
    const w = this.witness(player.x, player.z, player.y);
    const posted = this.posted.some((p) => p.away <= 0 && Math.hypot(p.x - player.x, p.z - player.z) < 140 && Math.abs(p.y - player.y) < 6 && this.los(p.x, p.z, player.x, player.z, p.y + 1, player.y));
    if (!w && !posted) return;
    if (!this.heat.award(HEAT_AWARDS.shotsFired, 'Shots fired', this.clock, 777777)) return;
    if (w?.patrol) this.promote(w.patrol);
    else if (w?.unit) w.unit.state = 'chase';
    this.lastSeen = { x: player.x, z: player.z, y: player.y };
  }

  render(alpha: number, t: number) {
    for (const u of this.units) {
      const v = u.v;
      const x = v.px + (v.x - v.px) * alpha, z = v.pz + (v.z - v.pz) * alpha;
      const h = v.ph + (v.h - v.ph) * alpha;
      u.model.pose(x, v.y, z, h, v.pitch, v.roll, v.steerAngle, v.wheelRot, v.bump);
      u.model.setLights(v.braking, v.reversing);
      u.model.setSiren(engagedUnit(u), t + u.id * 0.37, this.reducedFlashing);
    }
  }
}
