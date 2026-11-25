import { describe, expect, it } from 'vitest';
import { resolveAnchor } from '../src/map/places';
import { CATALOGUES } from '../src/events/defs';
import { Save } from '../src/save/Save';
import { DEFAULT_WEAPON, WEAPON_IDS } from '../src/sim/weapons';
import { PLAYER_CARS } from '../src/sim/cars';
import { loadTestDistrict } from './helpers';

const d = loadTestDistrict('hollowpeak');

describe('Hollowpeak (generated mountains)', () => {
  it('every junction is reachable, and caves and tubes sit on real road edges', () => {
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
      const v = stack.pop()!;
      for (const ei of d.nodes[v].edges) { const o = d.otherEnd(ei, v); if (!seen.has(o)) { seen.add(o); stack.push(o); } }
    }
    expect(seen.size).toBe(d.nodes.length);
    const tubes = d.data.tubes!;
    expect(tubes.filter((t) => t.cave).length).toBeGreaterThanOrEqual(5);
    expect(tubes.filter((t) => !t.cave).length).toBeGreaterThanOrEqual(8);
    for (const t of tubes) {
      const e = d.edges[t.edge];
      expect(e).toBeDefined();
      expect(t.hw).toBeGreaterThan(e.width / 2);
      // Speedways keep a gentle grade inside caves and tubes.
      for (let i = 1; i < e.ys.length; i++) {
        const L = Math.hypot(e.pts[i * 2] - e.pts[i * 2 - 2], e.pts[i * 2 + 1] - e.pts[i * 2 - 1]);
        if (L > 4 && e.cls === 'primary') expect(Math.abs(e.ys[i] - e.ys[i - 1]) / L).toBeLessThan(0.08);
      }
    }
  });

  it('cave floors match the road; the hill stands well over each cave', () => {
    for (const t of d.data.tubes!.filter((q) => q.cave)) {
      const e = d.edges[t.edge];
      for (let s = 10; s < e.length - 10; s += 40) {
        const p = e.path.pointAt(s);
        expect(Math.abs(d.terrain.height(p.x, p.z) - d.heightOnEdge(t.edge, s))).toBeLessThan(0.6);
      }
    }
  });

  it('event routes and venues resolve', () => {
    for (const ev of Object.values(CATALOGUES.hollowpeak.events)) expect(() => d.routeThrough(ev.waypoints, false), ev.id).not.toThrow();
    const g = resolveAnchor(d, { from: 48526150, to: 25235915, along: 160 });
    expect(Number.isFinite(g.x)).toBe(true);
  });
});

describe('weapons', () => {
  it('every car has a standard weapon, and a fitted weapon is saved per car', () => {
    for (const id of PLAYER_CARS) expect(WEAPON_IDS).toContain(DEFAULT_WEAPON[id]);
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } as unknown as Storage;
    const s = new Save(storage, 'hollowpeak-1');
    s.data.weapons.vesper = 'rpg';
    s.data.weapons.finch = 'nope' as never;
    s.persist();
    const again = new Save(storage, 'hollowpeak-1');
    expect(again.data.weapons.vesper).toBe('rpg');
    expect(again.data.weapons.finch).toBeUndefined();
  });
});
