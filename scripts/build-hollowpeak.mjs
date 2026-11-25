// Builds Hollowpeak, the fourth level: fictional mountain country made for speed.
// Big generated hills; a ring speedway and two crossways, six lanes wide, graded
// flat enough to run flat out, so they tunnel through the mountains (caves) and
// bridge the valleys; long lit tubes cover the valley straights; narrow hill
// roads climb over the peaks for big air. Nothing here is a real place.
//
// Usage: node scripts/build-hollowpeak.mjs
// Output: public/data/hollowpeak.json, hollowpeak-terrain.json (the ground cars
// drive on, with each cave cut out of the hill) and hollowpeak-surface.json (the
// hill over each cave, used for the cave roofs).
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'public/data/hollowpeak.json';
const EXT = 3000;
const SPACING = 10;
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let seed = 7041;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ------------------------------------------------------------------ terrain
function hash2(x, z) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + 1013904223;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return (hash2(i, j) * (1 - u) + hash2(i + 1, j) * u) * (1 - v) + (hash2(i, j + 1) * (1 - u) + hash2(i + 1, j + 1) * u) * v;
}
const fbm = (x, z) => vnoise(x, z) * 0.55 + vnoise(x * 2.03 + 5.2, z * 2.03 - 1.7) * 0.28 + vnoise(x * 4.1 - 3.1, z * 4.1 + 8.4) * 0.17;
const ridge = (x, z) => 1 - Math.abs(2 * fbm(x, z) - 1);
const PEAKS = [
  { x: -1800, z: -1550, h: 250, s: 520, name: 'Hollow Peak' },
  { x: 1650, z: -1700, h: 270, s: 560, name: 'Iron Knob' },
  { x: -1550, z: 1650, h: 220, s: 500, name: 'Grey Mare' },
  { x: 1750, z: 1450, h: 240, s: 540, name: 'Thunder Dome' },
  { x: -260, z: -950, h: 190, s: 360, name: 'Cathedral Rock' },
  { x: 950, z: 420, h: 175, s: 330, name: 'Anvil Hill' },
  { x: -1250, z: 330, h: 150, s: 380, name: 'Saddleback' },
  { x: 250, z: 1500, h: 120, s: 420, name: 'Low Dome' },
];
function H0(x, z) {
  let h = 35 + 70 * fbm(x / 1500 + 11, z / 1500 - 7) + 40 * ridge(x / 650 - 3, z / 650 + 9);
  for (const p of PEAKS) {
    const d2 = ((x - p.x) ** 2 + (z - p.z) ** 2) / (p.s * p.s);
    h += p.h * Math.exp(-d2) * (0.85 + 0.3 * fbm(x / 300, z / 300));
  }
  // Settle toward the map edge so the rim has room.
  const e = Math.max(Math.abs(x), Math.abs(z)) / EXT;
  return h * (1 - 0.35 * smooth((e - 0.88) / 0.12));
}

