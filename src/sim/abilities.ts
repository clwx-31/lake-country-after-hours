// Signature abilities. Timers run on real elapsed time (never the Focus-scaled
// simulation clock) so recharge is honest during slow motion.
import { clamp } from '../core/math';
import { ABILITIES, type AbilityId } from './abilityInfo';
import type { Vehicle } from './Vehicle';

/** What abilities can do to the world around the car (implemented by the game). */
export interface AbilityWorld {
  /** Throw cars within `radius` away; returns how many were hit. */
  shockwave(v: Vehicle, radius: number): number;
  /** Leave a hazard on the road behind the car. */
  dropHazard(kind: 'oil' | 'caltrops', v: Vehicle): void;
  /** Smoke out the back for this frame. */
  smoke(v: Vehicle, dt: number): void;
  /** Fire at the nearest police unit or rival ahead; false when nothing is in range. */
  missile(v: Vehicle): boolean;
  /** Stall police and jam their kit; returns how many units were in range. */
  emp(v: Vehicle, radius: number, seconds: number): number;
  /** Best grapple anchor ahead (a tree, pole or car). */
  grappleTarget(v: Vehicle): { x: number; z: number; label: string; follow: (() => { x: number; z: number }) | null } | null;
  /** Teleport forward; false when every landing spot is blocked. */
  blink(v: Vehicle, dist: number): boolean;
  /** Police lose sight of the player for this long. */
  cloak(seconds: number): void;
  /** Time scale for everything except the player (1 = normal). */
  setTimeWarp(scale: number): void;
}

export interface AbilityInput {
  steer: number;
  brake: number;
}

export type AbilityMode = 'ready' | 'active' | 'charging';

export interface AbilityStatus {
  name: string;
  mode: AbilityMode;
  fill: number;
  state: string;
  bank?: number;
}

export abstract class Ability {
  abstract readonly id: AbilityId;
  abstract readonly name: string;
  activations = 0;
  /** Seconds of real time until ready (0 = ready). */
  cooldown = 0;
  /** Seconds of real time the effect has left. */
  active = 0;
  lastCue = '';
  onCue: ((cue: string) => void) | null = null;
  /** The world the ability acts on (null in unit tests). */
  world: AbilityWorld | null = null;

  protected cue(c: string) {
    this.lastCue = c;
    this.onCue?.(c);
  }

  abstract canActivate(v: Vehicle): boolean;
  protected abstract start(v: Vehicle): void;
  abstract update(realDt: number, v: Vehicle, input: AbilityInput): void;
  abstract status(): AbilityStatus;

  trigger(v: Vehicle) {
    if (!this.canActivate(v)) return false;
    this.activations++;
    this.start(v);
    return true;
  }

  /** Simulation time scale requested by the ability (Focus only). */
  timeScale() {
    return 1;
  }

  reset() {
    this.cooldown = 0;
    this.active = 0;
  }
}

/** Finch RS: extra front bite for 2 s, recharges in 9 s. */
export class ApexGrip extends Ability {
  readonly id = 'apexGrip' as const;
  readonly name = 'Apex Grip';
  readonly duration = 2;
  readonly recharge = 9;
  canActivate() { return this.cooldown <= 0 && this.active <= 0; }
  protected start() {
    this.active = this.duration;
    this.cue('apex');
  }
  update(dt: number, v: Vehicle) {
    if (this.active > 0) {
      this.active = Math.max(0, this.active - dt);
      if (this.active === 0) this.cooldown = this.recharge;
    } else this.cooldown = Math.max(0, this.cooldown - dt);
    v.mods.frontGrip = this.active > 0 ? 1.45 : 1;
  }
  status(): AbilityStatus {
    if (this.active > 0) return { name: this.name, mode: 'active', fill: this.active / this.duration, state: `GRIP ${this.active.toFixed(1)}s` };
    if (this.cooldown > 0) return { name: this.name, mode: 'charging', fill: 1 - this.cooldown / this.recharge, state: `Recharging ${Math.ceil(this.cooldown)}s` };
    return { name: this.name, mode: 'ready', fill: 1, state: 'READY · tap at turn-in' };
  }
}

