// Arcade car: grippy carving, kart-style hop-drift with mini-turbo tiers,
// terrain following with real airtime off crests, nitro, and simple slopes.
import { clamp, damp, lerp, wrapAngle } from '../core/math';
import type { CarSpec } from './cars';
import type { PhysBody } from './Physics';

export interface DriveInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (hold at rest to reverse)
  steer: number; // -1..1, positive = right
  drift: boolean; // hold to drift
  nitro: boolean;
}

export const NO_INPUT: DriveInput = { throttle: 0, brake: 0, steer: 0, drift: false, nitro: false };

export interface Modifiers {
  frontGrip: number; // turn and grip multiplier (Apex Grip)
  rearGrip: number;
  extraForce: number; // N along heading (abilities)
  topSpeedMul?: number;
  /** Superstar: no damage, no flats, no arrest. */
  invincible?: boolean;
  /** Phantom: passes through other cars. */
  phase?: boolean;
  /** Glider: gravity scale and air steering while airborne. */
  gravityMul?: number;
  airSteer?: number;
  /** Grapple: rope to an anchor point; length shrinks as it reels in. */
  tether?: { x: number; z: number; len: number; pull: number } | null;
}

export const defaultMods = (): Modifiers => ({ frontGrip: 1, rearGrip: 1, extraForce: 0 });

/** Ground height under (x,z); `yHint` lets bridge decks win only when the car is on them. */
export type GroundFn = (x: number, z: number, yHint: number) => number;

export const GRAVITY = 12; // a little heavier than real for snappy jumps
/** Downward vertical acceleration (m/s^2) the road must demand before a crest pops the car into the air. */
export const CREST_DROP = 3.5;
export const DRIFT_TIERS = [0.8, 1.7, 2.7];
const BOOST = [0, 0.7, 1.1, 1.6]; // seconds per tier

export class Vehicle implements PhysBody {
  id = 0;
  solid = true;
  // world state
  x = 0;
  z = 0;
  h = 0; // heading: forward = (sin h, cos h)
  vx = 0;
  vz = 0;
  w = 0;
  y = 0;
  vy = 0;
  airborne = false;
  airTime = 0;
  /** Seconds of the last completed jump (set on landing). */
  landedAir = 0;
  /** Visual-only drift hop height (m); physics never sees it. */
  hopY = 0;
  /** Held angle between nose and travel direction while drifting (rad). */
  driftAngle = 0;
  private hopT = 1;
  px = 0;
  pz = 0;
  ph = 0;
  py = 0;
  // controls and telemetry
  steerAngle = 0; // visual wheel angle (rad)
  private steerAmt = 0;
  throttle = 0;
  brake = 0;
  reversing = false;
  private reverseHold = 0;
  gear = 1;
  rpm = 800;
  vLong = 0;
  vLat = 0;
  speed = 0;
  slipAngle = 0;
  latAccel = 0;
  longAccel = 0;
  braking = false;
  nitroActive = false;
  wheelspin = 0;
  tireSqueal = 0;
  wheelRot = 0;
  pitch = 0;
  roll = 0;
  bump = 0;
  private bumpVel = 0;
  // drift and boost
  drifting = false;
  driftDir = 0;
  driftTime = 0;
  driftTier = 0;
  boostTime = 0;
  boostPower = 0;
  /** The running boost came from a drift release (not a pad or a landing). */
  miniTurbo = false;
  /** Cues for sound/HUD: drift, tier1..3, boost, jump, land, cancel. */
  cues: string[] = [];
  // surface
  surfaceGrip = 1;
  onRoad = true;
  mods: Modifiers = defaultMods();
  /** Bubble Shield hits left; a hit protects for a moment so one blast costs one hit. */
  shield = 0;
  private shieldGrace = 0;
  // ---- condition: health and tires (front-left, front-right, rear-left, rear-right)
  readonly maxHealth: number;
  health: number;
  readonly flats = [false, false, false, false];
  totaled = false;
  /** Debug/playtest only: ignore damage (the autopilot can't use roadblock gaps). */
  invulnerable = false;
  ground: GroundFn = () => 0;
  /** Lowest deck surface above a height (a roof), or Infinity. Set on maps with stacked roads. */
  ceiling: ((x: number, z: number, y: number) => number) | null = null;
  groundY = 0;
  readonly mass: number;
  readonly inertia: number;
  readonly halfLength: number;
  readonly halfWidth: number;