// ------------------------------------------------------------------ roads (2D)
/** Dense polyline every ~5 m from a list of points (linear between, then resampled). */
function resample(pts, step = 5, closed = false) {
  const src = closed ? [...pts, pts[0]] : pts;
  const out = [];
  let carry = 0;
  for (let i = 0; i + 1 < src.length; i++) {
    const [ax, az] = src[i], [bx, bz] = src[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    let s = carry;
    while (s < L) { out.push([ax + (bx - ax) * (s / L), az + (bz - az) * (s / L)]); s += step; }
    carry = s - L;
  }
  if (!closed) out.push([...src[src.length - 1]]);
  return out;
}

const SPEED = { cls: 'primary', w: 24, lf: 3, lb: 3, ow: 0, sp: 100, hw: 12, grade: 0.05, win: 560, caveH: 11, tubeH: 11 };
const HILL = { cls: 'secondary', w: 12, lf: 1, lb: 1, ow: 0, sp: 55, hw: 6, grade: 0.17, win: 30, caveH: 8.5, tubeH: 8.5 };

const roads = [];
// The Rimway: a rounded square ring, 5 km across.
{
  const R = 2480, p = 5;
  const pts = [];
  for (let k = 0; k < 720; k++) {
    const t = (k / 720) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    pts.push([R * Math.sign(c) * Math.abs(c) ** (2 / p), R * Math.sign(s) * Math.abs(s) ** (2 / p)]);
  }
  roads.push({ name: 'Rimway', ...SPEED, closed: true, pts: resample(pts, 5, true) });
}
const nsX = (z) => -260 + 170 * Math.sin(z / 760) + 60 * Math.sin(z / 260);
const ewZ = (x) => 380 + 150 * Math.sin(x / 680 + 1.1);
{
  const pts = [];
  for (let z = -2700; z <= 2700; z += 10) pts.push([nsX(z), z]);
  roads.push({ name: 'North Crossway', ...SPEED, pts: resample(pts) });
}
{
  const pts = [];
  for (let x = -2700; x <= 2700; x += 10) pts.push([x, ewZ(x)]);
  roads.push({ name: 'East Crossway', ...SPEED, pts: resample(pts) });
}
// Hill roads: over the peaks, steep and crested.
roads.push({ name: 'Summit Road', ...HILL, pts: resample([[1900, ewZ(1900)], [2050, -300], [2150, -900], [2200, -1400], [2050, -1950], [1900, -2700]]) });
roads.push({ name: 'Ridge Road', ...HILL, pts: resample([[nsX(1150), 1150], [-650, 1200], [-1100, 1150], [-1500, 1080], [-1950, 950], [-2700, 900]]) });
roads.push({ name: 'Quarry Road', ...HILL, pts: resample([[-2700, -700], [-2050, -800], [-1500, -1050], [-1050, -1300], [nsX(-1450), -1450]]) });

// ------------------------------------------------------------------ crossings and junctions
function segX(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: a[0] + rx * t, z: a[1] + rz * t };
}
/** Clip an open road to the part inside the rim, ending exactly on it; returns the rim index hit. */
const rim = roads[0];
function crossings(A, B) {
  const out = [];
  const na = A.closed ? A.pts.length : A.pts.length - 1, nb = B.closed ? B.pts.length : B.pts.length - 1;
  for (let i = 0; i < na; i++) {
    const a = A.pts[i], b = A.pts[(i + 1) % A.pts.length];
    for (let j = 0; j < nb; j++) {
      const c = B.pts[j], d = B.pts[(j + 1) % B.pts.length];
      if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.min(a[0], b[0]) > Math.max(c[0], d[0])) continue;
      if (Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.min(a[1], b[1]) > Math.max(c[1], d[1])) continue;
      const h = segX(a, b, c, d);
      if (h) out.push({ i, j, ...h });
    }
  }
  return out;
}
/** Insert a point into a road's polyline after index i; returns its index. */
function insertAt(road, i, x, z) {
  road.pts.splice(i + 1, 0, [x, z]);
  return i + 1;
}
// Clip the open roads that run past the rim, and join them to it.
const junctions = []; // { x, z, roads: [names] }
for (const r of roads.slice(1)) {
  const hits = crossings(r, rim);
  if (!hits.length) continue;
  // Keep the part between the outermost crossings that contains the road's middle.
  hits.sort((p, q) => p.i + p.t - (q.i + q.t));
  const mid = r.pts.length / 2;
  let lo = null, hi = null;
  for (const h of hits) { if (h.i + h.t < mid) lo = h; else if (!hi) hi = h; }
  if (hi) r.pts = [...r.pts.slice(0, hi.i + 1), [hi.x, hi.z]];
  if (lo) r.pts = [[lo.x, lo.z], ...r.pts.slice(lo.i + 1)];
}
// All pairwise crossings become at-grade junctions (the layout keeps them in the open).
for (let a = 0; a < roads.length; a++) for (let b = a + 1; b < roads.length; b++) {
  const A = roads[a], B = roads[b];
  for (const h of crossings(A, B)) junctions.push({ x: h.x, z: h.z, a: A.name, b: B.name });
}
// Endpoints that touch another road (within 1 m) are junctions too (the clipped ends).
for (const r of roads.slice(1)) for (const end of [r.pts[0], r.pts[r.pts.length - 1]]) {
  for (const o of roads) {
    if (o === r) continue;
    let best = null;
    for (let i = 0; i + 1 < o.pts.length; i++) {
      const a = o.pts[i], b = o.pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
      const t = clamp(((end[0] - a[0]) * dx + (end[1] - a[1]) * dz) / L2, 0, 1);
      const d = Math.hypot(end[0] - a[0] - dx * t, end[1] - a[1] - dz * t);
      if (!best || d < best.d) best = { d, x: a[0] + dx * t, z: a[1] + dz * t };
    }
    if (best && best.d < 30) {
      end[0] = best.x; end[1] = best.z;
      if (!junctions.some((j) => Math.hypot(j.x - best.x, j.z - best.z) < 2)) junctions.push({ x: best.x, z: best.z, a: r.name, b: o.name });
    }
  }
}
// Make sure every junction is an exact vertex of both roads.
for (const j of junctions) {
  for (const r of roads) {
    let bi = -1, bd = Infinity, bt = 0;
    const n = r.closed ? r.pts.length : r.pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = r.pts[i], b = r.pts[(i + 1) % r.pts.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
      const t = clamp(((j.x - a[0]) * dx + (j.z - a[1]) * dz) / L2, 0, 1);
      const d = Math.hypot(j.x - a[0] - dx * t, j.z - a[1] - dz * t);
      if (d < bd) { bd = d; bi = i; bt = t; }
    }
    if (bd > 0.5) continue;
    const a = r.pts[bi], b = r.pts[(bi + 1) % r.pts.length];
    if (Math.hypot(a[0] - j.x, a[1] - j.z) < 0.6) { a[0] = j.x; a[1] = j.z; continue; }
    if (Math.hypot(b[0] - j.x, b[1] - j.z) < 0.6) { b[0] = j.x; b[1] = j.z; continue; }
    void bt;
    insertAt(r, bi, j.x, j.z);
  }
}

