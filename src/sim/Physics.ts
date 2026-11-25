// Contact resolution for cars: each car is three circles along its length;
// the world is static segments (walls, banks, rails) and circles (trees, posts).
import { clamp } from '../core/math';

export type StaticTag = 'building' | 'water' | 'rail' | 'barrier' | 'parked' | 'tree' | 'boundary' | 'obstacle' | 'post';

export interface PhysBody {
  id: number;
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  w: number;
  y: number;
  mass: number;
  inertia: number;
  halfLength: number;
  halfWidth: number;
  /** Bodies that should not respond (e.g. ghosts) set this false. */
  solid: boolean;
}

export interface Contact {
  a: PhysBody;
  b: PhysBody | null;
  tag: StaticTag | 'car';
  impulse: number;
  /** Velocity change of `a` along the normal, m/s. */
  dv: number;
  x: number;
  z: number;
  nx: number;
  nz: number;
}

interface Seg { ax: number; az: number; bx: number; bz: number; tag: StaticTag; y0: number; y1: number }
interface Circ { x: number; z: number; r: number; tag: StaticTag; y0: number; y1: number }

const CELL = 16;
const key = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

export class StaticWorld {
  readonly segs: Seg[] = [];
  readonly circs: Circ[] = [];
  private segCells = new Map<number, number[]>();
  private circCells = new Map<number, number[]>();
  /** Segments can be disabled (e.g. roadblocks that are torn down). */
  readonly disabled = new Set<number>();
  /** Circles can be disabled too (posted patrol cars that pull out). */
  readonly disabledCircles = new Set<number>();

  /** A wall from height y0 to y1 (absolute). Cars only hit it where their body overlaps. */
  addSegment(ax: number, az: number, bx: number, bz: number, tag: StaticTag, y0 = -1e9, y1 = 1e9) {
    const id = this.segs.length;
    this.segs.push({ ax, az, bx, bz, tag, y0, y1 });
    const x0 = Math.floor(Math.min(ax, bx) / CELL), x1 = Math.floor(Math.max(ax, bx) / CELL);
    const z0 = Math.floor(Math.min(az, bz) / CELL), z1 = Math.floor(Math.max(az, bz) / CELL);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const k = key(x, z);
      let l = this.segCells.get(k);
      if (!l) this.segCells.set(k, (l = []));
      l.push(id);
    }
    return id;
  }

  addPolyline(pts: ArrayLike<number>, tag: StaticTag, closed = false, y0 = -1e9, y1 = 1e9) {
    const ids: number[] = [];
    const n = pts.length / 2;
    for (let i = 0; i < n - 1; i++) ids.push(this.addSegment(pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3], tag, y0, y1));
    if (closed && n > 2) ids.push(this.addSegment(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1], pts[0], pts[1], tag, y0, y1));
    return ids;
  }

  addCircle(x: number, z: number, r: number, tag: StaticTag, y0 = -1e9, y1 = 1e9) {
    const id = this.circs.length;
    this.circs.push({ x, z, r, tag, y0, y1 });
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let l = this.circCells.get(k);
    if (!l) this.circCells.set(k, (l = []));
    l.push(id);
    return id;
  }

  segmentsNear(x: number, z: number, r: number, out: number[]) {
    out.length = 0;
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const l = this.segCells.get(key(cx, cz));
      if (l) for (const id of l) if (!this.disabled.has(id)) out.push(id);
    }
    return out;
  }

  circlesNear(x: number, z: number, r: number, out: number[]) {
    out.length = 0;
    const x0 = Math.floor((x - r - 2) / CELL), x1 = Math.floor((x + r + 2) / CELL);
    const z0 = Math.floor((z - r - 2) / CELL), z1 = Math.floor((z + r + 2) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const l = this.circCells.get(key(cx, cz));
      if (l) for (const id of l) if (!this.disabledCircles.has(id)) out.push(id);
    }
    return out;
  }

  /**
   * First hit distance along a ray against segments with matching tags (grid DDA),
   * or Infinity. Used for camera retraction and police line of sight.
   */
  raycast(ox: number, oz: number, dx: number, dz: number, maxDist: number, tags?: Set<StaticTag>, y?: number) {
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    let cx = Math.floor(ox / CELL), cz = Math.floor(oz / CELL);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(CELL / (dx || 1e-9)), tDeltaZ = Math.abs(CELL / (dz || 1e-9));
    let tMaxX = dx !== 0 ? ((dx > 0 ? (cx + 1) * CELL - ox : ox - cx * CELL) / Math.abs(dx)) : Infinity;
    let tMaxZ = dz !== 0 ? ((dz > 0 ? (cz + 1) * CELL - oz : oz - cz * CELL) / Math.abs(dz)) : Infinity;
    let best = Infinity;
    const checked = new Set<number>();
    let t = 0;
    while (t <= maxDist) {
      const l = this.segCells.get(key(cx, cz));
      if (l) {
        for (const id of l) {
          if (checked.has(id) || this.disabled.has(id)) continue;
          checked.add(id);
          const s = this.segs[id];
          if (tags && !tags.has(s.tag)) continue;
          // Height band: only walls that exist at this height (decks, underpasses).
          if (y !== undefined && (y < s.y0 || y > s.y1)) continue;
          const ex = s.bx - s.ax, ez = s.bz - s.az;
          const den = dx * ez - dz * ex;
          if (Math.abs(den) < 1e-9) continue;
          const tt = ((s.ax - ox) * ez - (s.az - oz) * ex) / den;
          const u = ((s.ax - ox) * dz - (s.az - oz) * dx) / den;
          if (tt >= 0 && tt <= maxDist && u >= 0 && u <= 1 && tt < best) best = tt;
        }
      }
      if (best <= Math.min(tMaxX, tMaxZ)) return best;
      if (tMaxX < tMaxZ) { t = tMaxX; tMaxX += tDeltaX; cx += stepX; } else { t = tMaxZ; tMaxZ += tDeltaZ; cz += stepZ; }
    }
    return best;
  }
}

