import { describe, expect, it } from 'vitest';
import { ApexGrip, Focus, Overclock, Overdrive, RallyHop, SecondWind } from '../src/sim/abilities';
import { CARS } from '../src/sim/cars';
import { Vehicle } from '../src/sim/Vehicle';

const tick = (a: { update: (dt: number, v: Vehicle, i: { steer: number; brake: number }) => void }, v: Vehicle, seconds: number, input = { steer: 0, brake: 0 }) => {
  for (let t = 0; t < seconds; t += 0.05) a.update(0.05, v, input);
};

describe('signature abilities (real-time cooldowns)', () => {
  it('Apex Grip: 2 s of front bite, 9 s recharge', () => {
    const v = new Vehicle(CARS.finch);
    const a = new ApexGrip();
    expect(a.trigger(v)).toBe(true);
    tick(a, v, 1);
    expect(v.mods.frontGrip).toBeGreaterThan(1.3);
    tick(a, v, 1.1);
    expect(v.mods.frontGrip).toBe(1);
    expect(a.trigger(v)).toBe(false);
    tick(a, v, 9.1);
    expect(a.status().mode).toBe('ready');
  });

  it('Overdrive: 3 s of extra drive and a higher top speed, 12 s recharge', () => {
    const v = new Vehicle(CARS.vesper);
    const a = new Overdrive();
    expect(a.trigger(v)).toBe(true);
    tick(a, v, 1);
    expect(v.mods.extraForce).toBeGreaterThan(3000);
    expect(v.mods.topSpeedMul).toBeGreaterThan(1.1);
    tick(a, v, 2.1);
    expect(v.mods.extraForce).toBe(0);
    expect(a.trigger(v)).toBe(false);
    tick(a, v, 12.1);
    expect(a.status().mode).toBe('ready');
  });

  it('Second Wind grows in a straight line and bleeds when turning', () => {
    const v = new Vehicle(CARS.foundry);
    const a = new SecondWind();
    a.trigger(v);
    tick(a, v, 1.2);
    const straight = a.bonus;
    v.w = 0.8;
    tick(a, v, 0.6, { steer: 1, brake: 0 });
    expect(a.bonus).toBeLessThan(straight);
    tick(a, v, 1.5);
    expect(a.cooldown).toBeGreaterThan(13);
    tick(a, v, 15.1);
    expect(a.status().mode).toBe('ready');
  });

  it('Overclock spends the capacitor and clean braking refills it', () => {
    const v = new Vehicle(CARS.kestrel);
    const a = new Overclock();
    a.trigger(v);
    tick(a, v, 2.1);
    expect(a.capacitor).toBeLessThan(0.1);
    expect(a.trigger(v)).toBe(false);
    v.speed = 20; v.vLong = 20; v.slipAngle = 0;
    tick(a, v, 3, { steer: 0, brake: 1 });
    expect(a.capacitor).toBeGreaterThan(0.5);
    expect(a.trigger(v)).toBe(true);
  });

  it('Rally Hop leaves the ground and recharges in 12 s', () => {
    const v = new Vehicle(CARS.northline);
    v.place(0, 0, 0, 20);
    const a = new RallyHop();
    expect(a.trigger(v)).toBe(true);
    let maxY = 0;
    for (let i = 0; i < 240; i++) { v.step(1 / 120, { throttle: 0.5, brake: 0, steer: 0, drift: false, nitro: false }); a.update(1 / 120, v); maxY = Math.max(maxY, v.y); }
    expect(maxY).toBeGreaterThan(0.6);
    expect(v.airborne).toBe(false);
    expect(a.lastLanding).toBe('clean');
    expect(v.speed).toBeGreaterThan(18);
    tick(a, v, 10.1);
    expect(a.status().mode).toBe('ready');
  });

  it('Focus slows the simulation for 2.5 real seconds and recharges in 18', () => {
    const v = new Vehicle(CARS.meridian);
    const a = new Focus();
    a.trigger(v);
    expect(a.timeScale()).toBeLessThan(0.5);
    tick(a, v, 2.6);
    expect(a.timeScale()).toBe(1);
    expect(a.trigger(v)).toBe(false);
    tick(a, v, 18.1);
    expect(a.trigger(v)).toBe(true);
  });
});