// ------------------------------------------------------------------ vertical profiles
const cum = (pts, closed) => {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  if (closed) c.total = c[c.length - 1] + Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
  else c.total = c[c.length - 1];
  return c;
};
const pinned = new Map(); // "x,z" -> y
const key = (x, z) => `${Math.round(x * 2)},${Math.round(z * 2)}`;
function solveProfile(r) {
  const n = r.pts.length;
  const c = cum(r.pts, r.closed);
  const raw = r.pts.map(([x, z]) => H0(x, z));
  const idx = (i) => (r.closed ? (i + n) % n : clamp(i, 0, n - 1));
  // Moving average over the window (by arc length, using index steps of ~5 m).
  const half = Math.round(r.win / 2 / 5);
  let p = raw.map((_, i) => {
    let s = 0, k = 0;
    for (let d = -half; d <= half; d++) { const j = r.closed ? idx(i + d) : i + d; if (j < 0 || j >= n) continue; s += raw[j]; k++; }
    return s / k;
  });
  const pins = [];
  r.pts.forEach(([x, z], i) => { const y = pinned.get(key(x, z)); if (y !== undefined) pins.push([i, y]); });
  const ds = (i) => (i > 0 ? c[i] - c[i - 1] : r.closed ? c.total - c[n - 1] : 5);
  for (let it = 0; it < 400; it++) {
    for (const [i, y] of pins) p[i] = y;
    let changed = false;
    for (let i = 1; i < n + (r.closed ? 1 : 0); i++) {
      const a = idx(i - 1), b = idx(i);
      const g = r.grade * ds(b);
      const v = clamp(p[b], p[a] - g, p[a] + g);
      if (v !== p[b] && !pins.some(([pi]) => pi === b)) { p[b] = v; changed = true; }
    }
    for (let i = n - 2 + (r.closed ? 1 : 0); i >= 0; i--) {
      const a = idx(i + 1), b = idx(i);
      const g = r.grade * ds(a);
      const v = clamp(p[b], p[a] - g, p[a] + g);
      if (v !== p[b] && !pins.some(([pi]) => pi === b)) { p[b] = v; changed = true; }
    }
    if (!changed && it > 2) break;
  }
  // Round the grade changes off (vertical curves), then hold the pins.
  const soft = Math.round((r.cls === 'primary' ? 120 : 20) / 5);
  for (let pass = 0; pass < 2; pass++) {
    p = p.map((_, i) => {
      if (pins.some(([pi]) => pi === i)) return p[i];
      let s = 0, k = 0;
      for (let d = -soft; d <= soft; d++) { const j = r.closed ? idx(i + d) : i + d; if (j < 0 || j >= n) continue; s += p[j]; k++; }
      return s / k;
    });
  }
  // Smoothing can undo the grade limit next to a pin: clamp once more.
  for (let it = 0; it < 400; it++) {
    for (const [i, y] of pins) p[i] = y;
    let changed = false;
    for (let i = 1; i < n + (r.closed ? 1 : 0); i++) {
      const a = idx(i - 1), b = idx(i);
      if (pins.some(([pi]) => pi === b)) continue;
      const g = r.grade * ds(b);
      const v = clamp(p[b], p[a] - g, p[a] + g);
      if (v !== p[b]) { p[b] = v; changed = true; }
    }
    for (let i = n - 2 + (r.closed ? 1 : 0); i >= 0; i--) {
      const a = idx(i + 1), b = idx(i);
      if (pins.some(([pi]) => pi === b)) continue;
      const g = r.grade * ds(a);
      const v = clamp(p[b], p[a] - g, p[a] + g);
      if (v !== p[b]) { p[b] = v; changed = true; }
    }
    if (!changed) break;
  }
  for (const [i, y] of pins) p[i] = y;
  r.y = p;
  r.raw = raw;
  r.cum = c;
  r.pts.forEach(([x, z], i) => { if (!pinned.has(key(x, z))) pinned.set(key(x, z), p[i]); });
}
// Junction heights: the speedways decide; hill roads meet them.
for (const r of roads) solveProfile(r);

