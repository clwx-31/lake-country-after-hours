// Car weapons: a second slot beside the ability, fired with F. Any car can mount
// any weapon. They hurt police units (which wreck), the helicopter and traffic;
// events that are races hold fire. Pure game logic plus a few meshes for rockets
// and mines; hits go through the WeaponWorld the game provides.
import * as THREE from 'three';
import type { Effects } from '../render/Effects';
import type { Vehicle } from './Vehicle';

export type WeaponId = 'machineGun' | 'rpg' | 'rearTurret' | 'scattergun' | 'mines' | 'railgun';

export interface WeaponInfo {
  id: WeaponId;
  name: string;
  color: string;
  /** Held (fires while F is down) or pressed (one shot per press). */
  hold: boolean;
  line: string;
}

export const WEAPONS: Record<WeaponId, WeaponInfo> = {
  machineGun: { id: 'machineGun', name: 'Machine Gun', color: '#ffd84a', hold: true, line: 'Hold F: twin guns in the grille, 12 rounds a second at whatever is ahead. Overheats after about four seconds.' },
  rpg: { id: 'rpg', name: 'RPG', color: '#ff6a3c', hold: false, line: 'Press F: a rocket that steers a little toward the nearest unit ahead. Wrecks a cruiser in one hit and can bring down the helicopter. 3 s reload.' },
  rearTurret: { id: 'rearTurret', name: 'Rear Turret', color: '#7ad7ff', hold: true, line: 'Hold F: a turret on the trunk that aims itself at whoever is chasing you. Overheats after about four seconds.' },
  scattergun: { id: 'scattergun', name: 'Scattergun', color: '#c9a36a', hold: false, line: 'Press F: a wide, short blast ahead that wrecks and shoves anything within 30 m. 1.2 s reload.' },
  mines: { id: 'mines', name: 'Mine Layer', color: '#ff4b4b', hold: false, line: 'Press F: drop a proximity mine behind you. Up to four armed at once; anything that drives over one goes up.' },
  railgun: { id: 'railgun', name: 'Rail Cannon', color: '#b48cff', hold: true, line: 'Hold F to charge, release to fire: a beam straight ahead that goes through every car in line. 5 s recharge.' },
};
export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

/** Each car's standard fit (any car can mount any weapon in the garage). */
export const DEFAULT_WEAPON: Record<string, WeaponId> = {
  finch: 'machineGun', vesper: 'machineGun', foundry: 'scattergun', kestrel: 'railgun', northline: 'rearTurret', meridian: 'railgun',
  sprite: 'mines', volt: 'railgun', swallow: 'machineGun', vandal: 'rearTurret', dune: 'scattergun', rattler: 'mines',
  bandit: 'scattergun', wraith: 'rearTurret', monarch: 'rpg', comet: 'railgun', lancer: 'rearTurret', ambler: 'mines',
  harbor: 'mines', hauler: 'scattergun', havoc: 'rpg', mammoth: 'rpg', zenith: 'rpg',
};

/** Something a weapon can hit. */
export interface WeaponTarget {
  x: number;
  y: number;
  z: number;
  /** Hit radius (m). */
  r: number;
  kind: 'unit' | 'heli' | 'traffic';
  /** Apply damage; `from` is where it came from (for knockback). */
  hit(damage: number, explosive: boolean, fromX: number, fromZ: number): void;
}

export interface WeaponWorld {
  targets(): WeaponTarget[];
  ground(x: number, z: number, y: number): number;
  /** Distance to the first wall along a ray at height y, or Infinity. */
  wall(x: number, z: number, dx: number, dz: number, max: number, y: number): number;
  effects: Effects | null;
  scene: THREE.Scene;
  cue(name: string): void;
  /** Shots were fired (police who see it raise the heat). */
  fired(): void;
}

export interface WeaponView {
  name: string;
  state: string;
  fill: number;
  mode: 'ready' | 'active' | 'charging' | 'off';
}

interface Shell {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  mesh: THREE.Mesh;
}
interface Mine {
  x: number; y: number; z: number;
  arm: number;
  life: number;
  mesh: THREE.Mesh;
}

