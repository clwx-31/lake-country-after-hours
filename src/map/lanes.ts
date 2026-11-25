// Right-hand traffic lanes and junction connections derived from the road graph
// and the same trimmed strips the road meshes use.
import { Path, wrapAngle } from '../core/math';
import type { District } from './District';
import { offsetPolyline, type RoadLayer } from './roadGeometry';

export interface Lane {
  id: number;
  edge: number;
  forward: boolean; // travels a->b
  index: number; // 0 = curb side
  from: number; // node at start
  to: number; // node at end
  path: Path;
  speed: number;
  outs: number[]; // connection ids
}

export interface Conn {
  id: number;
  node: number;
  fromLane: number;
  toLane: number;
  path: Path;
  turn: 'straight' | 'left' | 'right' | 'uturn';
}

export class LaneGraph {
  readonly lanes: Lane[] = [];
  readonly conns: Conn[] = [];
  readonly lanesByEdge: number[][] = [];
  private conflictCache = new Map<number, boolean>();

  constructor(readonly d: District, layer: RoadLayer) {
    for (const e of d.edges) {
      const strip = layer.strips[e.index];
      const list: number[] = [];
      this.lanesByEdge.push(list);
      if (strip.s1 - strip.s0 < 1) continue;
      const hw = e.width / 2;
      const center = strip.center;
      const make = (forward: boolean, count: number) => {
        for (let i = 0; i < count; i++) {
          let off: number;
          if (e.oneway) {
            const lw = e.width / count;
            off = hw - lw * (i + 0.5);
          } else {
            const usable = hw - (e.cls === 'residential' ? 2.2 : 0.6);
            const lw = Math.min(3.4, usable / count);
            off = lw * (count - 1 - i + 0.5);
          }
          let pts = center;
          if (!forward) {
            pts = [];
            for (let k = center.length - 2; k >= 0; k -= 2) pts.push(center[k], center[k + 1]);
          }
          const lanePts = offsetPolyline(pts, off);
          const lane: Lane = {
            id: this.lanes.length, edge: e.index, forward, index: i,
            from: forward ? e.a : e.b, to: forward ? e.b : e.a,
            path: new Path(lanePts), speed: e.speed, outs: [],
          };
          this.lanes.push(lane);
          list.push(lane.id);
        }
      };
      make(true, Math.max(1, e.lanesF));
      if (!e.oneway) make(false, Math.max(1, e.lanesB));
    }
    // Connections at each junction.
    const incoming = new Map<number, number[]>();
    const outgoing = new Map<number, number[]>();
    for (const l of this.lanes) {
      if (!incoming.has(l.to)) incoming.set(l.to, []);
      incoming.get(l.to)!.push(l.id);
      if (!outgoing.has(l.from)) outgoing.set(l.from, []);
      outgoing.get(l.from)!.push(l.id);
    }
    for (const [node, ins] of incoming) {
      const outs = outgoing.get(node) ?? [];
      const deadEnd = d.nodes[node].edges.length === 1;
      for (const li of ins) {
        const L = this.lanes[li];
        for (const oi of outs) {
          const O = this.lanes[oi];
          const sameEdge = O.edge === L.edge;
          if (sameEdge && !deadEnd) continue;
          // Keep lane discipline: map by curb-side index.
          const outCount = this.lanesByEdge[O.edge].filter((id) => this.lanes[id].forward === O.forward).length;
          if (O.index !== Math.min(L.index, outCount - 1)) continue;
          const p0 = L.path.pointAt(L.path.length), h0 = L.path.headingAt(L.path.length);
          const p3 = O.path.pointAt(0), h1 = O.path.headingAt(0);
          const dist = Math.hypot(p3.x - p0.x, p3.z - p0.z);
          const k = Math.max(1.5, dist * 0.42);
          const pts: number[] = [];
          for (let s = 0; s <= 10; s++) {
            const t = s / 10, u = 1 - t;
            const p1x = p0.x + Math.sin(h0) * k, p1z = p0.z + Math.cos(h0) * k;
            const p2x = p3.x - Math.sin(h1) * k, p2z = p3.z - Math.cos(h1) * k;
            pts.push(
              u * u * u * p0.x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3.x,
              u * u * u * p0.z + 3 * u * u * t * p1z + 3 * u * t * t * p2z + t * t * t * p3.z,
            );
          }
          const dh = wrapAngle(h1 - h0);
          const turn = Math.abs(dh) > 2.6 ? 'uturn' : dh > 0.5 ? 'left' : dh < -0.5 ? 'right' : 'straight';
          const c: Conn = { id: this.conns.length, node, fromLane: li, toLane: oi, path: new Path(pts), turn };
          this.conns.push(c);
          L.outs.push(c.id);
        }
      }
    }
  }

  /** Do two connections through the same junction cross or come too close? */
  conflicts(a: number, b: number) {
    if (a === b) return false;
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    const hit = this.conflictCache.get(key);
    if (hit !== undefined) return hit;
    const A = this.conns[a], B = this.conns[b];
    let res = false;
    if (A.fromLane !== B.fromLane) {
      const pa = { x: 0, z: 0 }, pb = { x: 0, z: 0 };
      outer: for (let i = 0; i <= 8; i++) {
        A.path.pointAt((A.path.length * i) / 8, pa);
        for (let j = 0; j <= 8; j++) {
          B.path.pointAt((B.path.length * j) / 8, pb);
          if (Math.hypot(pa.x - pb.x, pa.z - pb.z) < 2.6) { res = true; break outer; }
        }
      }
      if (A.toLane === B.toLane) res = true;
    }
    this.conflictCache.set(key, res);
    return res;
  }

  /** Nearest lane matching a heading (for spawning and recovery). */
  laneAt(x: number, z: number, heading: number) {
    const hit = this.d.nearestEdge(x, z, 40);
    if (!hit) return null;
    let best = -1, bestScore = Infinity;
    for (const id of this.lanesByEdge[hit.edge]) {
      const L = this.lanes[id];
      const pr = L.path.project(x, z);
      const h = L.path.headingAt(pr.s);
      const score = pr.d + Math.abs(wrapAngle(h - heading)) * 6;
      if (score < bestScore) { bestScore = score; best = id; }
    }
    return best >= 0 ? best : null;
  }
}

