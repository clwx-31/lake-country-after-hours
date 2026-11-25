// Road graph built from the converted OpenStreetMap district. Everything that
// needs street geometry (meshes, lanes, HUD street names, minimap, routes) reads it here.
import { Path, distToSegment, headingOf, polylineLength } from '../core/math';
import { Terrain, type TerrainInfo } from './Terrain';

export interface EdgeData {
  a: number;
  b: number;
  way: number;
  name: string;
  cls: string;
  w: number;
  lf: number;
  lb: number;
  ow: number;
  br: number;
  ly: number;
  sp: number;
  pts: number[];
  /** Road surface height per polyline point (terrain maps only). */
  ys?: number[];
  /** Level: -1 tunnel, 0 street, 1+ elevated (generated maps). */
  lv?: number;
}

export interface BuildingData {
  p: number[];
  k: 'h' | 'c' | 'i' | 's' | 'y';
  h?: number;
  l?: number;
  n?: string;
  a?: string;
  am?: string;
  lm?: string;
  cx?: number;
  cz?: number;
  r?: number;
  /** Generated (not an OpenStreetMap footprint); fx,fz face the street. */
  gen?: number;
  fx?: number;
  fz?: number;
  est?: number;
  drive?: number[];
  barn?: number;
  /** Generated city: facade style, wall colour, and no height cap. */
  st?: number;
  col?: string;
  tall?: number;
}

/** Below-street structures on a generated map (axis-aligned, metres). */
export interface UnderData {
  /** Street level: lids and copings sit here. */
  top: number;
  /** Tunnel roofs [x0, z0, x1, z1]. */
  lids: number[][];
  /** Street-level slabs beside a trench [x0, z0, x1, z1]. */
  copings: number[][];
  /** Trench walls [ax, az, bx, bz, floorA, floorB, side, covered]; side = which way the floor lies (+-1 x, +-2 z). */
  walls: number[][];
  /** Barriers along open trench edges [ax, az, bx, bz]. */
  barriers: number[][];
}

export interface DistrictData {
  meta: {
    title: string;
    attribution: string;
    attributionUrl: string;
    terrainAttribution?: string;
    license: string;
    source: string;
    snapshot: string | null;
    crop: { south: number; west: number; north: number; east: number };
    anchor: { lat: number; lon: number; label: string };
    convertedAt: string;
    command: string;
    counts: Record<string, number>;
  };
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  nodes: [number, number, number][];
  edges: EdgeData[];
  boundaryExits: number[];
  water: { name: string; outer: number[]; holes: number[][]; level?: number }[];
  rivers: { name: string; pts: number[] }[];
  buildings: BuildingData[];
  parks: { k: string; n: string; p: number[] }[];
  landmarks: { name: string; kind: string; x: number; z: number; lm?: string; addr?: string }[];
  terrain?: TerrainInfo;
  nodeY?: number[];
  landcover?: { k: string; n: string; p: number[] }[];
  villages?: { n: string; kind: string; p: number[] }[];
  docks?: { x: number; z: number; dx: number; dz: number; len: number; y: number }[];
  rail?: { n: string; br: number; pts: number[] }[];
  under?: UnderData;
  /** Covered road sections (generated maps): caves through hills and speed tubes. */
  tubes?: TubeData[];
  /** Hill surface over the caves (a second heightfield file). */
  surface?: { file: string };
}

export interface TubeData {
  edge: number;
  /** Half-width to the inside of the walls, and the height of the roof above the road. */
  hw: number;
  h: number;
  /** 1: a cave under a hill (its roof is the hill); 0: a tube built over the road. */
  cave: number;
}

export interface GNode {
  index: number;
  osm: number;
  x: number;
  z: number;
  edges: number[];
  boundary: boolean;
}