  constructor(readonly spec: CarSpec) {
    this.maxHealth = spec.durability ?? 100;
    this.health = this.maxHealth;
    this.mass = spec.mass;
    this.inertia = ((spec.mass * (spec.length ** 2 + spec.width ** 2)) / 12) * 1.3;
    this.halfLength = spec.length / 2;
    this.halfWidth = spec.width / 2;
    this.rpm = spec.idleRpm;
  }

  place(x: number, z: number, h: number, speed = 0) {
    this.x = this.px = x;
    this.z = this.pz = z;
    this.h = this.ph = h;
    this.y = this.py = this.groundY = this.ground(x, z, Infinity);
    this.vx = Math.sin(h) * speed;
    this.vz = Math.cos(h) * speed;
    this.w = 0;
    this.vy = 0;
    this.airborne = false;
    this.airTime = 0;
    this.steerAmt = 0;
    this.steerAngle = 0;
    this.reversing = false;
    this.drifting = false;
    this.driftTime = 0;
    this.driftTier = 0;
    this.boostTime = 0;
    this.gear = 1;
    this.mods.tether = null;
  }

  /** Re-seat on the ground (used after placement on a deck or teleport with a height). */
  placeAt(x: number, z: number, y: number, h: number) {
    this.place(x, z, h, 0);
    this.y = this.py = this.groundY = this.ground(x, z, y + 1);
  }

  savePrev() {
    this.px = this.x;
    this.pz = this.z;
    this.ph = this.h;
    this.py = this.y;
  }

  /** Top yaw rate (rad/s) at a speed: quick at town speeds, grip-limited when fast. */
  turnRateAt(speed: number) {
    const s = this.spec;
    const ramp = clamp(speed / 5, 0, 1) ** 0.7;
    const gripLimit = (s.aLat * this.surfaceGrip * this.mods.frontGrip) / Math.max(speed, 1);
    return Math.min(s.turn * this.mods.frontGrip * ramp, gripLimit) * (1 - 0.08 * this.flatCount);
  }

  /** Equivalent wheel angle at full lock (older callers). */
  maxSteerAt(speed: number) {
    return Math.atan((this.turnRateAt(speed) * this.spec.wheelbase) / Math.max(speed, 1));
  }

  topSpeed() {
    const s = this.spec;
    let top = s.topSpeed * (this.mods.topSpeedMul ?? 1);
    if (!this.onRoad) top *= lerp(0.7, 1, clamp((s.offroadGrip - 0.7) / 0.3, 0, 1));
    if (this.nitroActive) top *= 1.15;
    if (this.boostTime > 0) top *= 1.12;
    return top * this.damageEffects().top;
  }

  /** End a drift without paying out (a crash). */
  get flatCount() {
    return this.flats.reduce((n, f) => n + (f ? 1 : 0), 0);
  }

  /** Health as 0..1. */
  get condition() {
    return this.health / this.maxHealth;
  }

  /** Shielded or invincible right now: spend a shield hit if that is what saves it. */
  absorb() {
    if (this.mods.invincible || this.shieldGrace > 0) return true;
    if (this.shield > 0) {
      this.shield--;
      this.shieldGrace = 0.4;
      this.cues.push('shield-hit');
      return true;
    }
    return false;
  }

  /** Take damage; returns what was applied. Totals the car at zero. */
  hurt(amount: number) {
    if (this.totaled || amount <= 0 || this.invulnerable) return 0;
    if (this.absorb()) return 0;
    const applied = Math.min(this.health, amount);
    this.health -= applied;
    this.cues.push('hurt');
    if (this.health <= 0) {
      this.health = 0;
      this.totaled = true;
      this.cancelDrift();
      this.boostTime = 0;
      this.cues.push('totaled');
    }
    return applied;
  }

  /** Blow out a tire (a given one, or a random intact one, rears first). Returns its index or -1. */
  popTire(which?: number, rand = Math.random) {
    let i = which ?? -1;
    if (i < 0) {
      const intact = [2, 3, 0, 1].filter((k) => !this.flats[k]);
      if (!intact.length) return -1;
      i = intact[rand() < 0.65 ? 0 : Math.floor(rand() * intact.length)];
    }
    if (this.flats[i]) return -1;
    if (this.absorb()) return -1;
    this.flats[i] = true;
    this.cues.push('tire');
    return i;
  }

  repair() {
    this.health = this.maxHealth;
    this.flats.fill(false);
    this.totaled = false;
  }