const ROCKET_GEO = new THREE.CylinderGeometry(0.1, 0.13, 1.0, 8).rotateX(Math.PI / 2);
const ROCKET_MAT = new THREE.MeshStandardMaterial({ color: 0x3b4048, emissive: 0xff6a20, emissiveIntensity: 0.8 });
const MINE_GEO = new THREE.CylinderGeometry(0.42, 0.5, 0.18, 12);
const MINE_MAT = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, emissive: 0xff2020, emissiveIntensity: 0.6, roughness: 0.5 });

export const WEAPON_STATS = {
  gun: { rate: 12, damage: 4, range: 140, cone: 0.17, heatPerSec: 0.24 },
  turret: { rate: 9, damage: 3.5, range: 110 },
  rpg: { speed: 95, reload: 3, radius: 9, damage: 140, life: 3.2 },
  scatter: { reload: 1.2, range: 30, cone: 0.6, damage: 60 },
  mines: { reload: 1.4, max: 4, trigger: 4.5, radius: 8, damage: 150, life: 60 },
  rail: { charge: 0.8, cooldown: 5, range: 360, width: 3, damage: 220 },
};

export class WeaponSystem {
  id: WeaponId = 'machineGun';
  /** Gun barrels heat up while firing; at 1 they lock until cooled to 0.35. */
  heat = 0;
  overheated = false;
  reload = 0;
  charge = 0;
  private shotTimer = 0;
  readonly rockets: Shell[] = [];
  readonly mines: Mine[] = [];
  /** Fire is held off (races, garage, menus). */
  holdFire = false;
  shots = 0;
  hits = 0;

  constructor(private world: WeaponWorld) {}

  equip(id: WeaponId) {
    if (this.id === id) return;
    this.id = id;
    this.reset();
  }

  reset() {
    this.heat = 0;
    this.overheated = false;
    this.reload = 0;
    this.charge = 0;
    this.clear();
  }

  clear() {
    for (const r of this.rockets) this.world.scene.remove(r.mesh);
    for (const m of this.mines) this.world.scene.remove(m.mesh);
    this.rockets.length = 0;
    this.mines.length = 0;
  }