export interface GEdge {
  index: number;
  a: number;
  b: number;
  name: string;
  cls: string;
  width: number;
  lanesF: number;
  lanesB: number;
  oneway: boolean;
  bridge: boolean;
  speed: number; // m/s
  pts: number[];
  path: Path;
  length: number;
  /** Surface height at each path point (empty on flat maps). */
  ys: number[];
  /** -1 tunnel, 0 street level, 1+ elevated. */
  level: number;
}

export interface EdgeHit {
  edge: number;
  s: number;
  d: number;
  lateral: number;
  x: number;
  z: number;
}

const MPH = 0.44704;
export const ROAD_RANK: Record<string, number> = {
  primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 2, living_street: 1,
  primary_link: 3, secondary_link: 3, tertiary_link: 2,
};

export class District {
  readonly nodes: GNode[];
  readonly edges: GEdge[];
  readonly nodeByOsm = new Map<number, number>();
  readonly bounds: DistrictData['bounds'];
  private grid = new Map<number, number[]>(); // packed (edge<<12 | seg)
  private readonly cell = 25;

  readonly terrain: Terrain;
  /** The hill surface over caves (same grid as `terrain`), when the map has caves. */
  surface: Terrain | null = null;

  constructor(readonly data: DistrictData, terrain: Terrain = Terrain.flat()) {
    this.terrain = terrain;
    this.bounds = data.bounds;
    this.nodes = data.nodes.map((n, index) => ({ index, osm: n[0], x: n[1], z: n[2], edges: [], boundary: n[0] < 0 }));
    this.nodes.forEach((n) => this.nodeByOsm.set(n.osm, n.index));
    this.edges = data.edges.map((e, index) => {
      const path = new Path(e.pts);
      return {
        index,
        a: e.a,
        b: e.b,
        name: e.name,
        cls: e.cls,
        width: e.w,
        lanesF: e.lf,
        lanesB: e.lb,
        oneway: e.ow === 1,
        bridge: e.br === 1,
        speed: e.sp * MPH,
        pts: e.pts,
        path,
        length: polylineLength(e.pts),
        ys: e.ys && e.ys.length === path.count ? e.ys : [],
        level: e.lv ?? (e.br === 1 ? 1 : 0),
      };
    });
    for (const e of this.edges) {
      this.nodes[e.a].edges.push(e.index);
      if (e.b !== e.a) this.nodes[e.b].edges.push(e.index);
      for (let i = 0; i + 3 < e.pts.length; i += 2) this.addSeg(e.index, i / 2, e.pts[i], e.pts[i + 1], e.pts[i + 2], e.pts[i + 3]);
    }
  }

  private key(cx: number, cz: number) {
    return (cx + 2048) * 4096 + (cz + 2048);
  }

