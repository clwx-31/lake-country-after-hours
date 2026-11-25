import { describe, expect, it } from 'vitest';
import { Course } from '../src/events/Course';
import { EVENTS, EVENT_ORDER } from '../src/events/defs';
import { LaneGraph } from '../src/map/lanes';
import { GARAGE, REHEARSAL, VENUE, venueFrame } from '../src/map/places';
import { buildCurbs, buildRoadLayer, layerIndex } from '../src/map/roadGeometry';
import { loadTestDistrict } from './helpers';

const d = loadTestDistrict();
const layer = buildRoadLayer(d, 0);
const idx = layerIndex(layer);
const names = (osm: number) => {
  const n = d.nodes[d.nodeByOsm.get(osm)!];
  return new Set(n.edges.map((e) => d.edges[e].name));
};

describe('road graph from OpenStreetMap', () => {
  it('is one connected network', () => {
    const dist = d.distancesFrom(0);
    expect([...dist].every(Number.isFinite)).toBe(true);
    expect(d.nodes.length).toBeGreaterThan(300);
  });

  it('keeps shared OSM junctions downtown Hartland', () => {
    const church = names(233134402);
    expect(church.has('East Capitol Drive') && church.has('Church Street')).toBe(true);
    const north = names(233232842);
    for (const n of ['East Capitol Drive', 'West Capitol Drive', 'North Avenue', 'Hill Street']) expect(north.has(n)).toBe(true);
  });

  it('has the WIS 16 freeway with real overpasses and one-way carriageways', () => {
    const fw = d.edges.filter((e) => e.name === 'WIS 16');
    expect(fw.reduce((s2, e) => s2 + e.length, 0)).toBeGreaterThan(15000);
    expect(fw.every((e) => e.oneway)).toBe(true);
    const over = d.edges.find((e) => e.bridge && e.name === 'WIS 16' && Math.abs(e.path.pointAt(e.length / 2).x - 650) < 40);
    expect(over).toBeTruthy();
    // The freeway deck sits well above North Avenue passing underneath.
    const mid = over!.path.pointAt(over!.length / 2);
    expect(d.heightOnEdge(over!.index, over!.length / 2) - d.terrain.height(mid.x, mid.z)).toBeGreaterThan(3);
  });

  it('follows the real terrain: hills on Winkleman Road, roads draped on the ground', () => {
    const wink = d.edges.filter((e) => e.name === 'Winkleman Road');
    const ys = wink.flatMap((e) => e.ys);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(8);
    let worst = 0;
    for (const e of d.edges) {
      if (e.bridge) continue;
      for (let s2 = 0; s2 < e.length; s2 += 20) {
        const p = e.path.pointAt(s2);
        worst = Math.max(worst, Math.abs(d.heightOnEdge(e.index, s2) - d.terrain.height(p.x, p.z)));
      }
    }
    expect(worst).toBeLessThan(2.5);
  });

  it('routes every event leg in sequence on legal (one-way respecting) roads', () => {
    for (const id of EVENT_ORDER) {
      const c = new Course(d, id, EVENTS[id].waypoints);
      expect(c.length).toBeGreaterThan(100);
      // Each leg shares its junction with the next.
      for (let k = 1; k < c.edges.length; k++) {
        const a = d.edges[c.edges[k - 1]], b = d.edges[c.edges[k]];
        const shared = [a.a, a.b].filter((n) => n === b.a || n === b.b);
        expect(shared.length).toBeGreaterThan(0);
      }
      // The route stays on asphalt the whole way.
      let on = 0, total = 0;
      for (let s = 0; s < c.length; s += 4) {
        const p = c.path.pointAt(s);
        total++;
        if (idx.index.query(p.x, p.z) >= 0) on++;
      }
      expect(on / total).toBeGreaterThan(0.99);
    }
  });

  it('places fictional venues beside real streets', () => {
    for (const v of [GARAGE, REHEARSAL, VENUE]) {
      const f = venueFrame(d, v);
      expect(idx.index.query(f.curb.x, f.curb.z)).toBeGreaterThanOrEqual(0);
      expect(idx.index.query(f.center.x, f.center.z)).toBe(-1);
    }
  });
});