  /** Handling left after damage: [top speed, acceleration, grip/turn] multipliers and steering pull. */
  damageEffects() {
    const n = this.flatCount;
    const c = this.condition;
    const engine = c < 0.15 ? 0.8 : c < 0.35 ? 0.92 : 1;
    // A flat drags the car toward its side; fronts pull harder than rears.
    const pull = 0.16 * ((this.flats[1] ? 1 : 0) - (this.flats[0] ? 1 : 0)) + 0.08 * ((this.flats[3] ? 1 : 0) - (this.flats[2] ? 1 : 0));
    return { top: (1 - 0.13 * n) * engine, accel: (1 - 0.08 * n) * engine, grip: 1 - 0.12 * n, pull };
  }

  /** External boost: pads, clean landings. */
  addBoost(seconds: number, power: number) {
    this.boostPower = this.boostTime > 0 ? Math.max(this.boostPower, power) : power;
    this.boostTime = Math.max(this.boostTime, seconds);
    this.miniTurbo = false;
    this.cues.push('boost');
  }

  cancelDrift() {
    if (!this.drifting) return;
    this.drifting = false;
    this.driftTier = 0;
    this.driftTime = 0;
    this.cues.push('cancel');
  }

  step(dt: number, input: DriveInput, steerDt = dt) {
    const s = this.spec;
    const dmg = this.damageEffects();
    // A totaled car has no drive: it coasts to a stop with the brakes dragging.
    if (this.totaled) input = { throttle: 0, brake: 0.35, steer: 0, drift: false, nitro: false };
    else if (dmg.pull) input = { ...input, steer: Math.max(-1, Math.min(1, input.steer + dmg.pull)) };
    const fx = Math.sin(this.h), fz = Math.cos(this.h);
    const rx = -fz, rz = fx;
    let vl = this.vx * fx + this.vz * fz;
    let vt = this.vx * rx + this.vz * rz; // lateral, positive = right
    const speed = Math.hypot(vl, vt);

    // Steering ramps quickly; centring is quicker still.
    const target = clamp(input.steer, -1, 1);
    const centring = Math.abs(target) < Math.abs(this.steerAmt) || Math.sign(target) !== Math.sign(this.steerAmt);
    const rate = centring ? 9 : 5.5;
    this.steerAmt += clamp(target - this.steerAmt, -rate * steerDt, rate * steerDt);
    this.steerAngle = this.steerAmt * 0.5;

    // Reverse: hold brake at a standstill; throttle at rest goes forward again.
    const throttle = clamp(input.throttle, 0, 1);
    const brake = clamp(input.brake, 0, 1);
    if (this.totaled) {
      this.reversing = false;
      this.reverseHold = 0;
    } else if (!this.reversing) {
      if (brake > 0.3 && throttle < 0.1 && vl < 0.8) {
        this.reverseHold += dt;
        if (this.reverseHold > 0.15) this.reversing = true;
      } else this.reverseHold = 0;
    } else if (throttle > 0.1 && vl > -1) {
      this.reversing = false;
      this.reverseHold = 0;
    }
    this.throttle = this.reversing ? brake : throttle;
    this.brake = this.reversing ? throttle : brake;
    this.braking = !this.reversing && brake > 0.05;

    // Slope under the car (for gravity along the road and body lean).
    const gF = this.ground(this.x + fx * 1.6, this.z + fz * 1.6, this.y);
    const gB = this.ground(this.x - fx * 1.6, this.z - fz * 1.6, this.y);
    const gR = this.ground(this.x + rx * 0.9, this.z + rz * 0.9, this.y);
    const gL = this.ground(this.x - rx * 0.9, this.z - rz * 0.9, this.y);
    const slopeF = (gF - gB) / 3.2, slopeR = (gR - gL) / 1.8;

    this.nitroActive = input.nitro && !this.reversing && throttle > 0.1 && !this.airborne;
    const top = this.topSpeed();
    let along = 0;
    if (!this.airborne) {
      if (this.reversing) {
        if (brake > 0 && vl > -11) along -= 7 * brake;
        if (throttle > 0 && vl < 0) along += 14 * throttle;
      } else {
        if (throttle > 0 && vl < top) {
          const curve = 1 - clamp(vl / top, 0, 1) ** s.accelCurve;
          along += s.accel * Math.max(0.08, curve) * throttle * (this.onRoad ? 1 : 0.85) * dmg.accel;
        }
        if (vl > top) along -= (vl - top) * 1.2;
        if (brake > 0 && vl > 0.2) along -= s.brakeDecel * brake;
      }
      if (this.nitroActive) along += s.nitroForce / this.mass;
      if (this.boostTime > 0) along += this.boostPower;
      along += this.mods.extraForce / this.mass;
      if (throttle < 0.05 && !this.reversing) along -= Math.sign(vl) * Math.min(Math.abs(vl) * 4, 2.2);
      along -= vl * Math.abs(vl) * 0.0004 * (s.dragScale ?? 1) * (this.onRoad ? 1 : 3);
      along -= Math.sin(Math.atan(slopeF)) * 9.81 * 0.75;
      const before = vl;
      vl += along * dt;
      // Brakes stop the car; they never push it backwards.
      if (!this.reversing && brake > 0 && before > 0 && vl < 0) vl = 0;

      // Drift: hold drift while steering at speed; a small hop sells it.
      if (!this.drifting && input.drift && Math.abs(input.steer) > 0.3 && vl > 9) {
        this.drifting = true;
        this.driftDir = Math.sign(input.steer);
        this.driftTime = 0;
        this.driftTier = 0;
        this.driftAngle = 0;
        this.hopT = 0;
        this.cues.push('drift');
      }
      if (this.drifting && (!input.drift || speed < 6.5)) {
        if (this.driftTier > 0 && speed >= 6.5) {
          this.boostTime = BOOST[this.driftTier];
          this.boostPower = 4 + this.driftTier * 2;
          this.miniTurbo = true;
          this.cues.push('boost');
        }
        // Kart exit: the car snaps straight along its nose without losing speed.
        const sp = Math.hypot(vl, vt);
        vt *= 0.25;
        vl = Math.sqrt(Math.max(0, sp * sp - vt * vt));
        this.drifting = false;
        this.driftTime = 0;
        this.driftTier = 0;
        this.driftAngle = 0;
      }

      const dir = Math.sign(vl) || 1;
      if (this.drifting) {
        // Kart drift: the travel direction arcs at a rate set by steering (inside
        // tightens, outside widens, it never flips sides) while the nose holds a
        // fixed angle into the corner. Speed is kept; only a little scrubs off.
        const inside = clamp(input.steer * this.driftDir, -1, 1);
        const amount = 0.55 + 0.45 * inside;
        // Throttle still pulls, at half strength, and the drift scrubs toward ~85% of top speed.
        let sp = speed + (Math.hypot(vl, vt) - speed) * 0.5 - 0.5 * dt;
        if (sp > top * 0.85) sp -= (sp - top * 0.85) * 2 * dt;
        const turn = Math.min(s.turn * 0.95, (s.aLat * 1.35) / Math.max(sp, 1));
        const travel = Math.atan2(this.vx, this.vz) - this.driftDir * amount * turn * dt;
        this.driftAngle += (0.42 + 0.14 * Math.max(0, inside) - this.driftAngle) * damp(7, dt);
        const hNew = travel - this.driftDir * this.driftAngle;
        const tvx = Math.sin(travel) * sp, tvz = Math.cos(travel) * sp;
        // Express the new velocity in this step's (old) frame; heading moves via w.
        vl = tvx * fx + tvz * fz;
        vt = tvx * rx + tvz * rz;
        this.w = wrapAngle(hNew - this.h) / dt;
        const tierBefore = this.driftTier;
        this.driftTime += dt * s.driftCharge * (0.75 + 0.45 * Math.max(0, inside));
        this.driftTier = this.driftTime >= DRIFT_TIERS[2] ? 3 : this.driftTime >= DRIFT_TIERS[1] ? 2 : this.driftTime >= DRIFT_TIERS[0] ? 1 : 0;
        if (this.driftTier > tierBefore) this.cues.push(`tier${this.driftTier}`);
      } else {
        this.w = -this.steerAmt * this.turnRateAt(Math.abs(vl)) * dir;
        // Extra bite at town speeds keeps tight corners planted instead of skating.
        const lowSpeed = 1 + 1.5 * clamp(1 - speed / 15, 0, 1);
        const grip = s.grip * lowSpeed * this.mods.frontGrip * this.surfaceGrip * dmg.grip;
        // Kart carve: most of the sideways speed the tires scrub off is turned
        // back into forward speed, so a hard grip turn keeps its pace.
        const sp0 = Math.hypot(vl, vt);
        vt *= Math.exp(-grip * dt);
        if (vl > 3) vl += (sp0 - Math.hypot(vl, vt)) * 0.6;
      }
      if (speed < 0.6 && throttle < 0.05 && !this.reversing) {
        vl *= 1 - damp(8, dt);
        vt *= 1 - damp(8, dt);
      }
    } else {
      // Airborne: momentum carries, with a little air steering (a lot with wings).
      this.w = -this.steerAmt * (this.mods.airSteer ?? 0.7);
      vl -= vl * 0.02 * dt;
    }
    this.shieldGrace = Math.max(0, this.shieldGrace - dt);
    this.boostTime = Math.max(0, this.boostTime - dt);
    this.hopT = Math.min(1, this.hopT + dt / 0.24);
    this.hopY = this.hopT < 1 ? 0.3 * Math.sin(Math.PI * this.hopT) : 0;

    this.vx = fx * vl + rx * vt;
    this.vz = fz * vl + rz * vt;
    this.applyTether(dt);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.h += this.w * dt;

    // Vertical: follow the ground, launch over crests, land and report airtime.
    const gNew = this.ground(this.x, this.z, this.y);
    // Off the edge of a deck or a ledge: fall instead of snapping down.
    if (!this.airborne && gNew < this.y - 1.0) {
      this.airborne = true;
      this.airTime = 0;
      this.vy = Math.min(this.vy, 0);
    }
    if (!this.airborne) {
      const ballistic = this.y + this.vy * dt - 0.5 * GRAVITY * dt * dt;
      const follow = clamp((gNew - this.y) / dt, -30, Math.max(0, speed * 0.45));
      const followSmooth = lerp(this.vy, follow, 0.35);
      // Arcade crest pop: if the road falls away from under a rising car quickly
      // enough, leave the ground with a little extra lift.
      const vertAccel = (followSmooth - this.vy) / dt;
      const crest = this.vy > 0.9 && speed > 14 && vertAccel < -CREST_DROP;
      if ((this.vy > 0.5 && ballistic > gNew + 0.12) || crest) {
        this.airborne = true;
        this.airTime = 0;
        if (crest) this.vy = this.vy * 1.45 + 0.9;
        this.y = Math.max(ballistic, gNew + 0.02);
        this.vy -= GRAVITY * dt;
        if (this.vy > 2 && !this.drifting) this.cues.push('jump');
      } else {
        // Low-pass the following speed so terrain-grid seams do not twitch the car.
        this.vy = followSmooth;
        this.y = gNew;
      }
    } else {
      this.airTime += dt;
      const g = this.mods.gravityMul ?? 1;
      this.vy -= GRAVITY * g * dt;
      // Wings: a gentle sink rate instead of a fall.
      if (g < 1) this.vy = Math.max(this.vy, -2.2);
      const yPrev = this.y;
      this.y += this.vy * dt;
      // A deck or tunnel roof overhead: bump the underside instead of passing through.
      if (this.vy > 0 && this.ceiling) {
        const roof = this.ceiling(this.x, this.z, yPrev);
        if (this.y + 1.4 > roof) {
          this.y = Math.max(yPrev, roof - 1.4);
          this.vy = Math.min(0, -this.vy * 0.2);
        }
      }
      if (this.y <= gNew) {
        this.y = gNew;
        this.airborne = false;
        if (this.airTime > 0.35) {
          this.landedAir = this.airTime;
          this.cues.push('land');
          this.kick(-1.5 - this.airTime);
        }
        this.vy = 0;
        this.airTime = 0;
      }
    }
    this.groundY = gNew;

    // Telemetry.
    this.vLong = vl;
    this.vLat = vt;
    this.speed = Math.hypot(this.vx, this.vz);
    this.slipAngle = this.speed > 2 ? Math.atan2(vt, Math.abs(vl)) : 0;
    this.latAccel = lerp(this.latAccel, this.speed * -this.w, damp(10, dt));
    this.longAccel = lerp(this.longAccel, along, damp(10, dt));
    this.tireSqueal = this.drifting ? 0.45 + this.driftTier * 0.12 : clamp(Math.abs(this.slipAngle) * 4 - 0.3, 0, 0.5);
    this.wheelRot += (vl / s.wheelRadius) * dt;
    const wheelRpm = (Math.abs(vl) / (2 * Math.PI * s.wheelRadius)) * 60;
    if (s.gears.length > 1) {
      const rpm = wheelRpm * s.gears[this.gear - 1];
      if (rpm > s.redline * 0.92 && this.gear < s.gears.length) this.gear++;
      else if (this.gear > 1 && rpm < s.redline * 0.42) this.gear--;
    }
    const ratio = s.gears[Math.min(this.gear, s.gears.length) - 1];
    this.rpm = lerp(this.rpm, Math.max(s.idleRpm, wheelRpm * ratio, s.idleRpm + this.throttle * 2200 * (speed < 2 ? 1 : 0)), damp(14, dt));

    // Visual body: follow the slope, lean in corners, nose with accel, tilt in the air.
    const groundPitch = this.airborne ? clamp(this.vy * 0.03, -0.25, 0.25) : Math.atan(slopeF);
    const groundRoll = this.airborne ? 0 : Math.atan(slopeR);
    const pitchTarget = -groundPitch - clamp(along * 0.004 * s.suspension, -0.05, 0.05);
    const rollTarget = groundRoll + clamp(-this.w * this.speed * 0.0028 * s.suspension, -0.09, 0.09) + (this.drifting ? this.driftDir * 0.05 : 0);
    this.pitch = lerp(this.pitch, pitchTarget, damp(this.airborne ? 4 : 14, dt));
    this.roll = lerp(this.roll, rollTarget, damp(10, dt));
    this.bumpVel += (-this.bump * 260 - this.bumpVel * 18) * dt;
    this.bump += this.bumpVel * dt;
  }