/** Vesper GT: opens the engine up for 3 s (more pull, higher top speed); 12 s recharge. */
export class Overdrive extends Ability {
  readonly id = 'overdrive' as const;
  readonly name = 'Overdrive';
  readonly duration = 3;
  readonly recharge = 12;
  canActivate() { return this.cooldown <= 0 && this.active <= 0; }
  protected start() {
    this.active = this.duration;
    this.cue('surge');
  }
  update(dt: number, v: Vehicle) {
    if (this.active > 0) {
      this.active = Math.max(0, this.active - dt);
      v.mods.extraForce = 5200;
      v.mods.topSpeedMul = 1.18;
      if (this.active === 0) this.cooldown = this.recharge;
    } else {
      v.mods.extraForce = 0;
      v.mods.topSpeedMul = 1;
      this.cooldown = Math.max(0, this.cooldown - dt);
    }
  }
  status(): AbilityStatus {
    if (this.active > 0) return { name: this.name, mode: 'active', fill: this.active / this.duration, state: `OVERDRIVE ${this.active.toFixed(1)}s` };
    if (this.cooldown > 0) return { name: this.name, mode: 'charging', fill: 1 - this.cooldown / this.recharge, state: `Recharging ${Math.ceil(this.cooldown)}s` };
    return { name: this.name, mode: 'ready', fill: 1, state: 'READY' };
  }
}

/** Foundry V8: 3 s surge that grows in a straight line and bleeds in hard turns. */
export class SecondWind extends Ability {
  readonly id = 'secondWind' as const;
  readonly name = 'Second Wind';
  readonly duration = 3;
  readonly recharge = 15;
  bonus = 0;
  canActivate() { return this.cooldown <= 0 && this.active <= 0; }
  protected start() {
    this.active = this.duration;
    this.bonus = 0.25;
    this.cue('surge');
  }
  update(dt: number, v: Vehicle, input: AbilityInput) {
    if (this.active > 0) {
      this.active = Math.max(0, this.active - dt);
      const yaw = Math.abs(v.w);
      if (yaw < 0.22 && Math.abs(input.steer) < 0.35) this.bonus = clamp(this.bonus + dt * 0.55, 0, 1);
      else if (yaw > 0.4) this.bonus = clamp(this.bonus - dt * 1.6, 0, 1);
      v.mods.extraForce = 3200 + 7400 * this.bonus;
      if (this.active === 0) { this.cooldown = this.recharge; v.mods.extraForce = 0; }
    } else {
      v.mods.extraForce = 0;
      this.cooldown = Math.max(0, this.cooldown - dt);
    }
  }
  status(): AbilityStatus {
    if (this.active > 0) return { name: this.name, mode: 'active', fill: this.active / this.duration, state: `SURGE ${Math.round(this.bonus * 100)}%`, bank: this.bonus };
    if (this.cooldown > 0) return { name: this.name, mode: 'charging', fill: 1 - this.cooldown / this.recharge, state: `Recharging ${Math.ceil(this.cooldown)}s` };
    return { name: this.name, mode: 'ready', fill: 1, state: 'READY · hold it straight' };
  }
}

/** Kestrel E: capacitor-fed thrust for up to 2 s; clean braking recharges it. */
export class Overclock extends Ability {
  readonly id = 'overclock' as const;
  readonly name = 'Overclock';
  capacitor = 1;
  regenTotal = 0;
  canActivate() { return this.active <= 0 && this.capacitor >= 0.12; }
  protected start() {
    this.active = Math.min(2, this.capacitor * 2);
    this.cue('overclock');
  }
  /** Pressing again ends the burst early and keeps the remaining charge. */
  trigger(v: Vehicle) {
    if (this.active > 0) {
      this.active = 0;
      v.mods.extraForce = 0;
      return true;
    }
    return super.trigger(v);
  }
  update(dt: number, v: Vehicle, input: AbilityInput) {
    if (this.active > 0) {
      const use = Math.min(this.active, dt);
      this.active -= use;
      this.capacitor = Math.max(0, this.capacitor - use * 0.5);
      if (this.capacitor <= 0) this.active = 0;
      v.mods.extraForce = 7600;
    } else {
      v.mods.extraForce = 0;
      // Regenerative braking only counts when the tires are not sliding.
      const clean = input.brake > 0.15 && v.speed > 4 && Math.abs(v.slipAngle) < 0.12 && !v.airborne && v.vLong > 0;
      if (clean) {
        const gain = dt * 0.24 * input.brake * clamp(v.speed / 15, 0.4, 1.3);
        this.capacitor = clamp(this.capacitor + gain, 0, 1);
        this.regenTotal += gain;
      }
    }
  }
  status(): AbilityStatus {
    if (this.active > 0) return { name: this.name, mode: 'active', fill: this.capacitor, state: `THRUST ${this.active.toFixed(1)}s`, bank: this.capacitor };
    if (this.capacitor >= 0.12) return { name: this.name, mode: 'ready', fill: this.capacitor, state: `Capacitor ${Math.round(this.capacitor * 100)}%`, bank: this.capacitor };
    return { name: this.name, mode: 'charging', fill: this.capacitor, state: 'Brake cleanly to charge', bank: this.capacitor };
  }
  reset() {
    super.reset();
    this.capacitor = 1;
  }
}