// ------------------------------------------------------------------ sections
// Each sample is open, cave (the hill stands over the road), bridge (the valley
// drops away), or tube (a covered straight on open ground).
for (const r of roads) {
  const n = r.pts.length;
  const sec = new Array(n).fill('open');
  const depth = r.raw.map((h, i) => h - r.y[i]);
  const mark = (test, extend, kind, minLen) => {
    let i = 0;
    while (i < n) {
      if (!test(i)) { i++; continue; }
      let a = i, b = i;
      while (b + 1 < n && test(b + 1)) b++;
      while (a > 0 && extend(a - 1)) a--;
      while (b + 1 < n && extend(b + 1)) b++;
      if (r.cum[b] - r.cum[a] >= minLen) for (let k = a; k <= b; k++) sec[k] = kind;
      i = b + 1;
    }
  };
  mark((i) => depth[i] > 16, (i) => depth[i] > 9, 'cave', 90);
  mark((i) => -depth[i] > 9 && sec[i] === 'open', (i) => -depth[i] > 3 && sec[i] === 'open', 'bridge', 30);
  // Junctions stay in the open: no cave, bridge or tube within 70 m of one.
  for (let i = 0; i < n; i++) {
    if (junctions.some((j) => Math.hypot(j.x - r.pts[i][0], j.z - r.pts[i][1]) < 70)) sec[i] = 'open';
  }
  // And nothing too short survives the trim.
  for (const kind of ['cave', 'bridge']) {
    let i = 0;
    while (i < n) {
      if (sec[i] !== kind) { i++; continue; }
      let b = i;
      while (b + 1 < n && sec[b + 1] === kind) b++;
      if (r.cum[b] - r.cum[i] < (kind === 'cave' ? 90 : 30)) for (let k = i; k <= b; k++) sec[k] = 'open';
      i = b + 1;
    }
  }
  r.sec = sec;
}
// Tubes: covered speed sections on the speedways, over open ground or along a
// viaduct (a sky-tube). The longest runs away from junctions and caves get one.
for (const r of roads.filter((q) => q.cls === 'primary')) {
  const n = r.pts.length;
  r.tube = new Array(n).fill(false);
  const nearJ = (i) => junctions.some((j) => Math.hypot(j.x - r.pts[i][0], j.z - r.pts[i][1]) < 170);
  const runs = [];
  let a = 0;
  for (let i = 0; i <= n; i++) {
    const ok = i < n && r.sec[i] !== 'cave' && !nearJ(i);
    if (ok) continue;
    if (i - a > 2) runs.push({ a, b: i - 1, len: r.cum[i - 1] - r.cum[a] });
    a = i + 1;
  }
  runs.sort((p, q) => q.len - p.len);
  const want = r.closed ? 4 : 2;
  for (const run of runs.slice(0, want)) {
    if (run.len < 420) continue;
    let { a: s0, b: s1 } = run;
    while (r.cum[s1] - r.cum[s0] > 1500) { s0++; s1--; }
    s0 += 8; s1 -= 8;
    for (let k = s0; k <= s1; k++) r.tube[k] = true;
  }
}

