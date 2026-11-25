// Small 2D helpers for the ground plane. Points are [x, z] with +X east and +Z south.

export type V2 = { x: number; z: number };

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
export const lerpAngle = (a: number, b: number, t: number) => a + wrapAngle(b - a) * t;
/** Exponential smoothing factor that is frame-rate independent. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** Heading convention: forward = (sin h, cos h); driver's right = (-cos h, sin h). */
export const forwardOf = (h: number): V2 => ({ x: Math.sin(h), z: Math.cos(h) });
export const rightOf = (h: number): V2 => ({ x: -Math.cos(h), z: Math.sin(h) });
export const headingOf = (dx: number, dz: number) => Math.atan2(dx, dz);

export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + dx * t, cz = az + dz * t;
  return { d: Math.hypot(px - cx, pz - cz), t, cx, cz };
}

export function pointInPolygon(x: number, z: number, poly: ArrayLike<number>) {
  let c = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], zi = poly[i * 2 + 1], xj = poly[j * 2], zj = poly[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

export function segmentIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number | null {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/** Line-line intersection parameter along the first line (infinite lines). */
export function lineIntersect(
  px: number, pz: number, dx: number, dz: number,
  qx: number, qz: number, ex: number, ez: number,
): { t: number; s: number } | null {
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((qx - px) * ez - (qz - pz) * ex) / den;
  const s = ((qx - px) * dz - (qz - pz) * dx) / den;
  return { t, s };
}

export function polylineLength(pts: ArrayLike<number>) {
  let len = 0;
  for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return len;
}

/** Polyline with cumulative distances for sampling by arc length. */
export class Path {
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;

  constructor(points: ArrayLike<number>) {
    const raw: number[] = [];
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i], z = points[i + 1];
      const n = raw.length;
      if (n >= 2 && Math.hypot(raw[n - 2] - x, raw[n - 1] - z) < 1e-4) continue;
      raw.push(x, z);
    }
    const n = raw.length / 2;
    this.xs = new Float64Array(n);
    this.zs = new Float64Array(n);
    this.cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = raw[i * 2];
      this.zs[i] = raw[i * 2 + 1];
      if (i > 0) this.cum[i] = this.cum[i - 1] + Math.hypot(this.xs[i] - this.xs[i - 1], this.zs[i] - this.zs[i - 1]);
    }
    this.length = n > 0 ? this.cum[n - 1] : 0;
  }

  get count() {
    return this.xs.length;
  }

  private seg(s: number) {
    const n = this.xs.length;
    if (s <= 0) return 0;
    if (s >= this.length) return Math.max(0, n - 2);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid; else hi = mid;
    }
    return lo;
  }

  pointAt(s: number, out: V2 = { x: 0, z: 0 }): V2 {
    const n = this.xs.length;
    if (n === 1) { out.x = this.xs[0]; out.z = this.zs[0]; return out; }
    const i = this.seg(s);
    const segLen = this.cum[i + 1] - this.cum[i] || 1e-9;
    const t = clamp((s - this.cum[i]) / segLen, 0, 1);
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t;
    out.z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t;
    return out;
  }

  headingAt(s: number) {
    const i = this.seg(s);
    if (this.xs.length < 2) return 0;
    return headingOf(this.xs[i + 1] - this.xs[i], this.zs[i + 1] - this.zs[i]);
  }

  /** Signed curvature (1/m) estimated over a window around s; positive = turning right. */
  curvatureAt(s: number, win = 6) {
    const h0 = this.headingAt(Math.max(0, s - win));
    const h1 = this.headingAt(Math.min(this.length, s + win));
    const span = Math.min(this.length, s + win) - Math.max(0, s - win);
    return span > 0.1 ? -wrapAngle(h1 - h0) / span : 0;
  }

  /** Closest arc-length position to a point, searched within [s0, s1]. */
  project(x: number, z: number, s0 = 0, s1 = Infinity) {
    let best = Infinity, bestS = 0, bestLat = 0;
    const n = this.xs.length;
    const i0 = Math.max(0, this.seg(s0));
    const i1 = s1 === Infinity ? n - 2 : Math.min(n - 2, this.seg(s1) + 1);
    for (let i = i0; i <= i1; i++) {
      const r = distToSegment(x, z, this.xs[i], this.zs[i], this.xs[i + 1], this.zs[i + 1]);
      if (r.d < best) {
        best = r.d;
        bestS = this.cum[i] + r.t * (this.cum[i + 1] - this.cum[i]);
        const dx = this.xs[i + 1] - this.xs[i], dz = this.zs[i + 1] - this.zs[i];
        // Lateral sign: positive when the point lies to the right of travel.
        const h = headingOf(dx, dz);
        const rt = rightOf(h);
        bestLat = (x - r.cx) * rt.x + (z - r.cz) * rt.z;
      }
    }
    return { s: bestS, d: best, lateral: bestLat };
  }
}
