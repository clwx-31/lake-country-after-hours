import { describe, expect, it } from 'vitest';
import { CAUGHT, HEAT_LEVELS, HeatState, LOS_GRACE } from '../src/sim/heat';

const run = (h: HeatState, seconds: number, seen: boolean, pinned = false) => {
  for (let t = 0; t < seconds; t += 0.05) h.update(0.05, seen, pinned);
};

describe('wanted level transitions', () => {
  it('starts at one star from a witnessed collision and names the trigger', () => {
    const h = new HeatState();
    expect(h.award(4, 'Witnessed collision — Hartwell', 10, 99)).toBe(true);
    expect(h.stars).toBe(1);
    expect(h.phase).toBe('pursuit');
    expect(h.reason).toContain('Witnessed');
  });

  it('debounces collisions so one scrape cannot award five stars', () => {
    const h = new HeatState();
    h.award(100, 'big hit', 0, 1);
    expect(h.stars).toBe(1); // at most one star per award
    expect(h.award(100, 'same car again', 1, 1)).toBe(false); // global debounce
    expect(h.award(100, 'same car later', 2, 1)).toBe(false); // per-body debounce
    expect(h.award(100, 'other car', 2.2, 2)).toBe(true);
    expect(h.stars).toBe(2);
    expect(HEAT_LEVELS.map((l) => l.maxUnits)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('moves pursuit -> searching -> escaped and pays the escape reward', () => {
    const h = new HeatState();
    h.award(4, 'test', 0, 1);
    run(h, 1, true);
    run(h, LOS_GRACE + 0.1, false);
    expect(h.phase).toBe('search');
    run(h, 2, true);
    expect(h.phase).toBe('pursuit');
    run(h, LOS_GRACE + 0.1, false);
    expect(h.phase).toBe('search');
    run(h, HEAT_LEVELS[1].searchTime + 0.5, false);
    const ev = h.drain();
    const esc = ev.find((e) => e.type === 'escaped');
    expect(esc && esc.type === 'escaped' && esc.reward).toBeGreaterThanOrEqual(HEAT_LEVELS[1].escapeReward);
    expect(h.stars).toBe(0);
    expect(h.phase).toBe('calm');
  });

  it('fills the caught meter only while pinned and drains when free', () => {
    const h = new HeatState();
    h.award(4, 'test', 0, 1);
    run(h, CAUGHT.fill * 0.5, true, true);
    expect(h.caughtMeter).toBeGreaterThan(0.4);
    run(h, CAUGHT.drain, true, false);
    expect(h.caughtMeter).toBe(0);
    run(h, CAUGHT.fill + 0.2, true, true);
    expect(h.drain().some((e) => e.type === 'caught')).toBe(true);
    expect(h.stars).toBe(0);
  });

  it('Quiet Drive blocks heat, but an opt-in event can force it', () => {
    const h = new HeatState();
    h.quiet = true;
    expect(h.award(10, 'crash', 0, 1)).toBe(false);
    h.forced = true;
    h.setStars(1, 'Encore');
    expect(h.stars).toBe(1);
  });

  it('runs a five-star crescendo and keeps held pursuits from clearing', () => {
    const h = new HeatState();
    h.forced = true;
    h.hold = true;
    h.setStars(5, 'Encore gate');
    expect(h.drain().some((e) => e.type === 'crescendo-start')).toBe(true);
    run(h, 1, true);
    run(h, 80, false);
    expect(h.stars).toBe(5);
    expect(h.searchMeter).toBeGreaterThanOrEqual(0.12);
    expect(h.drain().some((e) => e.type === 'crescendo-end')).toBe(true);
  });

  it('lets an opt-in escape event clear when the search runs out', () => {
    const h = new HeatState();
    h.quiet = true;
    h.forced = true;
    h.setStars(4, 'Underway Escape');
    run(h, 1, true);
    run(h, 60, false);
    expect(h.stars).toBe(0);
    expect(h.drain().some((e) => e.type === 'escaped')).toBe(true);
  });
});