// ------------------------------------------------------------------ graph
const nodes = [];
const nodeIdx = new Map();
const nodeId = (x, z) => (Math.round(x) + 5000) * 1e4 + (Math.round(z) + 5000);
function node(x, z, y) {
  const id = nodeId(x, z);
  let i = nodeIdx.get(id);
  if (i === undefined) { i = nodes.length; nodes.push({ id, x, z, y }); nodeIdx.set(id, i); }
  else if (Math.abs(nodes[i].y - y) > 0.6) throw new Error(`node ${id} at two heights (${nodes[i].y} vs ${y})`);
  return i;
}
const isJunction = (x, z) => junctions.some((j) => Math.hypot(j.x - x, j.z - z) < 0.6);
const edges = [];
const tubes = [];
for (const r of roads) {
  const n = r.pts.length;
  // Break at junctions and wherever the section changes.
  const breaks = new Set([0]);
  for (let i = 1; i < n; i++) {
    if (isJunction(r.pts[i][0], r.pts[i][1])) breaks.add(i);
    if (r.sec[i] !== r.sec[i - 1]) breaks.add(r.sec[i] === 'open' ? i - 1 : i);
    if (r.tube && r.tube[i] !== r.tube[i - 1]) breaks.add(r.tube[i] ? i : i - 1);
  }
  if (!r.closed) breaks.add(n - 1);
  const list = [...breaks].sort((p, q) => p - q);
  if (r.closed) list.push(n); // back to the start
  for (let k = 0; k + 1 < list.length; k++) {
    const i0 = list[k], i1 = list[k + 1];
    const ids = [];
    for (let i = i0; i <= i1; i++) ids.push(i % n);
    if (ids.length < 2) continue;
    const kinds = new Set(ids.slice(1, -1).map((i) => r.sec[i]));
    const kind = kinds.size === 1 ? [...kinds][0] : r.sec[ids[Math.floor(ids.length / 2)]];
    const tubed = !!r.tube && r.tube[ids[Math.floor(ids.length / 2)]] && kind !== 'cave';
    const p0 = r.pts[ids[0]], p1 = r.pts[ids[ids.length - 1]];
    const a = node(p0[0], p0[1], r.y[ids[0]]), b = node(p1[0], p1[1], r.y[ids[ids.length - 1]]);
    // Keep polylines light: every other sample on straight bits is plenty (5 m is dense).
    const keep = ids.filter((_, q) => q === 0 || q === ids.length - 1 || q % 2 === 0);
    const e = {
      a, b, way: roads.indexOf(r) + 1, name: r.name, cls: r.cls, w: r.w, lf: r.lf, lb: r.lb, ow: r.ow,
      br: kind === 'bridge' ? 1 : 0, ly: 0, sp: r.sp,
      pts: keep.flatMap((i) => [r1(r.pts[i][0]), r1(r.pts[i][1])]), ys: keep.map((i) => r2(r.y[i])),
      lv: kind === 'cave' ? -1 : kind === 'bridge' ? 1 : 0,
    };
    edges.push(e);
    if (kind === 'cave' || tubed) tubes.push({ edge: edges.length - 1, hw: r.hw + 2, h: kind === 'cave' ? r.caveH : r.tubeH, cave: kind === 'cave' ? 1 : 0 });
  }
}