  kick(amount: number) {
    this.bumpVel += amount;
  }

  /**
   * Grapple rope: pull toward the anchor, and never let the car get further
   * than the rope allows (the outward part of the velocity becomes swing).
   */
  private applyTether(dt: number) {
    const t = this.mods.tether;
    if (!t) return;
    const dx = t.x - this.x, dz = t.z - this.z;
    const d = Math.hypot(dx, dz) || 1;
    const nx = dx / d, nz = dz / d;
    this.vx += nx * t.pull * dt;
    this.vz += nz * t.pull * dt;
    const radial = this.vx * nx + this.vz * nz; // positive = toward the anchor
    if (d >= t.len && radial < 0) {
      // Rope taut: keep the speed, redirect it around the anchor.
      const sp = Math.hypot(this.vx, this.vz);
      this.vx -= radial * nx;
      this.vz -= radial * nz;
      const k = sp / (Math.hypot(this.vx, this.vz) || 1);
      this.vx *= Math.min(k, 1.15);
      this.vz *= Math.min(k, 1.15);
      // Point the nose along the swing.
      const hv = Math.atan2(this.vx, this.vz);
      this.w = wrapAngle(hv - this.h) * 8;
    }
    if (d > t.len + 0.5) {
      this.x += nx * (d - t.len) * Math.min(1, dt * 10);
      this.z += nz * (d - t.len) * Math.min(1, dt * 10);
    }
  }