describe('road surfaces', () => {
  it('joins every trimmed strip to its junction polygon without gaps', () => {
    let checked = 0;
    for (const j of layer.junctions) {
      if (j.kind !== 'junction') continue;
      const ring = new Set<string>();
      for (let i = 0; i < j.poly.length; i += 2) ring.add(`${j.poly[i].toFixed(4)},${j.poly[i + 1].toFixed(4)}`);
      for (const ei of d.nodes[j.node].edges) {
        const st = layer.strips[ei];
        const e = d.edges[ei];
        const n = st.left.length;
        const corners = e.a === j.node ? [st.left.slice(0, 2), st.right.slice(0, 2)] : [st.left.slice(n - 2), st.right.slice(n - 2)];
        if (e.a === j.node && e.b === j.node) continue;
        for (const c of corners) {
          expect(ring.has(`${c[0].toFixed(4)},${c[1].toFixed(4)}`)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('never runs a curb through asphalt', () => {
    const curbs = buildCurbs(d, layer, idx);
    let bad = 0, total = 0;
    for (const c of curbs) {
      for (let i = 0; i + 3 < c.length; i += 2) {
        const mx = (c[i] + c[i + 2]) / 2, mz = (c[i + 1] + c[i + 3]) / 2;
        const dx = c[i + 2] - c[i], dz = c[i + 3] - c[i + 1];
        const l = Math.hypot(dx, dz) || 1;
        // Outward is right of travel; probe 1.2 m out.
        const ox = mx + (-dz / l) * 1.2, oz = mz + (dx / l) * 1.2;
        total++;
        if (idx.index.query(ox, oz) >= 0) bad++;
      }
    }
    expect(total).toBeGreaterThan(5000);
    expect(bad / total).toBeLessThan(0.01);
  });

  it('gives civil traffic right-hand lanes with connected turns', () => {
    const lanes = new LaneGraph(d, layer);
    expect(lanes.lanes.length).toBeGreaterThan(900);
    let deadEnds = 0;
    for (const l of lanes.lanes) {
      if (!l.outs.length) { deadEnds++; continue; }
      for (const ci of l.outs) {
        const c = lanes.conns[ci];
        const end = l.path.pointAt(l.path.length);
        const start = c.path.pointAt(0);
        expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeLessThan(0.01);
      }
    }
    expect(deadEnds / lanes.lanes.length).toBeLessThan(0.02);
    // A forward lane on a two-way street sits right of the centerline.
    const e = d.edges.find((x) => x.name === 'East Capitol Drive' && !x.oneway)!;
    const lane = lanes.lanes[lanes.lanesByEdge[e.index].find((id) => lanes.lanes[id].forward)!];
    const mid = lane.path.pointAt(lane.path.length / 2);
    const pr = e.path.project(mid.x, mid.z);
    expect(pr.lateral).toBeGreaterThan(1);
  });
});

describe('terrain surface', () => {
  it('heights follow the ground mesh triangles exactly (no gaps for draped roads)', () => {
    const T = d.terrain, t = T.info!;
    for (let k = 0; k < 400; k++) {
      const i = 50 + ((k * 37) % (t.width - 100)), j = 50 + ((k * 53) % (t.height - 100));
      const x0 = t.originX + i * t.spacing, z0 = t.originZ + j * t.spacing;
      // Grid points are exact.
      expect(T.height(x0, z0)).toBeCloseTo(T.sample(i, j), 4);
      // Both triangles (split along the b-c diagonal) are planar.
      const a = T.sample(i, j), b = T.sample(i + 1, j), c = T.sample(i, j + 1), e = T.sample(i + 1, j + 1);
      expect(T.height(x0 + 0.25 * t.spacing, z0 + 0.25 * t.spacing)).toBeCloseTo(a + 0.25 * (b - a) + 0.25 * (c - a), 4);
      expect(T.height(x0 + 0.75 * t.spacing, z0 + 0.75 * t.spacing)).toBeCloseTo(e + 0.25 * (c - e) + 0.25 * (b - e), 4);
      // The shared diagonal is continuous.
      expect(T.height(x0 + 0.5 * t.spacing, z0 + 0.5 * t.spacing)).toBeCloseTo((b + c) / 2, 4);
    }
  });

  it('reaches North Lake and the Village of Merton', () => {
    expect(d.bounds.minZ).toBeLessThan(-8000);
    expect(d.bounds.maxX).toBeGreaterThan(5900);
    expect(d.data.villages!.some((v) => v.n === 'Merton')).toBe(true);
    const hwy83North = d.edges.filter((e) => e.name === 'State Highway 83').some((e) => e.pts.some((_, i) => i % 2 === 1 && e.pts[i] < -6000));
    expect(hwy83North).toBe(true);
    const lake = d.data.water.find((w) => w.name === 'North Lake')!;
    expect(lake).toBeTruthy();
    // The whole lake is inside the map now.
    for (let i = 1; i < lake.outer.length; i += 2) expect(lake.outer[i]).toBeGreaterThan(d.bounds.minZ);
  });
});