// ------------------------------------------------------------------ terrain: stamp the roads, cut the caves
const gw = Math.round((2 * EXT) / SPACING) + 1, gh = gw;
const ox = -EXT, oz = -EXT;
const H = new Float32Array(gw * gh);
for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) H[j * gw + i] = H0(ox + i * SPACING, oz + j * SPACING);
const bestD = new Float32Array(gw * gh).fill(Infinity), bestY = new Float32Array(gw * gh), bestB = new Float32Array(gw * gh), bestCore = new Float32Array(gw * gh);
const bestKind = new Uint8Array(gw * gh); // 1 stamp, 2 leave alone (cave or bridge nearest)
for (const r of roads) {
  const core = r.hw + 4;
  // Bridge ends sit on an embankment: the first and last 35 m of a bridge are filled in.
  const abut = r.pts.map(() => Infinity);
  for (let i = 0; i < r.pts.length; i++) {
    if (r.sec[i] !== 'bridge') continue;
    for (const dir of [-1, 1]) {
      let k = i;
      while (k + dir >= 0 && k + dir < r.pts.length && r.sec[k + dir] === 'bridge') k += dir;
      if (k + dir < 0 || k + dir >= r.pts.length) continue;
      abut[i] = Math.min(abut[i], Math.abs(r.cum[k + dir] - r.cum[i]));
    }
  }
  for (let i = 0; i < r.pts.length; i++) {
    const [x, z] = r.pts[i];
    const y = r.y[i];
    const kind = r.sec[i] === 'open' || (r.sec[i] === 'bridge' && abut[i] <= 35) ? 1 : 2;
    const bw = clamp(12 + 1.6 * Math.abs(r.raw[i] - y), 12, 90);
    const R = core + bw;
    const i0 = Math.max(0, Math.floor((x - R - ox) / SPACING)), i1 = Math.min(gw - 1, Math.ceil((x + R - ox) / SPACING));
    const j0 = Math.max(0, Math.floor((z - R - oz) / SPACING)), j1 = Math.min(gh - 1, Math.ceil((z + R - oz) / SPACING));
    for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
      const d = Math.hypot(ox + ii * SPACING - x, oz + jj * SPACING - z);
      const k = jj * gw + ii;
      if (d < bestD[k]) { bestD[k] = d; bestY[k] = y; bestB[k] = bw; bestCore[k] = core; bestKind[k] = kind; }
    }
  }
}
for (let k = 0; k < H.length; k++) {
  if (bestKind[k] !== 1) continue;
  const d = bestD[k];
  if (d <= bestCore[k]) H[k] = bestY[k];
  else if (d < bestCore[k] + bestB[k]) H[k] = lerp(bestY[k], H[k], smooth((d - bestCore[k]) / bestB[k]));
}
// Venue lots (mirrors places.ts): a level pad beside the road at the anchor.
const VENUE_LOTS = [
  { key: 'garage', road: 'Ridge Road', from: 'North Crossway', along: 160, side: -1, width: 13, depth: 10, setback: 9.5 },
  { key: 'rehearsal', road: 'Summit Road', from: 'East Crossway', along: 150, side: 1, width: 14, depth: 11, setback: 10 },
  { key: 'venue', road: 'Quarry Road', from: 'North Crossway', along: 170, side: 1, width: 14, depth: 12, setback: 6.5 },
];
const venueOut = {};
for (const v of VENUE_LOTS) {
  const r = roads.find((q) => q.name === v.road);
  const j = junctions.find((q) => (q.a === v.road && q.b === v.from) || (q.b === v.road && q.a === v.from));
  // Walk from the junction end of the road.
  let i0 = r.pts.findIndex(([x, z]) => Math.hypot(x - j.x, z - j.z) < 0.6);
  const dir = i0 > r.pts.length / 2 ? -1 : 1;
  let acc = 0, i = i0;
  while (acc < v.along) { const k = i + dir; acc += Math.hypot(r.pts[k][0] - r.pts[i][0], r.pts[k][1] - r.pts[i][1]); i = k; }
  const [px, pz] = r.pts[i];
  const [qx, qz] = r.pts[i + dir];
  const L = Math.hypot(qx - px, qz - pz) || 1;
  const fx = (qx - px) / L, fz = (qz - pz) / L;
  const off = (r.w / 2 + v.setback + v.depth / 2) * v.side;
  const cx = px - fz * off, cz = pz + fx * off, y = r.y[i];
  // The far end of the anchor: the next junction along the road, or its end.
  let k = i;
  while (k + dir >= 0 && k + dir < r.pts.length && !junctions.some((q) => Math.hypot(q.x - r.pts[k][0], q.z - r.pts[k][1]) < 0.6 && k !== i0)) k += dir;
  const far = r.pts[k];
  venueOut[v.key] = { from: nodeId(j.x, j.z), to: nodeId(far[0], far[1]), along: v.along, side: v.side, width: v.width, depth: v.depth, setback: v.setback, cx: r1(cx), cz: r1(cz) };
  const R = Math.hypot(v.width, v.depth) / 2 + 10;
  for (let jj = 0; jj < gh; jj++) for (let ii = 0; ii < gw; ii++) {
    const x = ox + ii * SPACING, z = oz + jj * SPACING;
    const dd = Math.hypot(x - cx, z - cz);
    if (dd > R + 25) continue;
    const k2 = jj * gw + ii;
    H[k2] = dd <= R ? y : lerp(y, H[k2], smooth((dd - R) / 25));
  }
}