/** Northline RX: a small controlled jump; landing square keeps speed. */
export class RallyHop extends Ability {
  readonly id = 'rallyHop' as const;
  readonly name = 'Rally Hop';
  readonly recharge = 12;
  private wasAir = false;
  lastLanding: 'clean' | 'rough' | '' = '';
  canActivate(v: Vehicle) { return this.cooldown <= 0 && !v.airborne; }
  protected start(v: Vehicle) {
    v.vy = 5.2;
    v.y += 0.05;
    v.airborne = true;
    v.airTime = 0;
    this.active = 0.8;
    this.cooldown = this.recharge;
    this.cue('hop');
  }
  update(dt: number, v: Vehicle) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.active = Math.max(0, this.active - dt);
    if (this.wasAir && !v.airborne) {
      const square = Math.abs(v.slipAngle) < 0.15 && Math.abs(v.w) < 0.7;
      this.lastLanding = square ? 'clean' : 'rough';
      if (!square) {
        v.vx *= 0.72;
        v.vz *= 0.72;
        v.w *= 0.5;
      }
      v.kick(square ? -1.2 : -2.6);
      this.cue(square ? 'land-clean' : 'land-rough');
    }
    this.wasAir = v.airborne;
  }
  status(): AbilityStatus {
    if (this.active > 0) return { name: this.name, mode: 'active', fill: 1, state: 'AIRBORNE' };
    if (this.cooldown > 0) return { name: this.name, mode: 'charging', fill: 1 - this.cooldown / this.recharge, state: `Recharging ${Math.ceil(this.cooldown)}s` };
    return { name: this.name, mode: 'ready', fill: 1, state: this.lastLanding === 'rough' ? 'READY · land square!' : 'READY · hop for air' };
  }
}

/** Meridian S: slows the driving simulation while steering stays real-time. */
export class Focus extends Ability {
  readonly id = 'focus' as const;
  readonly name = 'Focus';
  readonly duration = 2.5;
  readonly recharge = 18;
  readonly scale = 0.35;
  canActivate() { return this.cooldown <= 0 && this.active <= 0; }
  protected start() {
    this.active = this.duration;
    this.cue('focus');
  }
  update(dt: number) {
    if (this.active > 0) {
      this.active = Math.max(0, this.active - dt);
      if (this.active === 0) { this.cooldown = this.recharge; this.cue('focus-end'); }
    } else this.cooldown = Math.max(0, this.cooldown - dt);
  }
  timeScale() {
    return this.active > 0 ? this.scale : 1;
  }
  status(): AbilityStatus {
    if (this.active > 0) return { name: this.name, mode: 'active', fill: this.active / this.duration, state: `FOCUS ${this.active.toFixed(1)}s` };
    if (this.cooldown > 0) return { name: this.name, mode: 'charging', fill: 1 - this.cooldown / this.recharge, state: `Recharging ${Math.ceil(this.cooldown)}s` };
    return { name: this.name, mode: 'ready', fill: 1, state: 'READY' };
  }
}

// ------------------------------------------------------------------ kart-style powers

/** Shared shape: an effect that lasts `duration`, then recharges for `recharge`. */
abstract class Timed extends Ability {
  abstract readonly duration: number;
  abstract readonly recharge: number;
  protected abstract readonly activeLabel: string;
  get name() { return ABILITIES[this.id as Exclude<AbilityId, 'none'>]?.name ?? this.id; }
  canActivate(v: Vehicle) { return this.cooldown <= 0 && this.active <= 0 && !v.totaled; }
  protected start(v: Vehicle) {
    this.active = this.duration;
    this.cue(this.id);
    this.onStart(v);
  }
  protected onStart(_v: Vehicle) {}
  protected during(_dt: number, _v: Vehicle, _input: AbilityInput) {}
  protected onEnd(_v: Vehicle) {}
  protected idle(_dt: number, _v: Vehicle) {}
  update(dt: number, v: Vehicle, input: AbilityInput) {
    if (this.active > 0) {
      this.active = Math.max(0, this.active - dt);
      this.during(dt, v, input);
      if (this.active === 0) {
        this.cooldown = this.recharge;
        this.onEnd(v);
      }
    } else {
      this.cooldown = Math.max(0, this.cooldown - dt);
      this.idle(dt, v);
    }
  }
  /** End early (car totaled, reset). */
  stop(v: Vehicle) {
    if (this.active <= 0) return;
    this.active = 0;
    this.cooldown = this.recharge;
    this.onEnd(v);
  }
  status(): AbilityStatus {
    if (this.active > 0) return { name: this.name, mode: 'active', fill: this.active / this.duration, state: `${this.activeLabel} ${this.active.toFixed(1)}s` };
    if (this.cooldown > 0) return { name: this.name, mode: 'charging', fill: 1 - this.cooldown / this.recharge, state: `Recharging ${Math.ceil(this.cooldown)}s` };
    return { name: this.name, mode: 'ready', fill: 1, state: 'READY' };
  }
}

