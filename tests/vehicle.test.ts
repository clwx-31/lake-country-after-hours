import { describe, expect, it } from 'vitest';
import { CARS, PLAYER_CARS } from '../src/sim/cars';
import { DRIFT_TIERS, Vehicle, measureCar, type DriveInput } from '../src/sim/Vehicle';

const dt = 1 / 120;
const input = (o: Partial<DriveInput>): DriveInput => ({ throttle: 0, brake: 0, steer: 0, drift: false, nitro: false, ...o });

describe('arcade handling', () => {
  it('Finch makes a clean ninety at neighbourhood speed and settles straight', () => {
    const v = new Vehicle(CARS.finch);
    v.place(0, 0, 0, 9);
    let maxSlip = 0;
    while (v.h < Math.PI / 2) {
      v.step(dt, input({ throttle: Math.max(0, (9 - v.speed) * 0.5 + 0.2), steer: -1 }));
      maxSlip = Math.max(maxSlip, Math.abs(v.slipAngle));
    }
    for (let i = 0; i < 120; i++) v.step(dt, input({ throttle: 0.3 }));
    expect(maxSlip * 57.3).toBeLessThan(9);
    expect(Math.abs(v.w)).toBeLessThan(0.1);
  });

  it('turns wider at speed but never washes out into a spin', () => {
    const v = new Vehicle(CARS.finch);
    v.place(0, 0, 0, 25);
    let maxSlip = 0, t = 0;
    while (v.h < Math.PI / 2 && t < 6) { v.step(dt, input({ throttle: 0.6, steer: -1 })); maxSlip = Math.max(maxSlip, Math.abs(v.slipAngle)); t += dt; }
    expect(v.speed / Math.abs(v.w)).toBeGreaterThan(25);
    expect(maxSlip * 57.3).toBeLessThan(15);
  });

  it('kart drift: hop in, spark tiers charge in order, release fires a mini-turbo', () => {
    const v = new Vehicle(CARS.vesper);
    v.place(0, 0, 0, 20);
    const cues: string[] = [];
    let maxSlip = 0, t = 0;
    while (t < DRIFT_TIERS[2] / CARS.vesper.driftCharge + 0.4) {
      v.step(dt, input({ throttle: 1, steer: 1, drift: true }));
      cues.push(...v.cues.splice(0));
      maxSlip = Math.max(maxSlip, Math.abs(v.slipAngle));
      t += dt;
    }
    expect(v.drifting).toBe(true);
    expect(v.driftTier).toBe(3);
    const order = cues.filter((c) => c === 'drift' || c.startsWith('tier'));
    expect(order).toEqual(['drift', 'tier1', 'tier2', 'tier3']);
    const before = v.speed;
    v.step(dt, input({ throttle: 1 }));
    cues.push(...v.cues.splice(0));
    expect(cues).toContain('boost');
    expect(v.boostTime).toBeGreaterThan(1);
    for (let i = 0; i < 60; i++) v.step(dt, input({ throttle: 1 }));
    expect(v.speed).toBeGreaterThan(before + 1);
    // Drift angle stays arcade-sized: sideways enough to read, never a spin.
    expect(maxSlip * 57.3).toBeGreaterThan(12);
    expect(maxSlip * 57.3).toBeLessThan(45);
  });

  it('a short drift with no spark tier gives no boost, and walking pace cannot drift', () => {
    const v = new Vehicle(CARS.vesper);
    v.place(0, 0, 0, 20);
    for (let i = 0; i < 40; i++) v.step(dt, input({ throttle: 1, steer: 1, drift: true }));
    v.step(dt, input({ throttle: 1 }));
    expect(v.boostTime).toBe(0);
    const slow = new Vehicle(CARS.vesper);
    slow.place(0, 0, 0, 3);
    for (let i = 0; i < 60; i++) slow.step(dt, input({ throttle: 0.2, steer: 1, drift: true }));
    expect(slow.drifting).toBe(false);
  });

  it('follows the ground up a hill and launches off a crest, landing with an air cue', () => {
    const v = new Vehicle(CARS.northline);
    // A 12% climb to a crest at z = 80, a steep drop, then a flat run-out.
    v.ground = (_x, z) => (z < 80 ? Math.max(0, z) * 0.12 : Math.max(3, 9.6 - (z - 80) * 0.3));
    v.place(0, 20, 0, 30);
    let maxGap = 0, landed = 0;
    for (let i = 0; i < 120 * 5; i++) {
      v.step(dt, input({ throttle: 1 }));
      if (v.z < 70) expect(Math.abs(v.y - v.ground(v.x, v.z, v.y))).toBeLessThan(0.05);
      maxGap = Math.max(maxGap, v.y - v.ground(v.x, v.z, v.y));
      for (const c of v.cues.splice(0)) if (c === 'land') landed = v.landedAir;
    }
    expect(maxGap).toBeGreaterThan(1);
    expect(landed).toBeGreaterThan(0.35);
    expect(v.airborne).toBe(false);
  });

  it('weight transfer pitches the nose down under braking', () => {
    const v = new Vehicle(CARS.foundry);
    v.place(0, 0, 0, 25);
    for (let i = 0; i < 40; i++) v.step(dt, input({ brake: 1 }));
    expect(v.pitch).toBeGreaterThan(0.01);
    expect(v.braking).toBe(true);
  });

  it('a curb bump never adds horizontal or vertical launch', () => {
    const v = new Vehicle(CARS.northline);
    v.place(0, 0, 0, 20);
    v.step(dt, input({}));
    const before = v.speed;
    for (let i = 0; i < 10; i++) { v.kick(-3); v.step(dt, input({})); }
    expect(v.y).toBe(0);
    expect(v.speed).toBeLessThanOrEqual(before + 0.01);
  });

  it('measures distinct, much faster figures for every car', () => {
    const m = Object.fromEntries(PLAYER_CARS.map((id) => [id, measureCar(CARS[id])]));
    const garage = PLAYER_CARS.filter((id) => id !== 'zenith');
    for (const id of garage) {
      // Fast arcade cars: sub-2.5 s launches, 165+ mph, short arcade brakes.
      expect(m[id].zeroTo60).toBeGreaterThan(1.3);
      expect(m[id].zeroTo60).toBeLessThan(2.6);
      expect(m[id].topSpeedMph).toBeGreaterThan(160);
      expect(m[id].topSpeedMph).toBeLessThan(290);
      expect(m[id].brake60Ft).toBeGreaterThan(30);
      expect(m[id].brake60Ft).toBeLessThan(80);
    }
    // Every car measures differently.
    expect(new Set(PLAYER_CARS.map((id) => `${m[id].zeroTo60.toFixed(2)}/${Math.round(m[id].topSpeedMph)}`)).size).toBe(PLAYER_CARS.length);
    expect(m.meridian.topSpeedMph).toBeGreaterThan(m.finch.topSpeedMph + 50);
    expect(m.lancer.topSpeedMph).toBe(Math.max(...garage.map((id) => m[id].topSpeedMph)));
    const original = ['finch', 'vesper', 'foundry', 'kestrel', 'northline', 'meridian'] as const;
    expect(m.foundry.brake60Ft).toBe(Math.max(...original.map((id) => m[id].brake60Ft)));
    expect(m.kestrel.zeroTo60).toBeLessThan(m.vesper.zeroTo60);
  });

  it('the Zenith 400 reaches 400 mph and beats every other car at everything', () => {
    const m = Object.fromEntries(PLAYER_CARS.map((id) => [id, measureCar(CARS[id])]));
    const z = m.zenith;
    expect(z.topSpeedMph).toBeGreaterThanOrEqual(400);
    expect(z.topSpeedMph).toBeLessThan(410);
    for (const id of PLAYER_CARS) {
      if (id === 'zenith') continue;
      expect(z.topSpeedMph).toBeGreaterThan(m[id].topSpeedMph + 100);
      expect(z.zeroTo60).toBeLessThan(m[id].zeroTo60);
      expect(z.brake60Ft).toBeLessThanOrEqual(m[id].brake60Ft);
      expect(CARS.zenith.aLat).toBeGreaterThan(CARS[id].aLat);
      expect(CARS.zenith.durability).toBeGreaterThan(CARS[id].durability);
    }
  });
});
