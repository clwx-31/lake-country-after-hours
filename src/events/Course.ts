// A course is a route through real junctions (OSM node IDs) resolved on the
// same road graph as everything else, plus a version hash for ghosts.
import { Path, wrapAngle } from '../core/math';
import { hash32 } from '../core/rng';
import type { District } from '../map/District';

export const COURSE_REV = 4;

export class Course {
  readonly path: Path;
  readonly edges: number[];
  readonly nodes: number[]; // waypoint node indices
  readonly version: string;
  readonly nodeS: number[]; // arc length of each waypoint along the path

  constructor(readonly d: District, readonly id: string, readonly waypoints: number[], extraKey = '') {
    const r = d.routeThrough(waypoints, true);
    this.path = new Path(r.points);
    this.edges = r.edges;
    this.nodes = r.nodes;
    const nodeS: number[] = [];
    for (const n of r.nodes) nodeS.push(this.path.project(d.nodes[n].x, d.nodes[n].z).s);
    // Waypoint arc lengths are monotonic along the route.
    for (let i = 1; i < nodeS.length; i++) if (nodeS[i] < nodeS[i - 1]) nodeS[i] = i === nodeS.length - 1 ? this.path.length : nodeS[i - 1];
    if (waypoints[0] === waypoints[waypoints.length - 1]) nodeS[nodeS.length - 1] = this.path.length;
    this.nodeS = nodeS;
    let key = `${id}|${COURSE_REV}|${extraKey}|`;
    for (let i = 0; i < r.points.length; i += 2) key += `${Math.round(r.points[i])},${Math.round(r.points[i + 1])};`;
    this.version = hash32(key).toString(36);
  }

  get length() {
    return this.path.length;
  }

  /** Width of the road at arc length s. */
  widthAt(s: number) {
    const p = this.path.pointAt(s);
    const hit = this.d.nearestEdge(p.x, p.z, 10);
    return hit ? this.d.edges[hit.edge].width : 10;
  }

  /** Corners: arc lengths where the route turns sharply. */
  corners(minTurn = 0.45, window = 12) {
    const out: { s: number; turn: number }[] = [];
    for (let s = window; s < this.path.length - window; s += 2) {
      const turn = wrapAngle(this.path.headingAt(s + window) - this.path.headingAt(s - window));
      if (Math.abs(turn) < minTurn) continue;
      const last = out[out.length - 1];
      if (last && s - last.s < 30) {
        if (Math.abs(turn) > Math.abs(last.turn)) { last.s = s; last.turn = turn; }
      } else out.push({ s, turn });
    }
    return out;
  }

  /** Pose on the route at s, offset to the right by `lateral` meters. */
  pose(s: number, lateral = 0) {
    const p = this.path.pointAt(s);
    const h = this.path.headingAt(Math.min(this.path.length, s + 0.5));
    return { x: p.x - Math.cos(h) * lateral, z: p.z + Math.sin(h) * lateral, h };
  }

  /** Points of a copy of the route offset sideways (e.g. the rival's lane). */
  offsetPoints(lateral: number) {
    const out: number[] = [];
    for (let i = 0; i < this.path.count; i++) {
      const s = this.path.cum[i];
      const h = this.path.headingAt(Math.min(this.path.length - 0.01, s + 0.01));
      out.push(this.path.xs[i] - Math.cos(h) * lateral, this.path.zs[i] + Math.sin(h) * lateral);
    }
    return out;
  }
}