/** One-shot effect: a short "fired" window for the HUD, then the recharge. */
abstract class Instant extends Timed {
  readonly duration = 0.6;
  protected activeLabel = 'FIRED';
  /** Do it; false = nothing to act on (a short retry delay instead of the full recharge). */
  protected abstract fire(v: Vehicle): boolean;
  protected start(v: Vehicle) {
    if (!this.fire(v)) {
      this.cooldown = 1;
      this.cue('ability-miss');
      return;
    }
    this.active = this.duration;
    this.cue(this.id);
  }
  status(): AbilityStatus {
    if (this.active > 0) return { name: this.name, mode: 'active', fill: 1, state: this.activeLabel };
    return super.status();
  }
}

export class Superstar extends Timed {
  readonly id = 'superstar' as const;
  readonly duration = 7;
  readonly recharge = 28;
  protected activeLabel = 'SUPERSTAR';
  protected onStart(v: Vehicle) { v.mods.invincible = true; }
  protected during(_dt: number, v: Vehicle) {
    v.mods.invincible = true;
    v.mods.topSpeedMul = 1.22;
    v.mods.extraForce = 5200 * (v.mass / 1400);
  }
  protected onEnd(v: Vehicle) {
    v.mods.invincible = false;
    v.mods.topSpeedMul = 1;
    v.mods.extraForce = 0;
  }
}

export class Grapple extends Ability {
  readonly id = 'grapple' as const;
  readonly name = 'Grapple Hook';
  readonly recharge = 4;
  readonly maxTime = 2.2;
  /** Where the hook is (for drawing the line) and what it caught. */
  anchor: { x: number; z: number; label: string; follow: (() => { x: number; z: number }) | null } | null = null;
  hooks = 0;
  canActivate(v: Vehicle) { return (this.cooldown <= 0 || this.active > 0) && !v.totaled; }
  trigger(v: Vehicle) {
    // Second press lets go early (the slingshot still fires).
    if (this.active > 0) { this.release(v); return true; }
    return super.trigger(v);
  }
  protected start(v: Vehicle) {
    const a = this.world?.grappleTarget(v) ?? null;
    if (!a) { this.cooldown = 0.8; this.cue('ability-miss'); return; }
    this.anchor = a;
    this.hooks++;
    const d = Math.hypot(a.x - v.x, a.z - v.z);
    v.mods.tether = { x: a.x, z: a.z, len: d, pull: 16 };
    this.active = this.maxTime;
    this.cue('grapple');
  }
  private release(v: Vehicle) {
    this.active = 0;
    this.anchor = null;
    v.mods.tether = null;
    this.cooldown = this.recharge;
    if (v.speed > 6) v.addBoost(0.7, 7);
    this.cue('grapple-release');
  }
  update(dt: number, v: Vehicle) {
    if (this.active > 0 && this.anchor && v.mods.tether) {
      this.active = Math.max(0, this.active - dt);
      const pos = this.anchor.follow?.();
      if (pos) { this.anchor.x = pos.x; this.anchor.z = pos.z; }
      const t = v.mods.tether;
      t.x = this.anchor.x;
      t.z = this.anchor.z;
      t.len = Math.max(5, t.len - 9 * dt);
      const d = Math.hypot(t.x - v.x, t.z - v.z);
      if (this.active === 0 || d < 6 || v.totaled) this.release(v);
    } else {
      if (this.active > 0) this.release(v);
      this.cooldown = Math.max(0, this.cooldown - dt);
    }
  }
  status(): AbilityStatus {
    if (this.active > 0) return { name: this.name, mode: 'active', fill: this.active / this.maxTime, state: `HOOKED · ${this.anchor?.label ?? ''} · E lets go` };
    if (this.cooldown > 0) return { name: this.name, mode: 'charging', fill: 1 - this.cooldown / this.recharge, state: `Reeling in ${Math.ceil(this.cooldown)}s` };
    return { name: this.name, mode: 'ready', fill: 1, state: 'READY · aim at a tree or car' };
  }
  reset() {
    super.reset();
    this.anchor = null;
  }
}

