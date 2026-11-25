// Road surface layout: trimmed edge strips that meet watertight junction polygons.
// Pure geometry (no three.js) so tests can validate holes, overlaps, and curbs.
import { Path, clamp, lineIntersect, pointInPolygon } from '../core/math';
import type { District } from './District';

export interface Strip {
  edge: number;
  s0: number;
  s1: number;
  /** Left and right boundary points (x,z pairs) from s0 to s1, in a->b travel order. */
  left: number[];
  right: number[];
  center: number[];
}

export interface Junction {
  node: number;
  /** Closed polygon ring (x,z pairs). */
  poly: number[];
  /** Polylines along the ring that are true road edges (not openings to strips). */
  edgesOut: number[][];
  kind: 'junction' | 'deadend' | 'turnaround';
}

export interface RoadLayer {
  extra: Extra;
  trims: Float64Array; // [trimA, trimB] per edge
  strips: Strip[];
  junctions: Junction[];
}

export type Extra = number | ((edge: number) => number);
const halfWidth = (d: District, edge: number, extra: Extra) => d.edges[edge].width / 2 + (typeof extra === 'number' ? extra : extra(edge));

interface Arm {
  edge: number;
  atA: boolean;
  ux: number;
  uz: number;
  angle: number;
  hw: number;
  len: number;
}

function armsAt(d: District, node: number, extra: Extra): Arm[] {
  const arms: Arm[] = [];
  for (const ei of d.nodes[node].edges) {
    const e = d.edges[ei];
    const ends: boolean[] = [];
    if (e.a === node) ends.push(true);
    if (e.b === node) ends.push(false);
    for (const atA of ends) {
      const probe = Math.min(8, e.length / 2);
      const p = e.path.pointAt(atA ? probe : e.length - probe);
      let ux = p.x - d.nodes[node].x, uz = p.z - d.nodes[node].z;
      const l = Math.hypot(ux, uz) || 1;
      ux /= l; uz /= l;
      arms.push({ edge: ei, atA, ux, uz, angle: Math.atan2(uz, ux), hw: halfWidth(d, ei, extra), len: e.length });
    }
  }
  arms.sort((p, q) => p.angle - q.angle);
  return arms;
}

/** Offset a polyline sideways with mitred joins. Positive offset = right of travel. */
export function offsetPolyline(pts: number[], offset: number): number[] {
  const n = pts.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    let nx = 0, nz = 0;
    const addSeg = (ax: number, az: number, bx: number, bz: number) => {
      const dx = bx - ax, dz = bz - az;
      const l = Math.hypot(dx, dz) || 1;
      nx += -dz / l;
      nz += dx / l;
    };
    if (i > 0) addSeg(pts[i * 2 - 2], pts[i * 2 - 1], x, z);
    if (i < n - 1) addSeg(x, z, pts[i * 2 + 2], pts[i * 2 + 3]);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    // Miter scale: 1 / cos(half the turn angle), capped to avoid spikes.
    let scale = 1;
    if (i > 0 && i < n - 1) {
      const ax = x - pts[i * 2 - 2], az = z - pts[i * 2 - 1];
      const al = Math.hypot(ax, az) || 1;
      const segNx = -az / al, segNz = ax / al;
      scale = 1 / clamp(nx * segNx + nz * segNz, 0.5, 1);
    }
    out.push(x + nx * offset * scale, z + nz * offset * scale);
  }
  return out;
}

function subPath(path: Path, s0: number, s1: number): number[] {
  const out: number[] = [];
  const p0 = path.pointAt(s0);
  out.push(p0.x, p0.z);
  for (let i = 1; i < path.count - 1; i++) {
    const s = path.cum[i];
    if (s > s0 + 0.05 && s < s1 - 0.05) out.push(path.xs[i], path.zs[i]);
  }
  const p1 = path.pointAt(s1);
  out.push(p1.x, p1.z);
  return out;
}