const scratch: number[] = [];
const scratchC: number[] = [];

function circleCenters(b: PhysBody, out: number[]) {
  const fx = Math.sin(b.h), fz = Math.cos(b.h);
  const off = Math.max(0, b.halfLength - b.halfWidth);
  out[0] = b.x - fx * off; out[1] = b.z - fz * off;
  out[2] = b.x; out[3] = b.z;
  out[4] = b.x + fx * off; out[5] = b.z + fz * off;
}

function applyImpulse(b: PhysBody, jx: number, jz: number, dx: number, dz: number) {
  b.vx += jx / b.mass;
  b.vz += jz / b.mass;
  b.w += (dz * jx - dx * jz) / b.inertia;
  b.w = clamp(b.w, -5, 5);
}

const centers = [0, 0, 0, 0, 0, 0];
const centersB = [0, 0, 0, 0, 0, 0];

/** Resolve one body against static geometry. Returns contacts. */
export function collideStatic(world: StaticWorld, b: PhysBody, contacts: Contact[]) {
  if (!b.solid) return;
  const r = b.halfWidth * 1.02;
  circleCenters(b, centers);
  const reach = b.halfLength + 1;
  world.segmentsNear(b.x, b.z, reach, scratch);
  world.circlesNear(b.x, b.z, reach, scratchC);
  let best: { depth: number; nx: number; nz: number; px: number; pz: number; tag: StaticTag } | null = null;
  for (let c = 0; c < 3; c++) {
    const cx = centers[c * 2], cz = centers[c * 2 + 1];
    for (const id of scratch) {
      const s = world.segs[id];
      if (b.y + 1.4 < s.y0 || b.y > s.y1 - 0.05) continue;
      const ex = s.bx - s.ax, ez = s.bz - s.az;
      const l2 = ex * ex + ez * ez || 1e-9;
      const t = clamp(((cx - s.ax) * ex + (cz - s.az) * ez) / l2, 0, 1);
      const qx = s.ax + ex * t, qz = s.az + ez * t;
      let nx = cx - qx, nz = cz - qz;
      const d = Math.hypot(nx, nz);
      if (d >= r) continue;
      if (d < 1e-6) { const l = Math.sqrt(l2); nx = -ez / l; nz = ex / l; } else { nx /= d; nz /= d; }
      const depth = r - d;
      if (!best || depth > best.depth) best = { depth, nx, nz, px: qx, pz: qz, tag: s.tag };
    }
    for (const id of scratchC) {
      const k = world.circs[id];
      if (b.y + 1.4 < k.y0 || b.y > k.y1) continue;
      const dx = cx - k.x, dz = cz - k.z;
      const d = Math.hypot(dx, dz);
      const rr = r + k.r;
      if (d >= rr || d < 1e-6) continue;
      const depth = rr - d;
      if (!best || depth > best.depth) best = { depth, nx: dx / d, nz: dz / d, px: k.x + (dx / d) * k.r, pz: k.z + (dz / d) * k.r, tag: k.tag };
    }
  }
  if (!best) return;
  const { nx, nz, depth } = best;
  b.x += nx * depth;
  b.z += nz * depth;
  const dx = best.px - b.x, dz = best.pz - b.z;
  const vpx = b.vx + b.w * dz, vpz = b.vz - b.w * dx;
  const vn = vpx * nx + vpz * nz;
  if (vn >= 0) return;
  const e = best.tag === 'tree' || best.tag === 'post' ? 0.1 : 0.18;
  const rn = dz * nx - dx * nz;
  const j = (-(1 + e) * vn) / (1 / b.mass + (rn * rn) / b.inertia);
  applyImpulse(b, j * nx, j * nz, dx, dz);
  // Friction scrub along the wall.
  const tx = -nz, tz = nx;
  const vpx2 = b.vx + b.w * dz, vpz2 = b.vz - b.w * dx;
  const vt = vpx2 * tx + vpz2 * tz;
  const rt = dz * tx - dx * tz;
  let jt = -vt / (1 / b.mass + (rt * rt) / b.inertia);
  const mu = best.tag === 'boundary' ? 0.05 : 0.45;
  jt = clamp(jt, -mu * j, mu * j);
  applyImpulse(b, jt * tx, jt * tz, dx, dz);
  contacts.push({ a: b, b: null, tag: best.tag, impulse: j, dv: j / b.mass, x: best.px, z: best.pz, nx, nz });
}