// The surface (the hill over each cave) before the caves are cut.
const S = Float32Array.from(H);
// Caves: floor flat out past the walls (so the 10 m grid never lifts it), then the hill.
const STEP_PAD = 15; // > grid diagonal
// Each grid point takes the floor height of the nearest bit of cave road (not the
// lowest: on a steep, curving hill road that would sag the floor).
const caveD = new Float32Array(gw * gh).fill(Infinity), caveY = new Float32Array(gw * gh);
for (const t of tubes) {
  if (!t.cave) continue;
  const e = edges[t.edge];
  const step = t.hw + STEP_PAD;
  for (let q = 0; q + 1 < e.ys.length; q++) {
    const ax = e.pts[q * 2], az = e.pts[q * 2 + 1], bx = e.pts[q * 2 + 2], bz = e.pts[q * 2 + 3];
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const R = step + 2;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - ox) / SPACING)), i1 = Math.min(gw - 1, Math.ceil((Math.max(ax, bx) + R - ox) / SPACING));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R - oz) / SPACING)), j1 = Math.min(gh - 1, Math.ceil((Math.max(az, bz) + R - oz) / SPACING));
    for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
      const px = ox + ii * SPACING, pz = oz + jj * SPACING;
      const tt = clamp(((px - ax) * (bx - ax) + (pz - az) * (bz - az)) / (L * L), 0, 1);
      const d = Math.hypot(px - ax - (bx - ax) * tt, pz - az - (bz - az) * tt);
      if (d > step) continue;
      const y = lerp(e.ys[q], e.ys[q + 1], tt);
      const k = jj * gw + ii;
      if (d < caveD[k]) { caveD[k] = d; caveY[k] = y; }
    }
  }
}
for (let k = 0; k < H.length; k++) if (caveD[k] < Infinity) H[k] = Math.min(H[k], caveY[k]);