export function buildRoadLayer(d: District, extra: Extra): RoadLayer {
  const E = d.edges.length;
  const trims = new Float64Array(E * 2);
  const cornerRadius = 2.5 + (typeof extra === 'number' ? extra : 0) * 0.5;
  // Corner intersection points per node, keyed by arm order, reused for fillets.
  const corners = new Map<number, ({ x: number; z: number } | null)[]>();

  for (const node of d.nodes) {
    const arms = armsAt(d, node.index, extra);
    if (arms.length < 2) continue;
    const need = arms.map(() => 0.5);
    const cps: ({ x: number; z: number } | null)[] = [];
    for (let i = 0; i < arms.length; i++) {
      const A = arms[i], B = arms[(i + 1) % arms.length];
      let gap = B.angle - A.angle;
      if (gap <= 0) gap += Math.PI * 2;
      // Side of A facing B is +n (rotate +90 in angle space); side of B facing A is -n.
      const anx = -A.uz, anz = A.ux, bnx = -B.uz, bnz = B.ux;
      let cp: { x: number; z: number } | null = null;
      if (gap < Math.PI - 0.12 && arms.length > 1) {
        const hit = lineIntersect(
          node.x + anx * A.hw, node.z + anz * A.hw, A.ux, A.uz,
          node.x - bnx * B.hw, node.z - bnz * B.hw, B.ux, B.uz,
        );
        if (hit && hit.t > -1 && hit.s > -1 && hit.t < 45 && hit.s < 45) {
          need[i] = Math.max(need[i], hit.t + cornerRadius);
          need[(i + 1) % arms.length] = Math.max(need[(i + 1) % arms.length], hit.s + cornerRadius);
          cp = { x: node.x + A.ux * hit.t + anx * A.hw, z: node.z + A.uz * hit.t + anz * A.hw };
        }
      }
      cps.push(cp);
    }
    corners.set(node.index, cps);
    arms.forEach((arm, i) => {
      const slot = arm.edge * 2 + (arm.atA ? 0 : 1);
      trims[slot] = Math.max(trims[slot], need[i]);
    });
  }
  // Keep both trims of an edge inside its length.
  for (let ei = 0; ei < E; ei++) {
    const len = d.edges[ei].length;
    const sum = trims[ei * 2] + trims[ei * 2 + 1];
    const max = Math.max(0.2, len - 0.4);
    if (sum > max) {
      const k = max / sum;
      trims[ei * 2] *= k;
      trims[ei * 2 + 1] *= k;
    }
  }

  const strips: Strip[] = d.edges.map((e) => {
    const s0 = trims[e.index * 2], s1 = e.length - trims[e.index * 2 + 1];
    const center = subPath(e.path, s0, s1);
    const hw = halfWidth(d, e.index, extra);
    return { edge: e.index, s0, s1, center, left: offsetPolyline(center, -hw), right: offsetPolyline(center, hw) };
  });

  const junctions: Junction[] = [];
  for (const node of d.nodes) {
    const arms = armsAt(d, node.index, extra);
    if (arms.length === 0) continue;
    if (arms.length === 1) {
      // Dead end or district edge: round cap, or a wider turnaround pad at the boundary.
      const a = arms[0];
      const boundary = node.boundary;
      const r = boundary ? Math.max(a.hw + 4, 11 + (a.hw - d.edges[a.edge].width / 2)) : a.hw;
      const cx = node.x + (boundary ? a.ux * (r * 0.75) : 0);
      const cz = node.z + (boundary ? a.uz * (r * 0.75) : 0);
      const poly: number[] = [];
      const seg = 20;
      for (let k = 0; k < seg; k++) {
        const t = (k / seg) * Math.PI * 2;
        poly.push(cx + Math.cos(t) * r, cz + Math.sin(t) * r);
      }
      junctions.push({ node: node.index, poly, edgesOut: [poly.concat(poly.slice(0, 2))], kind: boundary ? 'turnaround' : 'deadend' });
      continue;
    }
    const cps = corners.get(node.index) ?? [];
    const ring: number[] = [];
    const outs: number[][] = [];
    const endPts = arms.map((arm) => {
      const st = strips[arm.edge];
      const L = st.left, R = st.right, n = L.length;
      // Plus side (right of travel away from the node) and minus side.
      if (arm.atA) return { minus: [L[0], L[1]], plus: [R[0], R[1]] };
      return { minus: [R[n - 2], R[n - 1]], plus: [L[n - 2], L[n - 1]] };
    });
    for (let i = 0; i < arms.length; i++) {
      const cur = endPts[i], next = endPts[(i + 1) % arms.length];
      ring.push(cur.minus[0], cur.minus[1], cur.plus[0], cur.plus[1]);
      const cp = cps[i];
      const side: number[] = [cur.plus[0], cur.plus[1]];
      if (cp) {
        const steps = 6;
        for (let k = 1; k < steps; k++) {
          const t = k / steps, u = 1 - t;
          const x = u * u * cur.plus[0] + 2 * u * t * cp.x + t * t * next.minus[0];
          const z = u * u * cur.plus[1] + 2 * u * t * cp.z + t * t * next.minus[1];
          ring.push(x, z);
          side.push(x, z);
        }
      }
      side.push(next.minus[0], next.minus[1]);
      outs.push(side);
    }
    junctions.push({ node: node.index, poly: ring, edgesOut: outs, kind: 'junction' });
  }
  return { extra, trims, strips, junctions };
}

export function stripPolygon(s: Strip): number[] {
  const out = s.left.slice();
  for (let i = s.right.length - 2; i >= 0; i -= 2) out.push(s.right[i], s.right[i + 1]);
  return out;
}

/** Spatial index of surface polygons for point queries (on asphalt? which surface?). */
export class PolygonIndex {
  private cells = new Map<number, number[]>();
  readonly polys: { poly: number[]; tag: number }[] = [];
  private bbox: number[] = [];
  constructor(private cell = 16) {}