/** Resolve a pair of car bodies. */
export function collidePair(a: PhysBody, b: PhysBody, contacts: Contact[]) {
  if (!a.solid || !b.solid) return;
  if (Math.abs(a.y - b.y) > 1.0) return;
  const reach = a.halfLength + b.halfLength;
  const ddx = b.x - a.x, ddz = b.z - a.z;
  if (ddx * ddx + ddz * ddz > reach * reach) return;
  circleCenters(a, centers);
  circleCenters(b, centersB);
  const ra = a.halfWidth * 1.02, rb = b.halfWidth * 1.02;
  let best: { depth: number; nx: number; nz: number; px: number; pz: number } | null = null;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) {
    const dx = centers[i * 2] - centersB[k * 2], dz = centers[i * 2 + 1] - centersB[k * 2 + 1];
    const d = Math.hypot(dx, dz);
    if (d >= ra + rb || d < 1e-6) continue;
    const depth = ra + rb - d;
    if (!best || depth > best.depth) {
      const nx = dx / d, nz = dz / d; // from b to a
      best = { depth, nx, nz, px: centersB[k * 2] + nx * rb, pz: centersB[k * 2 + 1] + nz * rb };
    }
  }
  if (!best) return;
  const { nx, nz, depth } = best;
  const ima = 1 / a.mass, imb = 1 / b.mass;
  a.x += nx * depth * (ima / (ima + imb));
  a.z += nz * depth * (ima / (ima + imb));
  b.x -= nx * depth * (imb / (ima + imb));
  b.z -= nz * depth * (imb / (ima + imb));
  const dax = best.px - a.x, daz = best.pz - a.z;
  const dbx = best.px - b.x, dbz = best.pz - b.z;
  const vax = a.vx + a.w * daz, vaz = a.vz - a.w * dax;
  const vbx = b.vx + b.w * dbz, vbz = b.vz - b.w * dbx;
  const vn = (vax - vbx) * nx + (vaz - vbz) * nz;
  if (vn >= 0) return;
  const rna = daz * nx - dax * nz, rnb = dbz * nx - dbx * nz;
  const k = ima + imb + (rna * rna) / a.inertia + (rnb * rnb) / b.inertia;
  const j = (-(1 + 0.22) * vn) / k;
  applyImpulse(a, j * nx, j * nz, dax, daz);
  applyImpulse(b, -j * nx, -j * nz, dbx, dbz);
  const tx = -nz, tz = nx;
  const vt = ((a.vx + a.w * daz) - (b.vx + b.w * dbz)) * tx + ((a.vz - a.w * dax) - (b.vz - b.w * dbx)) * tz;
  const rta = daz * tx - dax * tz, rtb = dbz * tx - dbx * tz;
  let jt = -vt / (ima + imb + (rta * rta) / a.inertia + (rtb * rtb) / b.inertia);
  jt = clamp(jt, -0.35 * j, 0.35 * j);
  applyImpulse(a, jt * tx, jt * tz, dax, daz);
  applyImpulse(b, -jt * tx, -jt * tz, dbx, dbz);
  contacts.push({ a, b, tag: 'car', impulse: j, dv: j * ima, x: best.px, z: best.pz, nx, nz });
}