// ------------------------------------------------------------------ validation
const problems = [];
for (const e of edges) {
  // Grade over spans of at least 8 m (junction points can sit very close together).
  let i0 = 0, run = 0;
  for (let i = 1; i < e.ys.length; i++) {
    run += Math.hypot(e.pts[i * 2] - e.pts[i * 2 - 2], e.pts[i * 2 + 1] - e.pts[i * 2 - 1]);
    if (run < 8) continue;
    const g = Math.abs(e.ys[i] - e.ys[i0]) / run;
    if (g > (e.cls === 'primary' ? 0.075 : 0.185)) problems.push(`steep ${e.name} ${(g * 100).toFixed(1)}% at ${e.pts[i * 2]},${e.pts[i * 2 + 1]}`);
    i0 = i; run = 0;
  }
}
// Different roads that cross without a junction need clearance (one over a cave or a bridge).
for (let a = 0; a < edges.length; a++) for (let b = a + 1; b < edges.length; b++) {
  const A = edges[a], B = edges[b];
  if (A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue;
  for (let i = 0; i + 3 < A.pts.length; i += 2) for (let j = 0; j + 3 < B.pts.length; j += 2) {
    const h = segX([A.pts[i], A.pts[i + 1]], [A.pts[i + 2], A.pts[i + 3]], [B.pts[j], B.pts[j + 1]], [B.pts[j + 2], B.pts[j + 3]]);
    if (!h) continue;
    const ya = lerp(A.ys[i / 2], A.ys[i / 2 + 1], h.t), yb = lerp(B.ys[j / 2], B.ys[j / 2 + 1], h.u);
    problems.push(`crossing without a junction: ${A.name} (${r1(ya)}) x ${B.name} (${r1(yb)}) at ${r1(h.x)},${r1(h.z)}`);
  }
}
for (const t of tubes) {
  const e = edges[t.edge];
  for (const n of [e.a, e.b]) if (junctions.some((j) => Math.hypot(j.x - nodes[n].x, j.z - nodes[n].z) < 1)) problems.push(`junction at the end of a ${t.cave ? 'cave' : 'tube'} on ${e.name}`);
}
{
  const adj = nodes.map(() => []);
  edges.forEach((e) => { adj[e.a].push(e.b); adj[e.b].push(e.a); });
  const seen = new Uint8Array(nodes.length);
  const st = [0];
  seen[0] = 1;
  while (st.length) { const v = st.pop(); for (const w of adj[v]) if (!seen[w]) { seen[w] = 1; st.push(w); } }
  nodes.forEach((n, i) => { if (!seen[i]) problems.push(`unreachable ${n.x},${n.z}`); });
}
if (problems.length) {
  console.error(`${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.error('  ' + p);
  process.exit(1);
}

// ------------------------------------------------------------------ landcover, venues, landmarks
// Forest on the hillsides, kept well back from every road; meadow elsewhere.
const landcover = [];
const CELLF = 100;
const roadNear = (x, z, r) => {
  for (const rd of roads) for (let i = 0; i < rd.pts.length; i += 4) if (Math.hypot(rd.pts[i][0] - x, rd.pts[i][1] - z) < r + rd.hw) return true;
  return false;
};
for (let z = -EXT; z < EXT; z += CELLF) {
  let run = null;
  const flush = () => { if (run) { landcover.push({ k: 'forest', n: '', p: [run.x0, z, run.x1, z, run.x1, z + CELLF, run.x0, z + CELLF] }); run = null; } };
  for (let x = -EXT; x < EXT; x += CELLF) {
    const cx = x + CELLF / 2, cz = z + CELLF / 2;
    const h = H0(cx, cz);
    const forest = h > 110 && fbm(cx / 500 + 3, cz / 500 - 2) > 0.42 && !roadNear(cx, cz, 120);
    if (forest) { if (run) run.x1 = x + CELLF; else run = { x0: x, x1: x + CELLF }; } else flush();
  }
  flush();
}
const landmarks = PEAKS.map((p) => ({ name: p.name, kind: 'peak', x: p.x, z: p.z, addr: `${Math.round(H0(p.x, p.z))} m` }));
for (const t of tubes) {
  const e = edges[t.edge];
  const m = Math.floor(e.pts.length / 4) * 2;
  if (!t.cave) landmarks.push({ name: `${e.name} ${e.br ? 'Skytube' : 'Tube'} ${landmarks.filter((l) => l.kind === 'tunnel').length + 1}`, kind: 'tunnel', x: e.pts[m], z: e.pts[m + 1], addr: e.br ? 'Covered speed tube on a viaduct' : 'Covered speed tube' });
}

const terrainFile = OUT.replace(/\.json$/, '-terrain.json');
const surfaceFile = OUT.replace(/\.json$/, '-surface.json');
const enc = (arr) => {
  const q = new Uint16Array(arr.length);
  for (let k = 0; k < q.length; k++) q[k] = Math.round(clamp(arr[k], 0, 650) * 100);
  return { format: 'u16le-base64', width: gw, height: gh, data: Buffer.from(q.buffer).toString('base64') };
};
fs.writeFileSync(terrainFile, JSON.stringify(enc(H)));
fs.writeFileSync(surfaceFile, JSON.stringify(enc(S)));
const out = {
  meta: {
    title: 'Hollowpeak (fictional mountains)',
    map: 'hollowpeak',
    attribution: 'Fictional mountains generated by scripts/build-hollowpeak.mjs',
    attributionUrl: '',
    license: 'Part of this game (no outside map data)',
    source: 'scripts/build-hollowpeak.mjs',
    snapshot: null,
    crop: { south: 0, west: 0, north: 0, east: 0 },
    anchor: { lat: 0, lon: 0, label: 'Fictional origin' },
    convertedAt: new Date().toISOString(),
    command: 'node scripts/build-hollowpeak.mjs',
    counts: { nodes: nodes.length, edges: edges.length, junctions: junctions.length, caves: tubes.filter((t) => t.cave).length, tubes: tubes.filter((t) => !t.cave).length, bridges: edges.filter((e) => e.br).length, forest: landcover.length },
  },
  bounds: { minX: -EXT, maxX: EXT, minZ: -EXT, maxZ: EXT },
  terrain: { file: path.basename(terrainFile), width: gw, height: gh, spacing: SPACING, originX: ox, originZ: oz, scale: 0.01 },
  surface: { file: path.basename(surfaceFile) },
  nodes: nodes.map((n) => [n.id, r1(n.x), r1(n.z)]),
  nodeY: nodes.map((n) => r2(n.y)),
  edges,
  tubes,
  venues: venueOut,
  boundaryExits: [],
  water: [],
  rivers: [],
  buildings: [],
  parks: [],
  landmarks,
  landcover,
  villages: [],
  docks: [],
  rail: [],
};
fs.writeFileSync(OUT, JSON.stringify(out));
const len = (name) => Math.round(roads.find((r) => r.name === name).cum.total);
console.log(JSON.stringify(out.meta.counts), 'rim', len('Rimway'), 'm');
for (const t of tubes) { const e = edges[t.edge]; console.log(`  ${t.cave ? 'cave' : e.br ? 'skytube' : 'tube'} on ${e.name}: ${Math.round(e.pts.length / 2 * 10)} m, ${e.pts[0]},${e.pts[1]} -> ${e.pts[e.pts.length - 2]},${e.pts[e.pts.length - 1]}`); }
console.log('  venues', JSON.stringify(venueOut));
for (const j of junctions) console.log(`  junction ${j.a} x ${j.b} at ${r1(j.x)},${r1(j.z)} id ${nodeId(j.x, j.z)}`);
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KiB), terrain and surface (${(fs.statSync(terrainFile).size / 1024).toFixed(0)} KiB each, ${gw}x${gh})`);