  add(poly: number[], tag: number) {
    const id = this.polys.length;
    this.polys.push({ poly, tag });
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]);
      z0 = Math.min(z0, poly[i + 1]); z1 = Math.max(z1, poly[i + 1]);
    }
    this.bbox.push(x0, z0, x1, z1);
    const c = this.cell;
    for (let x = Math.floor(x0 / c); x <= Math.floor(x1 / c); x++) {
      for (let z = Math.floor(z0 / c); z <= Math.floor(z1 / c); z++) {
        const k = (x + 4096) * 8192 + (z + 4096);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(id);
      }
    }
  }

  /** Call `fn` with every polygon containing the point. */
  queryAll(x: number, z: number, fn: (id: number) => void) {
    const c = this.cell;
    const list = this.cells.get((Math.floor(x / c) + 4096) * 8192 + (Math.floor(z / c) + 4096));
    if (!list) return;
    for (const id of list) {
      const b = id * 4;
      if (x < this.bbox[b] || z < this.bbox[b + 1] || x > this.bbox[b + 2] || z > this.bbox[b + 3]) continue;
      if (pointInPolygon(x, z, this.polys[id].poly)) fn(id);
    }
  }

  /** Index of the first polygon containing the point (optionally skipping one), or -1. */
  query(x: number, z: number, skip = -1, tagFilter = -1): number {
    const c = this.cell;
    const list = this.cells.get((Math.floor(x / c) + 4096) * 8192 + (Math.floor(z / c) + 4096));
    if (!list) return -1;
    for (const id of list) {
      if (id === skip) continue;
      const p = this.polys[id];
      if (tagFilter >= 0 && p.tag !== tagFilter) continue;
      const b = id * 4;
      if (x < this.bbox[b] || z < this.bbox[b + 1] || x > this.bbox[b + 2] || z > this.bbox[b + 3]) continue;
      if (pointInPolygon(x, z, p.poly)) return id;
    }
    return -1;
  }
}

export function layerIndex(layer: RoadLayer): { index: PolygonIndex; stripIds: number[]; junctionIds: number[] } {
  const index = new PolygonIndex();
  const stripIds = layer.strips.map((s) => {
    index.add(stripPolygon(s), 0);
    return index.polys.length - 1;
  });
  const junctionIds = layer.junctions.map((j) => {
    index.add(j.poly, 1);
    return index.polys.length - 1;
  });
  return { index, stripIds, junctionIds };
}

/**
 * Curb polylines along true road edges (outward side = right of travel). A curb piece is dropped when the ground
 * just outside it is still asphalt (inside another strip or junction), so curbs
 * never run through the middle of a crossing or across a merge.
 */
export function buildCurbs(d: District, layer: RoadLayer, idx: ReturnType<typeof layerIndex>) {
  const curbs: number[][] = [];
  const emit = (pts: number[], outwardSign: number, owner: number) => {
    let cur: number[] = [];
    const flush = () => {
      if (cur.length >= 4) {
        // Normalise so the outward side is always to the right of travel.
        if (outwardSign < 0) {
          const rev: number[] = [];
          for (let i = cur.length - 2; i >= 0; i -= 2) rev.push(cur[i], cur[i + 1]);
          cur = rev;
        }
        curbs.push(cur);
      }
      cur = [];
    };
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
      const len = Math.hypot(bx - ax, bz - az);
      const pieces = Math.max(1, Math.ceil(len / 1.5));
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces, t1 = (k + 1) / pieces;
        const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0;
        const x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        const dx = (x1 - x0) / (len / pieces || 1), dz = (z1 - z0) / (len / pieces || 1);
        // Outward normal: right of travel times sign.
        const ox = -dz * outwardSign, oz = dx * outwardSign;
        const probe = idx.index.query(mx + ox * 0.8, mz + oz * 0.8, owner);
        if (probe >= 0) { flush(); continue; }
        if (!cur.length) cur.push(x0, z0);
        cur.push(x1, z1);
      }
    }
    flush();
  };
  layer.strips.forEach((s, i) => {
    if (d.edges[s.edge].bridge) return; // bridges get parapets instead
    emit(s.left, -1, idx.stripIds[i]);
    emit(s.right, 1, idx.stripIds[i]);
  });
  layer.junctions.forEach((j, i) => {
    // Junction ring is ordered by increasing angle around the node; outward is to the left of travel... computed per ring orientation.
    let area = 0;
    for (let k = 0; k < j.poly.length; k += 2) {
      const n = (k + 2) % j.poly.length;
      area += j.poly[k] * j.poly[n + 1] - j.poly[n] * j.poly[k + 1];
    }
    const sign = area > 0 ? -1 : 1;
    for (const side of j.edgesOut) emit(side, sign, idx.junctionIds[i]);
  });
  return curbs;
}
