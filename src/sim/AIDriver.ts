// Path-following driver for the club rival and police. It steers with pure
// pursuit and plans speed from upcoming curvature, so it brakes for corners,
// can be overtaken, and (with optimistic braking) overshoots like a person.
import { Path, clamp, wrapAngle } from '../core/math';
import type { DriveInput } from './Vehicle';
import type { Vehicle } from './Vehicle';

export interface Skill {
  latBudget: number; // m/s^2 it is willing to corner at
  brakeDecel: number; // m/s^2 it plans with
  brakeOptimism: number; // >1 brakes too late
  maxSpeed: number;
  lookahead: number;
}

export class AIDriver {
  path: Path | null = null;
  s = 0;
  loop = false;
  private stuck = 0;
  private reverseTimer = 0;
  lateral = 0;
  /** Optional point to aim at directly (close-range police). */
  directTarget: { x: number; z: number } | null = null;
  speedCap = Infinity;
  /** Hold position with the brakes on (boxing in a stopped player). */
  hold = false;

  constructor(public skill: Skill) {}

  setPath(points: number[], keepProgress = false) {
    this.path = new Path(points);
    if (!keepProgress) this.s = 0;
  }

  drive(v: Vehicle, dt: number): DriveInput {
    const out: DriveInput = { throttle: 0, brake: 0, steer: 0, drift: false, nitro: false };
    if (this.hold) {
      out.brake = 1;
      this.reverseTimer = 0;
      return out;
    }
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      out.brake = 1;
      out.steer = this.lateral > 0 ? 1 : -1;
      return out;
    }
    const speed = v.speed;
    let tx: number, tz: number;
    let target = Math.min(this.skill.maxSpeed, this.speedCap);
    if (this.directTarget) {
      tx = this.directTarget.x;
      tz = this.directTarget.z;
    } else if (this.path && this.path.length > 1) {
      const pr = this.path.project(v.x, v.z, Math.max(0, this.s - 15), this.s + 60);
      this.s = Math.max(this.s, pr.s);
      this.lateral = pr.lateral;
      if (this.loop && this.s > this.path.length - 2) this.s -= this.path.length;
      const look = this.skill.lookahead + speed * 0.5;
      const p = this.path.pointAt(this.loop ? (this.s + look) % this.path.length : Math.min(this.path.length, this.s + look));
      tx = p.x;
      tz = p.z;
      // Speed planning over the braking horizon.
      const horizon = (speed * speed) / (2 * this.skill.brakeDecel) + 25;
      for (let d = 4; d < horizon; d += 4) {
        const sp = this.loop ? (this.s + d) % this.path.length : this.s + d;
        if (!this.loop && sp >= this.path.length) {
          target = Math.min(target, Math.sqrt(2 * this.skill.brakeDecel * Math.max(0, this.path.length - this.s - 3)));
          break;
        }
        const k = Math.abs(this.path.curvatureAt(sp, 5));
        if (k < 1e-4) continue;
        const vmax = Math.sqrt(this.skill.latBudget / k);
        const allowed = Math.sqrt(vmax * vmax + 2 * this.skill.brakeDecel * this.skill.brakeOptimism * Math.max(0, d - 3));
        target = Math.min(target, allowed);
      }
    } else {
      out.brake = 1;
      return out;
    }
    // Pure pursuit: curvature to the lookahead point, turned into a yaw-rate request.
    const dx = tx - v.x, dz = tz - v.z;
    const ld = Math.max(2, Math.hypot(dx, dz));
    const alpha = wrapAngle(Math.atan2(dx, dz) - v.h);
    const curvature = (2 * Math.sin(alpha)) / ld; // > 0 turns left
    const yaw = curvature * Math.max(speed, 3);
    out.steer = clamp(-yaw / Math.max(0.2, v.turnRateAt(Math.max(speed, 3))), -1, 1);
    const err = target - speed;
    if (err > 0) out.throttle = clamp(err * 0.6 + 0.35, 0, 1);
    else out.brake = clamp(-err * 0.3, 0, 1);
    if (Math.abs(out.steer) > 0.85 && speed > 14) out.throttle = Math.min(out.throttle, 0.6);
    if (Math.abs(alpha) > 1.9 && speed < 6) {
      // Target behind us: back up and swing around.
      this.reverseTimer = 1.0;
      this.lateral = alpha > 0 ? 1 : -1;
    }
    // Stuck against something: reverse briefly.
    if (out.throttle > 0.5 && speed < 0.8) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 1.4) {
      this.stuck = 0;
      this.reverseTimer = 1.1;
      this.lateral = alpha > 0 ? -1 : 1;
    }
    return out;
  }
}
