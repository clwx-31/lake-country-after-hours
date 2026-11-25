// Chase camera: looks ahead into turns, retracts near walls, settles after drifts.
import * as THREE from 'three';
import { clamp, damp, lerp, lerpAngle, wrapAngle } from '../core/math';
import type { StaticWorld, StaticTag } from '../sim/Physics';

export interface CamTarget {
  x: number;
  y: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  speed: number;
  yawRate: number;
  length: number;
  airborne?: boolean;
}

const WALLS = new Set<StaticTag>(['building', 'rail']);

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: 0 | 1 = 0;
  rear = false;
  reducedShake = false;
  private yaw = 0;
  private dist = 6;
  private trauma = 0;
  private t = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private fovKick = 0;
  private camY = 0;
  initialized = false;
  /** Terrain height, so the camera never sinks into a hill behind the car. */
  ground: ((x: number, z: number) => number) | null = null;
  /** Underside of the lowest roof above height y at (x, z) (bridge, viaduct, lid, cave, tube), or Infinity. */
  ceiling: ((x: number, z: number, y: number) => number) | null = null;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.3, 2600);
  }

  addTrauma(amount: number) {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  kickFov(amount: number) {
    this.fovKick = Math.max(this.fovKick, amount);
  }

  snap(t: CamTarget) {
    this.yaw = t.h;
    this.initialized = false;
    this.update(1, t, null);
  }

  update(dt: number, t: CamTarget, statics: StaticWorld | null) {
    this.t += dt;
    const close = this.mode === 0;
    const back = (close ? 5.6 : 8.6) + t.length * 0.25 + clamp(t.speed * 0.03, 0, 1.5);
    const up = close ? 1.75 : 3.0;
    // Heading target blends toward the travel direction during slides.
    let target = t.h;
    if (t.speed > 4) {
      const vel = Math.atan2(t.vx, t.vz);
      const slip = wrapAngle(vel - t.h);
      target = t.h + clamp(slip, -0.7, 0.7) * 0.55;
    }
    // Look into the turn.
    target -= clamp(t.yawRate * 0.12, -0.25, 0.25);
    const rate = this.initialized ? 4.2 : 1000;
    this.yaw = lerpAngle(this.yaw, target, damp(rate, dt));
    const rearMul = this.rear ? -1 : 1;
    const fx = Math.sin(this.yaw) * rearMul, fz = Math.cos(this.yaw) * rearMul;

    // Retract toward the car when a wall sits between car and camera.
    let want = back;
    if (statics && !this.rear) {
      const hit = statics.raycast(t.x, t.z, -fx, -fz, back + 0.8, WALLS, t.y + 1.2);
      if (hit < back + 0.6) want = Math.max(2.4, hit - 0.7);
    }
    this.dist = this.initialized ? lerp(this.dist, want, damp(want < this.dist ? 14 : 2.5, dt)) : want;
    const retract = 1 - this.dist / back;
    const desired = new THREE.Vector3(
      t.x - fx * (this.rear ? 1.0 : this.dist),
      t.y + up + retract * 1.2 + (this.rear ? -0.3 : 0),
      t.z - fz * (this.rear ? 1.0 : this.dist),
    );
    const ahead = clamp(t.speed * 0.45, 3, 18);
    const lookTarget = new THREE.Vector3(t.x + fx * ahead, t.y + 1.0, t.z + fz * ahead);
    if (this.ground) desired.y = Math.max(desired.y, this.ground(desired.x, desired.z) + 0.9);
    // Under a deck, tunnel lid, cave or tube roof, stay below its underside.
    const roof = this.ceiling ? Math.min(this.ceiling(desired.x, desired.z, t.y), this.ceiling(t.x, t.z, t.y)) - 0.5 : Infinity;
    if (desired.y > roof) desired.y = Math.max(t.y + 0.9, roof);
    if (!this.initialized) {
      this.pos.copy(desired);
      this.look.copy(lookTarget);
      this.camY = desired.y;
      this.initialized = true;
    } else {
      const k = damp(this.rear ? 30 : 12, dt);
      this.pos.x = lerp(this.pos.x, desired.x, k);
      this.pos.z = lerp(this.pos.z, desired.z, k);
      // Lag a little vertically in the air so jumps read as height.
      this.camY = lerp(this.camY, desired.y, damp(t.airborne ? 4 : 10, dt));
      if (this.ground) this.camY = Math.max(this.camY, this.ground(this.pos.x, this.pos.z) + 0.7);
      if (this.camY > roof) this.camY = Math.max(t.y + 0.9, roof);
      this.pos.y = this.camY;
      this.look.lerp(lookTarget, damp(14, dt));
    }
    this.camera.position.copy(this.pos);
    // Shake from impacts (scaled down in reduced mode).
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const s = this.trauma * this.trauma * (this.reducedShake ? 0.2 : 1);
    if (s > 0.001) {
      this.camera.position.x += Math.sin(this.t * 47) * 0.35 * s;
      this.camera.position.y += Math.sin(this.t * 61 + 1.3) * 0.25 * s;
      this.camera.position.z += Math.sin(this.t * 53 + 2.1) * 0.35 * s;
    }
    this.camera.lookAt(this.look);
    this.fovKick = Math.max(0, this.fovKick - dt * 8);
    const fov = 60 + clamp(t.speed * 0.22, 0, 12) + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = lerp(this.camera.fov, fov, damp(5, dt));
      this.camera.updateProjectionMatrix();
    }
  }
}