  /** Best target in a cone (ahead, or behind with `rear`), scored by distance and angle. */
  private aim(p: Vehicle, range: number, cone: number, rear = false) {
    const h = rear ? p.h + Math.PI : p.h;
    const fx = Math.sin(h), fz = Math.cos(h);
    let best: WeaponTarget | null = null, score = Infinity;
    for (const t of this.world.targets()) {
      const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz);
      if (d < 1 || d > range) continue;
      if (t.kind !== 'heli' && Math.abs(t.y - p.y) > 6) continue;
      const cos = (dx * fx + dz * fz) / d;
      if (cos < Math.cos(cone)) continue;
      if (t.kind !== 'heli' && this.world.wall(p.x, p.z, dx, dz, d, p.y + 1) < d - 1) continue;
      const s = d * (2 - cos) * (t.kind === 'unit' ? 1 : t.kind === 'heli' ? 1.3 : 2.5);
      if (s < score) { score = s; best = t; }
    }
    return best;
  }

  /** Advance one frame. `held`/`pressed` are the fire key's state. */
  update(dt: number, p: Vehicle, held: boolean, pressed: boolean) {
    this.reload = Math.max(0, this.reload - dt);
    this.updateRockets(dt);
    this.updateMines(dt);
    const firing = !this.holdFire && !p.totaled;
    const info = WEAPONS[this.id];
    if (info.hold && this.id !== 'railgun') {
      const want = firing && held && !this.overheated;
      if (want) {
        this.heat = Math.min(1, this.heat + WEAPON_STATS.gun.heatPerSec * dt);
        if (this.heat >= 1) { this.overheated = true; this.world.cue('ability-miss'); }
        this.shotTimer -= dt;
        const rate = this.id === 'rearTurret' ? WEAPON_STATS.turret.rate : WEAPON_STATS.gun.rate;
        while (this.shotTimer <= 0) {
          this.shotTimer += 1 / rate;
          this.bullet(p, this.id === 'rearTurret');
        }
      } else {
        this.shotTimer = 0;
        this.heat = Math.max(0, this.heat - dt * 0.4);
        if (this.overheated && this.heat <= 0.35) this.overheated = false;
      }
      return;
    }
    if (this.id === 'railgun') {
      if (firing && held && this.reload <= 0) {
        this.charge = Math.min(1, this.charge + dt / WEAPON_STATS.rail.charge);
      } else if (this.charge > 0) {
        if (this.charge >= 1 && firing) this.rail(p);
        this.charge = 0;
      }
      return;
    }
    if (!firing || !pressed || this.reload > 0) return;
    if (this.id === 'rpg') this.rocket(p);
    else if (this.id === 'scattergun') this.scatter(p);
    else if (this.id === 'mines') this.dropMine(p);
  }

  private muzzle(p: Vehicle, rear: boolean) {
    const fx = Math.sin(p.h), fz = Math.cos(p.h);
    const k = rear ? -p.spec.length * 0.35 : p.spec.length / 2 + 0.2;
    return { x: p.x + fx * k, y: p.y + (rear ? 1.45 : 0.7), z: p.z + fz * k };
  }

  private bullet(p: Vehicle, rear: boolean) {
    const s = rear ? WEAPON_STATS.turret : WEAPON_STATS.gun;
    const m = this.muzzle(p, rear);
    const fx = Math.sin(p.h) * (rear ? -1 : 1), fz = Math.cos(p.h) * (rear ? -1 : 1);
    this.shots++;
    const fx2 = this.world.effects;
    fx2?.muzzle(m.x, m.y, m.z);
    const t = this.aim(p, s.range, rear ? 1.2 : WEAPON_STATS.gun.cone, rear);
    if (this.shots % 3 === 0) this.world.cue('gunshot');
    this.world.fired();
    if (t) {
      const spread = (Math.random() - 0.5) * 0.8;
      fx2?.tracer(m.x, m.y, m.z, t.x + spread, t.y + 0.6, t.z + spread);
      fx2?.sparks(t.x, t.y + 0.7, t.z, 2);
      t.hit(s.damage, false, p.x, p.z);
      this.hits++;
      return;
    }
    // Nothing in the cone: the round flies straight until it meets a wall or runs out.
    const wall = this.world.wall(m.x, m.z, fx, fz, s.range, m.y);
    const d = Math.min(wall, s.range);
    fx2?.tracer(m.x, m.y, m.z, m.x + fx * d, m.y, m.z + fz * d);
    if (wall < s.range) fx2?.sparks(m.x + fx * d, m.y, m.z + fz * d, 2);
  }

  private rocket(p: Vehicle) {
    const s = WEAPON_STATS.rpg;
    const m = this.muzzle(p, false);
    const fx = Math.sin(p.h), fz = Math.cos(p.h);
    const sp = s.speed + Math.max(0, p.vLong);
    const mesh = new THREE.Mesh(ROCKET_GEO, ROCKET_MAT);
    mesh.position.set(m.x, m.y + 0.4, m.z);
    this.world.scene.add(mesh);
    this.rockets.push({ x: m.x, y: m.y + 0.4, z: m.z, vx: fx * sp, vy: 0.5, vz: fz * sp, life: s.life, mesh });
    this.reload = s.reload;
    this.world.cue('launch');
    this.world.effects?.muzzle(m.x, m.y + 0.4, m.z);
    this.world.fired();
  }

  private updateRockets(dt: number) {
    const s = WEAPON_STATS.rpg;
    for (const r of [...this.rockets]) {
      r.life -= dt;
      // Steer gently toward the nearest target ahead of the rocket.
      const sp = Math.hypot(r.vx, r.vy, r.vz) || 1;
      let tgt: WeaponTarget | null = null, bestD = 140;
      for (const t of this.world.targets()) {
        if (t.kind === 'traffic') continue;
        const dx = t.x - r.x, dy = t.y + 0.8 - r.y, dz = t.z - r.z, d = Math.hypot(dx, dy, dz);
        if (d > bestD || (dx * r.vx + dy * r.vy + dz * r.vz) / (d * sp) < 0.8) continue;
        bestD = d; tgt = t;
      }
      if (tgt) {
        const dx = tgt.x - r.x, dy = tgt.y + 0.8 - r.y, dz = tgt.z - r.z, d = Math.hypot(dx, dy, dz) || 1;
        const k = Math.min(1, 2.2 * dt);
        r.vx += ((dx / d) * sp - r.vx) * k;
        r.vy += ((dy / d) * sp - r.vy) * k;
        r.vz += ((dz / d) * sp - r.vz) * k;
      }
      const nx = r.x + r.vx * dt, ny = r.y + r.vy * dt, nz = r.z + r.vz * dt;
      const step = Math.hypot(nx - r.x, nz - r.z);
      let boom = r.life <= 0 || ny <= this.world.ground(nx, nz, r.y) + 0.1;
      if (!boom && this.world.wall(r.x, r.z, nx - r.x, nz - r.z, step + 0.5, r.y) < step + 0.5) boom = true;
      if (!boom) for (const t of this.world.targets()) {
        if (Math.hypot(t.x - nx, t.z - nz) < t.r + 1.2 && Math.abs(t.y + 0.8 - ny) < (t.kind === 'heli' ? 4 : 2.5)) { boom = true; break; }
      }
      r.x = nx; r.y = ny; r.z = nz;
      r.mesh.position.set(r.x, r.y, r.z);
      r.mesh.lookAt(r.x + r.vx, r.y + r.vy, r.z + r.vz);
      this.world.effects?.trail(r.x, r.y, r.z);
      if (boom) {
        this.blast(r.x, r.y, r.z, s.radius, s.damage);
        this.world.scene.remove(r.mesh);
        this.rockets.splice(this.rockets.indexOf(r), 1);
      }
    }
  }

  /** Explosion: damage falls off with distance; everything inside is hit. */
  private blast(x: number, y: number, z: number, radius: number, damage: number) {
    this.world.effects?.explosion(x, y, z, radius);
    this.world.cue('explosion');
    for (const t of this.world.targets()) {
      const d = Math.hypot(t.x - x, (t.y + 0.8 - y) * (t.kind === 'heli' ? 0.6 : 1), t.z - z);
      if (d > radius + t.r) continue;
      const k = 1 - Math.max(0, d - t.r) / radius;
      t.hit(damage * (0.5 + 0.5 * k), true, x, z);
      this.hits++;
    }
  }

  private scatter(p: Vehicle) {
    const s = WEAPON_STATS.scatter;
    const fx = Math.sin(p.h), fz = Math.cos(p.h);
    const m = this.muzzle(p, false);
    this.reload = s.reload;
    this.world.cue('gunshot');
    this.world.cue('explosion');
    this.world.fired();
    const fxs = this.world.effects;
    fxs?.muzzle(m.x, m.y, m.z);
    for (let k = -3; k <= 3; k++) {
      const a = p.h + (k / 3) * s.cone;
      fxs?.tracer(m.x, m.y, m.z, m.x + Math.sin(a) * s.range, m.y, m.z + Math.cos(a) * s.range);
    }
    for (const t of this.world.targets()) {
      if (t.kind === 'heli') continue;
      const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz);
      if (d > s.range || Math.abs(t.y - p.y) > 4) continue;
      if ((dx * fx + dz * fz) / (d || 1) < Math.cos(s.cone)) continue;
      t.hit(s.damage * (1 - (d / s.range) * 0.5), true, p.x, p.z);
      fxs?.sparks(t.x, t.y + 0.7, t.z, 6);
      this.hits++;
    }
  }

  private dropMine(p: Vehicle) {
    const s = WEAPON_STATS.mines;
    if (this.mines.length >= s.max) {
      // The oldest goes off where it is to make room.
      const old = this.mines.shift()!;
      this.world.scene.remove(old.mesh);
      this.blast(old.x, old.y, old.z, s.radius, s.damage);
    }
    const fx = Math.sin(p.h), fz = Math.cos(p.h);
    const x = p.x - fx * (p.spec.length / 2 + 1.2), z = p.z - fz * (p.spec.length / 2 + 1.2);
    const y = this.world.ground(x, z, p.y);
    const mesh = new THREE.Mesh(MINE_GEO, MINE_MAT);
    mesh.position.set(x, y + 0.1, z);
    this.world.scene.add(mesh);
    this.mines.push({ x, y, z, arm: 0.6, life: s.life, mesh });
    this.reload = s.reload;
    this.world.cue('click');
  }

  private updateMines(dt: number) {
    const s = WEAPON_STATS.mines;
    for (const m of [...this.mines]) {
      m.life -= dt;
      m.arm -= dt;
      (m.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.6;
      let boom = m.life <= 0;
      if (!boom && m.arm <= 0) {
        for (const t of this.world.targets()) {
          if (t.kind === 'heli') continue;
          if (Math.hypot(t.x - m.x, t.z - m.z) < s.trigger + t.r && Math.abs(t.y - m.y) < 2.5) { boom = true; break; }
        }
      }
      if (boom) {
        this.world.scene.remove(m.mesh);
        this.mines.splice(this.mines.indexOf(m), 1);
        this.blast(m.x, m.y + 0.3, m.z, s.radius, s.damage);
      }
    }
  }

  private rail(p: Vehicle) {
    const s = WEAPON_STATS.rail;
    const fx = Math.sin(p.h), fz = Math.cos(p.h);
    const m = this.muzzle(p, false);
    const wall = Math.min(s.range, this.world.wall(m.x, m.z, fx, fz, s.range, m.y));
    this.world.effects?.laser(m.x, m.y, m.z, m.x + fx * wall, m.y, m.z + fz * wall, 2.2);
    this.world.cue('launch');
    this.world.fired();
    for (const t of this.world.targets()) {
      const dx = t.x - m.x, dz = t.z - m.z;
      const along = dx * fx + dz * fz;
      if (along < 0 || along > wall) continue;
      const lat = Math.abs(-dx * fz + dz * fx);
      if (lat > s.width + t.r) continue;
      if (t.kind !== 'heli' && Math.abs(t.y - p.y) > 5) continue;
      if (t.kind === 'heli' && t.y - p.y > 45) continue;
      t.hit(s.damage, true, m.x, m.z);
      this.world.effects?.sparks(t.x, t.y + 0.7, t.z, 10);
      this.hits++;
    }
    this.reload = s.cooldown;
  }

  status(): WeaponView {
    const info = WEAPONS[this.id];
    if (this.holdFire) return { name: info.name, state: 'Holding fire', fill: 0, mode: 'off' };
    if (info.hold && this.id !== 'railgun') {
      if (this.overheated) return { name: info.name, state: 'Overheated', fill: 1 - this.heat, mode: 'charging' };
      return { name: info.name, state: this.heat > 0.05 ? `Heat ${Math.round(this.heat * 100)}%` : 'Ready', fill: 1 - this.heat, mode: 'ready' };
    }
    if (this.id === 'railgun' && this.charge > 0) return { name: info.name, state: `Charging ${Math.round(this.charge * 100)}%`, fill: this.charge, mode: 'active' };
    const total = this.id === 'rpg' ? WEAPON_STATS.rpg.reload : this.id === 'scattergun' ? WEAPON_STATS.scatter.reload : this.id === 'mines' ? WEAPON_STATS.mines.reload : WEAPON_STATS.rail.cooldown;
    if (this.reload > 0) return { name: info.name, state: 'Reloading', fill: 1 - this.reload / total, mode: 'charging' };
    const extra = this.id === 'mines' ? ` · ${this.mines.length}/${WEAPON_STATS.mines.max} out` : '';
    return { name: info.name, state: `Ready${extra}`, fill: 1, mode: 'ready' };
  }
}