export class Phantom extends Timed {
  readonly id = 'phantom' as const;
  readonly duration = 5;
  readonly recharge = 22;
  protected activeLabel = 'PHANTOM';
  protected onStart(v: Vehicle) {
    v.mods.phase = true;
    this.world?.cloak(this.duration);
  }
  protected during(_dt: number, v: Vehicle) { v.mods.phase = true; }
  protected onEnd(v: Vehicle) { v.mods.phase = false; }
}

export class Shockwave extends Instant {
  readonly id = 'shockwave' as const;
  readonly recharge = 16;
  lastHits = 0;
  protected fire(v: Vehicle) {
    this.lastHits = this.world?.shockwave(v, 35) ?? 0;
    this.activeLabel = `BOOM · ${this.lastHits} hit`;
    return true;
  }
}

export class OilSlick extends Instant {
  readonly id = 'oilSlick' as const;
  readonly recharge = 9;
  protected activeLabel = 'SLICK DROPPED';
  protected fire(v: Vehicle) { this.world?.dropHazard('oil', v); return true; }
}

export class Caltrops extends Instant {
  readonly id = 'caltrops' as const;
  readonly recharge = 14;
  protected activeLabel = 'SPIKES DROPPED';
  protected fire(v: Vehicle) { this.world?.dropHazard('caltrops', v); return true; }
}

export class SmokeScreen extends Timed {
  readonly id = 'smokeScreen' as const;
  readonly duration = 4;
  readonly recharge = 18;
  protected activeLabel = 'SMOKE';
  protected during(dt: number, v: Vehicle) { this.world?.smoke(v, dt); }
}

export class PatchKit extends Instant {
  readonly id = 'patchKit' as const;
  readonly recharge = 30;
  protected activeLabel = 'PATCHED';
  canActivate(v: Vehicle) { return this.cooldown <= 0 && this.active <= 0 && !v.totaled; }
  protected fire(v: Vehicle) {
    if (v.health >= v.maxHealth && !v.flatCount) return false;
    v.health = Math.min(v.maxHealth, v.health + v.maxHealth * 0.35);
    const flat = [0, 1, 2, 3].find((i) => v.flats[i]);
    if (flat !== undefined) v.flats[flat] = false;
    v.cues.push('repaired');
    return true;
  }
}

export class BubbleShield extends Timed {
  readonly id = 'bubbleShield' as const;
  readonly duration = 10;
  readonly recharge = 24;
  protected activeLabel = 'SHIELD';
  protected onStart(v: Vehicle) { v.shield = 3; }
  protected during(_dt: number, v: Vehicle) {
    if (v.shield <= 0) this.active = Math.min(this.active, 0.001);
  }
  protected onEnd(v: Vehicle) { v.shield = 0; }
  status(): AbilityStatus {
    const st = super.status();
    return this.active > 0 ? { ...st, state: `SHIELD · ${this.hits} hit${this.hits === 1 ? '' : 's'} left` } : st;
  }
  hits = 3;
  update(dt: number, v: Vehicle, input: AbilityInput) {
    this.hits = v.shield;
    super.update(dt, v, input);
  }
}

export class Glider extends Timed {
  readonly id = 'glider' as const;
  readonly duration = 5;
  readonly recharge = 12;
  protected activeLabel = 'GLIDING';
  private flew = false;
  protected onStart(v: Vehicle) {
    // A hop off the ground, or a lift if a crest already threw the car up.
    v.vy = Math.max(v.vy, v.airborne ? 6 : 9);
    if (!v.airborne) {
      v.y += 0.05;
      v.airborne = true;
      v.airTime = 0;
    }
    this.flew = false;
  }
  protected during(_dt: number, v: Vehicle) {
    if (v.airborne) {
      this.flew = true;
      // Wings only help on the way down; the hop and crests still rise normally.
      v.mods.gravityMul = v.vy < 0 ? 0.18 : 0.6;
      v.mods.airSteer = 1.6;
    } else if (this.flew) this.active = Math.min(this.active, 0.001);
  }
  protected onEnd(v: Vehicle) {
    v.mods.gravityMul = 1;
    v.mods.airSteer = 0.7;
  }
}