  forward() {
    return { x: Math.sin(this.h), z: Math.cos(this.h) };
  }
}

/** Run the car's own simulation on flat ground to measure garage figures. */
export function measureCar(spec: CarSpec) {
  const dt = 1 / 120;
  const sixty = 26.8224;
  const v = new Vehicle(spec);
  v.place(0, 0, 0, 0);
  const go: DriveInput = { throttle: 1, brake: 0, steer: 0, drift: false, nitro: false };
  let t = 0, zeroTo60 = NaN;
  while (t < 30) { v.step(dt, go); t += dt; if (v.vLong >= sixty) { zeroTo60 = t; break; } }
  let top = v.vLong, windowStart = v.vLong;
  for (let i = 1; i <= 120 * 90; i++) {
    v.step(dt, go);
    top = Math.max(top, v.vLong);
    if (i % 240 === 0) { if (v.vLong - windowStart < 0.05) break; windowStart = v.vLong; }
  }
  const b = new Vehicle(spec);
  b.place(0, 0, 0, sixty);
  const stop: DriveInput = { throttle: 0, brake: 1, steer: 0, drift: false, nitro: false };
  let bt = 0;
  do { b.step(dt, stop); bt += dt; } while (b.vLong > 0.05 && bt < 20);
  const brakeDist = Math.abs(b.z);
  return {
    zeroTo60,
    topSpeedMph: top / 0.44704,
    brake60Ft: brakeDist * 3.28084,
    brake60M: brakeDist,
    gripG: spec.aLat / 9.81,
    powerToWeight: spec.power / spec.mass,
  };
}
