import { describe, expect, it } from 'vitest';
import { buildRoadLayer, stripPolygon } from '../src/map/roadGeometry';
import { resolveAnchor } from '../src/map/places';
import { CATALOGUES } from '../src/events/defs';
import { Ground } from '../src/sim/Ground';
import { loadTestDistrict } from './helpers';

const d = loadTestDistrict('ironport');
const ip = (x: number, z: number, level = 0) => level * 1e8 + (x + 2000) * 1e4 + (z + 2000);

/** The same decks the game builds: bridge strips, raised junctions, slabs over tunnels. */
function ironportGround() {
  const side = buildRoadLayer(d, (ei) => (d.edges[ei].bridge ? 1.4 : 1.6));
  const strips = side.strips.filter((s) => d.edges[s.edge].bridge).map((s) => ({ edge: s.edge, poly: stripPolygon(s) }));
  const flat: { poly: number[]; y: number; node?: number; lid?: boolean }[] = [];
  for (const j of side.junctions) {
    if (!d.nodes[j.node].edges.some((ei) => d.edges[ei].bridge)) continue;
    flat.push({ poly: j.poly, y: d.data.nodeY![j.node], node: j.node });
  }
  const U = d.data.under!;
  const rect = (r: number[]) => [r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3]];
  for (const r of U.lids) flat.push({ poly: rect(r), y: U.top, lid: true });
  for (const r of U.copings) flat.push({ poly: rect(r), y: U.top });
  return new Ground(d, strips, flat);
}

describe('Ironport (generated city)', () => {
  it('has roads on five levels and every junction is reachable', () => {
    const levels = new Set(d.edges.map((e) => e.level));
    expect([...levels].sort()).toEqual([-1, 0, 1, 2, 3]);
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
      const v = stack.pop()!;
      for (const ei of d.nodes[v].edges) {
        const o = d.otherEnd(ei, v);
        if (!seen.has(o)) { seen.add(o); stack.push(o); }
      }
    }
    expect(seen.size).toBe(d.nodes.length);
  });

  it('event starts, venues and the tunnel junction resolve', () => {
    for (const ev of Object.values(CATALOGUES.ironport.events)) {
      expect(() => d.routeThrough(ev.waypoints, false), ev.id).not.toThrow();
    }
    const garage = resolveAnchor(d, { from: ip(-1200, 150), to: ip(-1200, 300), along: 70 });
    expect(garage.x).toBe(-1200);
    // The Canal and Market tunnels meet underground.
    const under = d.nodeByOsm.get(ip(-450, 450, 1))!;
    expect(d.data.nodeY![under]).toBe(20);
    expect(d.nodes[under].edges.length).toBe(4);
  });

  it('stands a car on the level it is driving on where decks stack', () => {
    const G = ironportGround();
    // The Stack: Highline over the Crosstown Viaduct over a block at street level.
    expect(G.height(75, -75, 56)).toBeCloseTo(56, 1);
    expect(G.height(75, -75, 48)).toBeCloseTo(48, 1);
    expect(G.height(75, -75, 30)).toBeCloseTo(30, 1);
    expect(G.height(75, -75, -1e9)).toBeCloseTo(30, 1);
    expect(G.height(75, -75)).toBeCloseTo(56, 1); // no hint: the top deck
    // The Skyway over the viaduct's crossing.
    expect(G.height(975, -75, 40)).toBeCloseTo(40, 1);
    expect(G.height(975, -75, 48)).toBeCloseTo(48, 1);
    // In the Canal Underway: floor below, lid (street level) above.
    expect(G.height(-1250, 450, 20)).toBeCloseTo(20, 1);
    expect(G.height(-1250, 450, 30)).toBeCloseTo(30, 1);
    expect(G.ceiling(-1250, 450, 20)).toBeCloseTo(29, 1); // the lid's underside
    // An open cut has no roof.
    expect(G.ceiling(-1580, 450, 26)).toBe(Infinity);
  });

  it('finds the road at the right height', () => {
    expect(d.edges[d.nearestEdge(975, -300, 40, undefined, 40)!.edge].name).toBe('Skyway Loop');
    expect(d.edges[d.nearestEdge(975, -300, 40, undefined, 30)!.edge].level).toBe(0);
    expect(d.edges[d.nearestEdge(-1250, 452, 40, undefined, 20)!.edge].name).toBe('Canal Underway');
    expect(d.streetNameAt(75, -75, undefined, 56)).toBe('Highline');
    expect(d.streetNameAt(75, -75, undefined, 48)).toBe('Crosstown Viaduct');
  });

  it('keeps clearance wherever roads on different levels cross', () => {
    const segs: { e: number; ax: number; az: number; bx: number; bz: number; ya: number; yb: number }[] = [];
    d.edges.forEach((e, ei) => {
      for (let i = 0; i + 3 < e.pts.length; i += 2) segs.push({ e: ei, ax: e.pts[i], az: e.pts[i + 1], bx: e.pts[i + 2], bz: e.pts[i + 3], ya: e.ys[i / 2], yb: e.ys[i / 2 + 1] });
    });
    let crossings = 0;
    for (let i = 0; i < segs.length; i++) {
      const p = segs[i];
      for (let j = i + 1; j < segs.length; j++) {
        const q = segs[j];
        if (p.e === q.e) continue;
        const rx = p.bx - p.ax, rz = p.bz - p.az, sx = q.bx - q.ax, sz = q.bz - q.az;
        const den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((q.ax - p.ax) * sz - (q.az - p.az) * sx) / den, u = ((q.ax - p.ax) * rz - (q.az - p.az) * rx) / den;
        if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) continue;
        const y1 = p.ya + (p.yb - p.ya) * t, y2 = q.ya + (q.yb - q.ya) * u;
        crossings++;
        expect(Math.abs(y1 - y2), `${d.edges[p.e].name} x ${d.edges[q.e].name}`).toBeGreaterThan(6.4);
      }
    }
    expect(crossings).toBeGreaterThan(20);
  });
});