export class Blink extends Instant {
  readonly id = 'blink' as const;
  readonly recharge = 9;
  protected activeLabel = 'BLINK';
  protected fire(v: Vehicle) { return this.world?.blink(v, 40) ?? false; }
}

export class TripleBoost extends Ability {
  readonly id = 'tripleBoost' as const;
  readonly name = 'Triple Boost';
  readonly recharge = 14;
  charges = 3;
  canActivate(v: Vehicle) { return this.charges > 0 && !v.totaled; }
  protected start(v: Vehicle) {
    this.charges--;
    v.addBoost(1.1, 10);
    this.active = 1.1;
    this.cue('tripleBoost');
    if (this.charges === 0) this.cooldown = this.recharge;
  }
  update(dt: number) {
    this.active = Math.max(0, this.active - dt);
    if (this.charges === 0) {
      this.cooldown = Math.max(0, this.cooldown - dt);
      if (this.cooldown === 0) this.charges = 3;
    }
  }
  status(): AbilityStatus {
    const pips = '●'.repeat(this.charges) + '○'.repeat(3 - this.charges);
    if (this.charges === 0) return { name: this.name, mode: 'charging', fill: 1 - this.cooldown / this.recharge, state: `${pips} refill ${Math.ceil(this.cooldown)}s`, bank: 0 };
    return { name: this.name, mode: this.active > 0 ? 'active' : 'ready', fill: this.charges / 3, state: `${pips} READY`, bank: this.charges / 3 };
  }
  reset() {
    super.reset();
    this.charges = 3;
  }
}

export class HomingMissile extends Instant {
  readonly id = 'homingMissile' as const;
  readonly recharge = 12;
  protected activeLabel = 'MISSILE AWAY';
  protected fire(v: Vehicle) { return this.world?.missile(v) ?? false; }
  status(): AbilityStatus {
    const st = super.status();
    return st.mode === 'ready' ? { ...st, state: 'READY · police or rival ahead' } : st;
  }
}

export class Emp extends Instant {
  readonly id = 'emp' as const;
  readonly recharge = 26;
  protected activeLabel = 'EMP';
  protected fire(v: Vehicle) {
    const n = this.world?.emp(v, 90, 6) ?? 0;
    this.activeLabel = n ? `EMP · ${n} stalled` : 'EMP';
    return true;
  }
}

export class MoonJump extends Instant {
  readonly id = 'moonJump' as const;
  readonly recharge = 10;
  protected activeLabel = 'LIFTOFF';
  canActivate(v: Vehicle) { return this.cooldown <= 0 && this.active <= 0 && !v.airborne && !v.totaled; }
  protected fire(v: Vehicle) {
    v.vy = 13.5;
    v.y += 0.05;
    v.airborne = true;
    v.airTime = 0;
    v.cancelDrift();
    return true;
  }
}

export class TimeWarp extends Timed {
  readonly id = 'timeWarp' as const;
  readonly duration = 4;
  readonly recharge = 22;
  readonly scale = 0.33;
  protected activeLabel = 'TIME WARP';
  protected onStart() { this.world?.setTimeWarp(this.scale); }
  protected during() { this.world?.setTimeWarp(this.scale); }
  protected onEnd() { this.world?.setTimeWarp(1); }
}

export function makeAbility(id: AbilityId): Ability {
  switch (id) {
    case 'apexGrip': return new ApexGrip();
    case 'overdrive': return new Overdrive();
    case 'secondWind': return new SecondWind();
    case 'overclock': return new Overclock();
    case 'rallyHop': return new RallyHop();
    case 'focus': return new Focus();
    case 'superstar': return new Superstar();
    case 'grapple': return new Grapple();
    case 'phantom': return new Phantom();
    case 'shockwave': return new Shockwave();
    case 'oilSlick': return new OilSlick();
    case 'caltrops': return new Caltrops();
    case 'smokeScreen': return new SmokeScreen();
    case 'patchKit': return new PatchKit();
    case 'bubbleShield': return new BubbleShield();
    case 'glider': return new Glider();
    case 'blink': return new Blink();
    case 'tripleBoost': return new TripleBoost();
    case 'homingMissile': return new HomingMissile();
    case 'emp': return new Emp();
    case 'moonJump': return new MoonJump();
    case 'timeWarp': return new TimeWarp();
    default: return new ApexGrip();
  }
}