  private addSeg(edge: number, seg: number, ax: number, az: number, bx: number, bz: number) {
    const c = this.cell;
    const x0 = Math.floor(Math.min(ax, bx) / c), x1 = Math.floor(Math.max(ax, bx) / c);
    const z0 = Math.floor(Math.min(az, bz) / c), z1 = Math.floor(Math.max(az, bz) / c);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const k = this.key(x, z);
      let list = this.grid.get(k);
      if (!list) this.grid.set(k, (list = []));
      list.push(edge * 4096 + seg);
    }
  }

  /** Road surface height along an edge (deck profile on bridges, terrain otherwise). */
  heightOnEdge(edge: number, s: number) {
    const e = this.edges[edge];
    if (!e.ys.length) {
      const p = e.path.pointAt(s);
      return this.terrain.height(p.x, p.z);
    }
    const c = e.path.cum;
    let lo = 0, hi = c.length - 1;
    if (s <= 0) return e.ys[0];
    if (s >= e.length) return e.ys[hi];
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (c[m] <= s) lo = m; else hi = m;
    }
    const t = (s - c[lo]) / ((c[hi] - c[lo]) || 1);
    return e.ys[lo] + (e.ys[hi] - e.ys[lo]) * t;
  }

  degree(node: number) {
    return this.nodes[node].edges.length;
  }

  otherEnd(edge: number, node: number) {
    const e = this.edges[edge];
    return e.a === node ? e.b : e.a;
  }

  /**
   * Nearest road centerline point within maxDist meters, or null. With `y`, only
   * roads near that height count (decks above and tunnels below are skipped).
   */
  nearestEdge(x: number, z: number, maxDist = 60, filter?: (e: GEdge) => boolean, y?: number): EdgeHit | null {
    const c = this.cell;
    const r = Math.ceil(maxDist / c);
    const cx = Math.floor(x / c), cz = Math.floor(z / c);
    let best: EdgeHit | null = null;
    const seen = new Set<number>();
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const list = this.grid.get(this.key(cx + dx, cz + dz));
      if (!list) continue;
      for (const packed of list) {
        if (seen.has(packed)) continue;
        seen.add(packed);
        const ei = Math.floor(packed / 4096), si = packed % 4096;
        const e = this.edges[ei];
        if (filter && !filter(e)) continue;
        const p = e.pts;
        const r2 = distToSegment(x, z, p[si * 2], p[si * 2 + 1], p[si * 2 + 2], p[si * 2 + 3]);
        if (r2.d <= maxDist && (!best || r2.d < best.d)) {
          const segStart = e.path.cum[si] ?? 0;
          const segEnd = e.path.cum[si + 1] ?? segStart;
          if (y !== undefined && e.ys.length && Math.abs(this.heightOnEdge(ei, segStart + r2.t * (segEnd - segStart)) - y) > 5) continue;
          const h = headingOf(p[si * 2 + 2] - p[si * 2], p[si * 2 + 3] - p[si * 2 + 1]);
          const lateral = (x - r2.cx) * -Math.cos(h) + (z - r2.cz) * Math.sin(h);
          best = { edge: ei, s: segStart + r2.t * (segEnd - segStart), d: r2.d, lateral, x: r2.cx, z: r2.cz };
        }
      }
    }
    return best;
  }

  nearestNode(x: number, z: number) {
    const hit = this.nearestEdge(x, z, 400);
    if (!hit) {
      let best = 0, bd = Infinity;
      for (const n of this.nodes) {
        const d = Math.hypot(n.x - x, n.z - z);
        if (d < bd) { bd = d; best = n.index; }
      }
      return best;
    }
    const e = this.edges[hit.edge];
    return hit.s < e.length / 2 ? e.a : e.b;
  }

  canTraverse(edge: number, from: number) {
    const e = this.edges[edge];
    return !e.oneway || e.a === from;
  }

  /** A* over junctions. Returns node and edge sequences, or null if unreachable. */
  route(from: number, to: number, respectOneway = true): { nodes: number[]; edges: number[]; length: number } | null {
    if (from === to) return { nodes: [from], edges: [], length: 0 };
    const n = this.nodes.length;
    const g = new Float64Array(n).fill(Infinity);
    const prevEdge = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const goal = this.nodes[to];
    const hfn = (i: number) => Math.hypot(this.nodes[i].x - goal.x, this.nodes[i].z - goal.z);
    const open: [number, number][] = [[hfn(from), from]];
    g[from] = 0;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [, v] = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (closed[v]) continue;
      closed[v] = 1;
      if (v === to) break;
      for (const ei of this.nodes[v].edges) {
        if (respectOneway && !this.canTraverse(ei, v)) continue;
        const o = this.otherEnd(ei, v);
        const cost = g[v] + this.edges[ei].length;
        if (cost < g[o]) {
          g[o] = cost;
          prevEdge[o] = ei;
          open.push([cost + hfn(o), o]);
        }
      }
    }
    if (!Number.isFinite(g[to])) return null;
    const nodes = [to];
    const edges: number[] = [];
    let v = to;
    while (v !== from) {
      const ei = prevEdge[v];
      edges.push(ei);
      v = this.otherEnd(ei, v);
      nodes.push(v);
    }
    nodes.reverse();
    edges.reverse();
    return { nodes, edges, length: g[to] };
  }

  /** Graph distances (meters) from a node to every node, ignoring one-way rules. */
  distancesFrom(from: number, limit = Infinity) {
    const n = this.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    dist[from] = 0;
    const open: [number, number][] = [[0, from]];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [d, v] = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (d > dist[v] || d > limit) continue;
      for (const ei of this.nodes[v].edges) {
        const o = this.otherEnd(ei, v);
        const nd = d + this.edges[ei].length;
        if (nd < dist[o]) { dist[o] = nd; open.push([nd, o]); }
      }
    }
    return dist;
  }

  /** Polyline (x,z pairs) following an edge sequence that starts at `startNode`. */
  polylineFor(startNode: number, edges: number[]) {
    const out: number[] = [this.nodes[startNode].x, this.nodes[startNode].z];
    let v = startNode;
    for (const ei of edges) {
      const e = this.edges[ei];
      const p = e.pts;
      if (e.a === v) for (let i = 2; i < p.length; i += 2) out.push(p[i], p[i + 1]);
      else for (let i = p.length - 4; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
      v = this.otherEnd(ei, v);
    }
    return out;
  }

  /** Points along an edge from arc length s0 to s1 (either direction). */
  edgeSpan(edge: number, s0: number, s1: number) {
    const e = this.edges[edge];
    const out: number[] = [];
    const p0 = e.path.pointAt(s0);
    out.push(p0.x, p0.z);
    const n = e.path.count;
    if (s1 >= s0) {
      for (let i = 0; i < n; i++) if (e.path.cum[i] > s0 && e.path.cum[i] < s1) out.push(e.path.xs[i], e.path.zs[i]);
    } else {
      for (let i = n - 1; i >= 0; i--) if (e.path.cum[i] < s0 && e.path.cum[i] > s1) out.push(e.path.xs[i], e.path.zs[i]);
    }
    const p1 = e.path.pointAt(s1);
    out.push(p1.x, p1.z);
    return out;
  }

  /**
   * Drivable polyline between two arbitrary points: along the current street to
   * a junction, through the graph, then along the target street.
   */
  /**
   * Drivable path between two points: starts on the road under `a` (not the raw
   * point, so there is no kink off the centreline), follows the road graph, ends at
   * `b`. With `heading`, turning around costs extra so the route prefers the way
   * the car is already facing unless a U-turn is genuinely shorter.
   */
  pathBetween(ax: number, az: number, bx: number, bz: number, respectOneway = false, heading?: number, ay?: number, by?: number): number[] | null {
    const ha = (ay !== undefined ? this.nearestEdge(ax, az, 90, undefined, ay) : null) ?? this.nearestEdge(ax, az, 90);
    const hb = (by !== undefined ? this.nearestEdge(bx, bz, 90, undefined, by) : null) ?? this.nearestEdge(bx, bz, 90);
    if (!ha || !hb) return null;
    const A = this.edges[ha.edge], B = this.edges[hb.edge];
    const tangent = A.path.headingAt(ha.s);
    const uTurn = (towardB: boolean) => (heading === undefined ? 0 : Math.cos((towardB ? tangent : tangent + Math.PI) - heading) < 0 ? 140 : 0);
    // Same street: drive straight there (a U-turn here is the real manoeuvre).
    if (ha.edge === hb.edge && (!respectOneway || !A.oneway || hb.s >= ha.s)) {
      return [...this.edgeSpan(ha.edge, ha.s, hb.s), bx, bz];
    }
    let best: { cost: number; sa: number; eb: number; edges: number[] } | null = null;
    for (const sa of [A.a, A.b]) {
      if (respectOneway && A.oneway && sa === A.a) continue;
      const da = (sa === A.a ? ha.s : A.length - ha.s) + uTurn(sa === A.b);
      for (const eb of [B.a, B.b]) {
        if (respectOneway && B.oneway && eb === B.b) continue;
        const db = eb === B.a ? hb.s : B.length - hb.s;
        const r = this.route(sa, eb, respectOneway);
        if (!r) continue;
        const cost = da + r.length + db;
        if (!best || cost < best.cost) best = { cost, sa, eb, edges: r.edges };
      }
    }
    if (!best) return respectOneway ? this.pathBetween(ax, az, bx, bz, false, heading, ay, by) : null;
    const out = [...this.edgeSpan(ha.edge, ha.s, best.sa === A.a ? 0 : A.length)];
    const mid = this.polylineFor(best.sa, best.edges);
    out.push(...mid.slice(2));
    out.push(...this.edgeSpan(hb.edge, best.eb === B.a ? 0 : B.length, hb.s).slice(2), bx, bz);
    return out;
  }

  /** Route through OSM node waypoints in order. Throws if a leg is unreachable. */
  routeThrough(osmWaypoints: number[], respectOneway = true) {
    const idx = osmWaypoints.map((id) => {
      const i = this.nodeByOsm.get(id);
      if (i === undefined) throw new Error(`waypoint ${id} is not a junction in this district`);
      return i;
    });
    const edges: number[] = [];
    for (let k = 1; k < idx.length; k++) {
      const leg = this.route(idx[k - 1], idx[k], respectOneway);
      if (!leg) throw new Error(`no driveable leg ${osmWaypoints[k - 1]} -> ${osmWaypoints[k]}`);
      edges.push(...leg.edges);
    }
    return { startNode: idx[0], nodes: idx, edges, points: this.polylineFor(idx[0], edges) };
  }

  /**
   * Street under a point. With a heading, streets running the same way win, so
   * crossing a junction does not flash the cross street's name.
   */
  streetNameAt(x: number, z: number, heading?: number, y?: number) {
    if (heading !== undefined) {
      const aligned = this.nearestEdge(x, z, 18, (e) => {
        if (!e.name) return false;
        const pr = e.path.project(x, z);
        return Math.abs(Math.cos(e.path.headingAt(pr.s) - heading)) > 0.75;
      }, y);
      if (aligned && aligned.d <= this.edges[aligned.edge].width / 2 + 6) return this.edges[aligned.edge].name;
    }
    const hit = this.nearestEdge(x, z, 22, (e) => e.name !== '', y);
    if (!hit) return '';
    const e = this.edges[hit.edge];
    return hit.d <= e.width / 2 + 6 ? e.name : '';
  }
}

/** Terrain heights shipped as base64 Uint16 (little-endian) inside JSON. */
export function decodeTerrain(t: { format: string; data: string }): ArrayBuffer {
  if (t.format !== 'u16le-base64') throw new Error(`unknown terrain format ${t.format}`);
  const bin = atob(t.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function loadDistrict(url: string): Promise<District> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`district ${url}: HTTP ${res.status}`);
  const data = (await res.json()) as DistrictData;
  let terrain = Terrain.flat();
  if (data.terrain) {
    const tr = await fetch(new URL(data.terrain.file, url).href);
    if (!tr.ok) throw new Error(`terrain ${data.terrain.file}: HTTP ${tr.status}`);
    terrain = Terrain.fromBuffer(data.terrain, data.terrain.file.endsWith('.json') ? decodeTerrain(await tr.json()) : await tr.arrayBuffer());
  }
  const d = new District(data, terrain);
  if (data.surface && data.terrain) {
    const sr = await fetch(new URL(data.surface.file, url).href);
    if (!sr.ok) throw new Error(`surface ${data.surface.file}: HTTP ${sr.status}`);
    d.surface = Terrain.fromBuffer(data.terrain, decodeTerrain(await sr.json()));
  }
  return d;
}
