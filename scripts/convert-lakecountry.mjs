// Converts the Chenequa / Hartland OpenStreetMap extract plus terrain tiles into
// the compact map the game loads.
//
// Usage: node scripts/convert-lakecountry.mjs [--input data/raw-lake/lakecountry.osm.json]
// Inputs: data/raw-lake/lakecountry.osm.json (Overpass), data/raw-lake/terrain/*.png
//         (Terrarium-encoded elevation tiles, zoom 14, derived from USGS 3DEP).
// Output: public/data/lakecountry.json and public/data/lakecountry-terrain.json
// Coordinates: local meters about a fixed origin (the original Chenequa/Hartland
// crop centre, kept when the map grew so every coordinate stays put); +X east,
// +Z south, Y up (Y = elevation minus 256 m).
import fs from 'node:fs';
import { mapArg } from './maps.mjs';
import path from 'node:path';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MAP = mapArg();
const INPUT = opt('--input', `${MAP.raw}/${MAP.file}.osm.json`);
const TILE_DIR = opt('--tiles', `${MAP.raw}/terrain`);
const OUT = opt('--out', `public/data/${MAP.file}.json`);
// Extended north and east to take in all of North Lake and the Village of Merton.
const CROP = MAP.crop;
const ORIGIN = MAP.origin;
const GRID = 10; // terrain spacing (m)

const rad = Math.PI / 180;
const mPerLat = 111132.954 - 559.822 * Math.cos(2 * ORIGIN.lat * rad) + 1.175 * Math.cos(4 * ORIGIN.lat * rad);
const mPerLon = 111412.84 * Math.cos(ORIGIN.lat * rad) - 93.5 * Math.cos(3 * ORIGIN.lat * rad);
const project = (lat, lon) => [(lon - ORIGIN.lon) * mPerLon, -(lat - ORIGIN.lat) * mPerLat];
const unproject = (x, z) => ({ lat: ORIGIN.lat - z / mPerLat, lon: ORIGIN.lon + x / mPerLon });
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------ input
const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const nodes = new Map(), ways = new Map(), relations = [];
for (const el of data.elements) {
  if (el.type === 'node') nodes.set(el.id, el);
  else if (el.type === 'way') ways.set(el.id, el);
  else relations.push(el);
}
const [minX, maxZ] = project(CROP.s, CROP.w);
const [maxX, minZ] = project(CROP.n, CROP.e);
const inside = (p, pad = 0) => p[0] >= minX - pad && p[0] <= maxX + pad && p[1] >= minZ - pad && p[1] <= maxZ + pad;
const P = (id) => { const n = nodes.get(id); return n ? project(n.lat, n.lon) : null; };

// ------------------------------------------------------------------ terrain
const tiles = new Map();
for (const f of fs.readdirSync(TILE_DIR)) {
  const m = f.match(/^(\d+)_(\d+)_(\d+)\.png$/);
  if (!m) continue;
  const png = PNG.sync.read(fs.readFileSync(path.join(TILE_DIR, f)));
  const h = new Float32Array(256 * 256);
  for (let i = 0; i < 256 * 256; i++) h[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
  tiles.set(`${m[2]}_${m[3]}`, h);
}
const Z = 14;
function elevation(lat, lon) {
  const n = 2 ** Z;
  const fx = ((lon + 180) / 360) * n * 256;
  const fy = ((1 - Math.log(Math.tan(lat * rad) + 1 / Math.cos(lat * rad)) / Math.PI) / 2) * n * 256;
  const px = fx - 0.5, py = fy - 0.5;
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const tx = px - x0, ty = py - y0;
  const s = (X, Y) => {
    const t = tiles.get(`${Math.floor(X / 256)}_${Math.floor(Y / 256)}`);
    if (!t) return NaN;
    return t[(Y % 256) * 256 + (X % 256)];
  };
  const a = s(x0, y0), b = s(x0 + 1, y0), c = s(x0, y0 + 1), d = s(x0 + 1, y0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
const gw = Math.floor((maxX - minX) / GRID) + 1;
const gh = Math.floor((maxZ - minZ) / GRID) + 1;
const heights = new Float32Array(gw * gh);
let base = Infinity;
for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
  const ll = unproject(minX + i * GRID, minZ + j * GRID);
  const e = elevation(ll.lat, ll.lon);
  heights[j * gw + i] = e;
  if (e < base) base = e;
}
// Fixed datum (when set) so heights stay put as the map grows; lower only if the ground does.
base = MAP.datum != null ? Math.min(MAP.datum, Math.floor(base) - 2) : Math.floor(base) - 2;
// Vertical exaggeration (hill country levels): heights above the datum are scaled.
for (let i = 0; i < heights.length; i++) heights[i] = (heights[i] - base) * MAP.vscale;
const hAt = (x, z) => {
  const fx = (x - minX) / GRID, fz = (z - minZ) / GRID;
  const i = Math.max(0, Math.min(gw - 2, Math.floor(fx))), j = Math.max(0, Math.min(gh - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i)), tz = Math.max(0, Math.min(1, fz - j));
  const a = heights[j * gw + i], b = heights[j * gw + i + 1], c = heights[(j + 1) * gw + i], d = heights[(j + 1) * gw + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
};
const rawHeights = heights.slice();
const rawAt = (x, z) => {
  const fx = (x - minX) / GRID, fz = (z - minZ) / GRID;
  const i = Math.max(0, Math.min(gw - 2, Math.floor(fx))), j = Math.max(0, Math.min(gh - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i)), tz = Math.max(0, Math.min(1, fz - j));
  const a = rawHeights[j * gw + i], b = rawHeights[j * gw + i + 1], c = rawHeights[(j + 1) * gw + i], d = rawHeights[(j + 1) * gw + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
};

// ------------------------------------------------------------------ geometry helpers
function dpSimplify(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a], [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - az) * dz) / l2));
      const ex = ax + t * dx - pts[i][0], ez = az + t * dz - pts[i][1];
      const dd = ex * ex + ez * ez;
      if (dd > best) { best = dd; bi = i; }
    }
    if (best > tol * tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const area = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
function pointInPoly(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function clipPolygonToRect(poly) {
  const edges = [(p) => p[0] >= minX, (p) => p[0] <= maxX, (p) => p[1] >= minZ, (p) => p[1] <= maxZ];
  const isect = [
    (a, b) => { const t = (minX - a[0]) / (b[0] - a[0]); return [minX, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (maxX - a[0]) / (b[0] - a[0]); return [maxX, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (minZ - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), minZ]; },
    (a, b) => { const t = (maxZ - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), maxZ]; },
  ];
  let out = poly;
  for (let k = 0; k < 4; k++) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      const cin = edges[k](cur), pin = edges[k](prev);
      if (cin) { if (!pin) out.push(isect[k](prev, cur)); out.push(cur); } else if (pin) out.push(isect[k](prev, cur));
    }
    if (!out.length) break;
  }
  return out;
}
function segRectCrossing(p, q) {
  let t = 1;
  const dx = q[0] - p[0], dz = q[1] - p[1];
  if (q[0] < minX) t = Math.min(t, (minX - p[0]) / dx);
  if (q[0] > maxX) t = Math.min(t, (maxX - p[0]) / dx);
  if (q[1] < minZ) t = Math.min(t, (minZ - p[1]) / dz);
  if (q[1] > maxZ) t = Math.min(t, (maxZ - p[1]) / dz);
  return [p[0] + dx * t, p[1] + dz * t];
}
function assembleRings(wayIds) {
  const segs = wayIds.map((id) => ways.get(id)).filter(Boolean).map((w) => w.nodes.slice());
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let progress = true;
    while (ring[0] !== ring[ring.length - 1] && progress) {
      progress = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], end = ring[ring.length - 1];
        if (s[0] === end) ring = ring.concat(s.slice(1));
        else if (s[s.length - 1] === end) ring = ring.concat(s.slice().reverse().slice(1));
        else continue;
        segs.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}
const toPoly = (ids) => ids.slice(0, -1).filter((id) => nodes.has(id)).map((id) => P(id));
/** Polygons from closed ways and multipolygon relations matching `pred`. */
function polygons(pred, simplify = 1) {
  const out = [];
  const add = (ids, tags) => {
    let poly = clipPolygonToRect(toPoly(ids));
    if (poly.length < 3 || Math.abs(area(poly)) < 100) return;
    poly = dpSimplify(poly.concat([poly[0]]), simplify).slice(0, -1);
    if (poly.length < 3) return;
    if (area(poly) < 0) poly.reverse();
    out.push({ poly, tags });
  };
  for (const w of ways.values()) {
    const t = w.tags ?? {};
    if (w.nodes[0] === w.nodes[w.nodes.length - 1] && pred(t)) add(w.nodes, t);
  }
  for (const r of relations) {
    const t = r.tags ?? {};
    if (r.type !== 'relation' || !pred(t) || !r.members) continue;
    for (const ring of assembleRings(r.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => m.ref))) add(ring, t);
  }
  return out;
}

// ------------------------------------------------------------------ roads
const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
]);
const CLASS_SPEED = { motorway: 70, motorway_link: 45, trunk: 55, trunk_link: 40, primary: 45, primary_link: 35, secondary: 40, secondary_link: 30, tertiary: 35, tertiary_link: 30, unclassified: 30, residential: 25, living_street: 15 };
function roadAttrs(t) {
  const cls = t.highway;
  let oneway = 0;
  if (t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1' || t.junction === 'roundabout' || cls === 'motorway') oneway = 1;
  if (t.oneway === '-1') oneway = -1;
  if (t.oneway === 'no') oneway = 0;
  let lanes = Number.parseInt(t.lanes, 10);
  if (!Number.isFinite(lanes) || lanes < 1) lanes = cls === 'motorway' ? 2 : oneway ? 1 : 2;
  let lf, lb;
  if (oneway) { lf = lanes; lb = 0; } else { lf = Math.max(1, Math.ceil(lanes / 2)); lb = Math.max(1, Math.floor(lanes / 2)); }
  const total = lf + lb;
  let width;
  if (cls === 'motorway') width = 3.7 * lanes + 4.5; // shoulders
  else if (cls.endsWith('_link')) width = 3.8 * lanes + 2.6;
  else if (oneway) width = Math.max(6, 3.5 * total + 2);
  else width = Math.max(cls === 'residential' ? 8 : 9, 3.4 * total + (total >= 4 ? 1.5 : cls === 'residential' ? 1.5 : 2.6));
  let speed = Number.parseInt(t.maxspeed, 10);
  if (!Number.isFinite(speed)) speed = CLASS_SPEED[cls] ?? 25;
  const ref = t.ref ? t.ref.replace(/;/g, ' / ') : '';
  return {
    name: t.name ?? (ref ? (cls === 'motorway' ? `I-${ref.replace(/^I ?/, '')}` : ref) : ''),
    ref, cls, width: r1(width), lf, lb, oneway, bridge: t.bridge && t.bridge !== 'no' ? 1 : 0,
    layer: Number.parseInt(t.layer, 10) || 0, speed,
  };
}
// Interstate refs read "I 94"; WIS-16 reads "WIS 16".
function prettyName(a) {
  if (a.cls === 'motorway' || a.cls === 'motorway_link') {
    if (/I ?94/.test(a.ref) || /94/.test(a.name)) return a.cls === 'motorway' ? 'Interstate 94' : 'I-94 ramp';
    if (/16/.test(a.ref) || /16/.test(a.name)) return a.cls === 'motorway' ? 'WIS 16' : 'WIS 16 ramp';
    return a.cls === 'motorway' ? (a.name || 'Freeway') : 'Freeway ramp';
  }
  return a.name;
}

let synthId = -1;
const synthNodes = new Map();
const runs = [];
for (const way of ways.values()) {
  const t = way.tags ?? {};
  if (!DRIVABLE.has(t.highway) || t.area === 'yes' || t.access === 'private' || t.access === 'no') continue;
  const attrs = roadAttrs(t);
  attrs.name = prettyName(attrs);
  let ids = way.nodes.filter((id) => nodes.has(id));
  if (attrs.oneway === -1) { ids = ids.slice().reverse(); attrs.oneway = 1; }
  let cur = null;
  for (let i = 0; i < ids.length; i++) {
    const p = P(ids[i]);
    if (inside(p)) {
      if (!cur) {
        cur = { wayId: way.id, ids: [], attrs };
        if (i > 0) { const sid = synthId--; synthNodes.set(sid, segRectCrossing(p, P(ids[i - 1]))); cur.ids.push(sid); }
      }
      cur.ids.push(ids[i]);
    } else if (cur) {
      const sid = synthId--;
      synthNodes.set(sid, segRectCrossing(P(ids[i - 1]), p));
      cur.ids.push(sid);
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
}
const pos = (id) => synthNodes.get(id) ?? P(id);
const useCount = new Map();
for (const r of runs) for (const id of r.ids) useCount.set(id, (useCount.get(id) ?? 0) + 1);
const isVertex = new Set();
for (const r of runs) { isVertex.add(r.ids[0]); isVertex.add(r.ids[r.ids.length - 1]); }
for (const [id, c] of useCount) if (c > 1) isVertex.add(id);
let rawEdges = [];
for (const r of runs) {
  let start = 0;
  for (let i = 1; i < r.ids.length; i++) if (isVertex.has(r.ids[i])) { if (i > start) rawEdges.push({ wayId: r.wayId, ids: r.ids.slice(start, i + 1), attrs: r.attrs }); start = i; }
}
const sameAttrs = (a, b) => a.name === b.name && a.cls === b.cls && a.width === b.width && a.lf === b.lf && a.lb === b.lb && a.oneway === b.oneway && a.bridge === b.bridge && a.layer === b.layer;
let merged = true;
while (merged) {
  merged = false;
  const inc = new Map();
  rawEdges.forEach((e, i) => { for (const id of [e.ids[0], e.ids[e.ids.length - 1]]) { if (!inc.has(id)) inc.set(id, []); inc.get(id).push(i); } });
  const dead = new Set();
  for (const [v, list] of inc) {
    if (list.length !== 2 || v < 0) continue;
    const [i, j] = list;
    if (i === j || dead.has(i) || dead.has(j)) continue;
    const e1 = rawEdges[i], e2 = rawEdges[j];
    if (!sameAttrs(e1.attrs, e2.attrs)) continue;
    let a = e1.ids, b = e2.ids;
    if (e1.attrs.oneway) {
      if (a[a.length - 1] === v && b[0] === v) { /* ok */ } else if (b[b.length - 1] === v && a[0] === v) [a, b] = [b, a]; else continue;
    } else {
      if (a[a.length - 1] !== v) a = a.slice().reverse();
      if (b[0] !== v) b = b.slice().reverse();
    }
    if (a[0] === b[b.length - 1]) continue;
    rawEdges[i] = { wayId: e1.wayId, ids: a.concat(b.slice(1)), attrs: e1.attrs };
    dead.add(j);
    merged = true;
  }
  rawEdges = rawEdges.filter((_, k) => !dead.has(k));
}

// Densify every ~8 m so roads can follow the hills.
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const l = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(l / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

const vertexIndex = new Map();
const outNodes = [];
const vIdx = (id) => {
  if (!vertexIndex.has(id)) { const p = pos(id); vertexIndex.set(id, outNodes.length); outNodes.push([id, r1(p[0]), r1(p[1])]); }
  return vertexIndex.get(id);
};
let edges = [];
for (const e of rawEdges) {
  const pts = densify(dpSimplify(e.ids.map(pos), 0.3), 8);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (len < 0.5) continue;
  edges.push({ a: vIdx(e.ids[0]), b: vIdx(e.ids[e.ids.length - 1]), way: e.wayId, ...e.attrs, pts });
}
// Largest connected component only.
{
  const adj = outNodes.map(() => []);
  edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
  const comp = new Int32Array(outNodes.length).fill(-1);
  let best = -1, bestSize = 0, cid = 0;
  for (let s = 0; s < outNodes.length; s++) {
    if (comp[s] >= 0) continue;
    const stack = [s]; comp[s] = cid; let size = 0;
    while (stack.length) { const v = stack.pop(); size++; for (const ei of adj[v]) { const o = edges[ei].a === v ? edges[ei].b : edges[ei].a; if (comp[o] < 0) { comp[o] = cid; stack.push(o); } } }
    if (size > bestSize) { bestSize = size; best = cid; }
    cid++;
  }
  const remap = new Map();
  const kept = [];
  outNodes.forEach((n, i) => { if (comp[i] === best) { remap.set(i, kept.length); kept.push(n); } });
  edges = edges.filter((e) => comp[e.a] === best).map((e) => ({ ...e, a: remap.get(e.a), b: remap.get(e.b) }));
  outNodes.length = 0;
  outNodes.push(...kept);
}

// ------------------------------------------------------------------ water (before stamping)
const waterPolys = polygons((t) => t.natural === 'water' && t.water !== 'basin' && t.intermittent !== 'yes', 1.2);
for (const w of waterPolys) {
  // Lidar water surfaces are flat: take a low percentile of samples inside.
  const xs = w.poly.map((p) => p[0]), zs = w.poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const samples = [];
  const step = Math.max(GRID, Math.sqrt(((x1 - x0) * (z1 - z0)) / 400));
  for (let x = x0; x <= x1; x += step) for (let z = z0; z <= z1; z += step) if (pointInPoly([x, z], w.poly)) samples.push(rawAt(x, z));
  if (!samples.length) samples.push(rawAt(w.poly[0][0], w.poly[0][1]));
  samples.sort((a, b) => a - b);
  w.level = samples[Math.floor(samples.length * 0.2)] ?? 0;
  w.name = w.tags.name ?? '';
}

// ------------------------------------------------------------------ road heights
// Node heights from smoothed terrain; edge profiles smoothed and pinned to their nodes;
// bridges run straight between their ends.
const nodeY = outNodes.map(([, x, z]) => {
  let s = 0, n = 0;
  for (let dx = -12; dx <= 12; dx += 6) for (let dz = -12; dz <= 12; dz += 6) { s += rawAt(x + dx, z + dz); n++; }
  return s / n;
});
// A node used by a bridge takes its height from a non-bridge neighbour where it can.
for (const e of edges) {
  const prof = e.pts.map(([x, z]) => rawAt(x, z));
  const cum = [0];
  for (let i = 1; i < e.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const ya = nodeY[e.a], yb = nodeY[e.b];
  let ys;
  if (e.bridge) {
    // Decks run straight between their abutments.
    ys = cum.map((s) => ya + ((yb - ya) * s) / (L || 1));
  } else {
    // Moving average over ~18 m (keeps crests sharp enough to catch air), pinned to nodes.
    ys = prof.map((_, i) => {
      let s = 0, w = 0;
      for (let k = 0; k < prof.length; k++) {
        const d = Math.abs(cum[k] - cum[i]);
        if (d > 18) continue;
        const wt = 1 - d / 18;
        s += prof[k] * wt;
        w += wt;
      }
      return s / w;
    });
    ys = ys.map((y, i) => {
      const ta = Math.max(0, 1 - cum[i] / 20), tb = Math.max(0, 1 - (L - cum[i]) / 20);
      const toA = y + (ya - y) * ta;
      return toA + (yb - toA) * tb;
    });
  }
  e.ys = ys;
  e.cum = cum;
}

// ------------------------------------------------------------------ grade separation
// The bare-earth DEM has no gap under overpasses, so a bridge and the road it
// crosses come out level. Lift the bridge road and cut the road beneath with
// smooth vertical curves until there is real clearance.
{
  const CLEAR = 6.2;
  const segX = (a, b, c, d) => {
    const r = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
    if (Math.abs(r) < 1e-9) return null;
    const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / r;
    const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / r;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
  };
  const raw = [];
  for (const b of edges) {
    if (!b.bridge) continue;
    for (const u of edges) {
      if (u === b || u.bridge || u.name === b.name || u.a === b.a || u.a === b.b || u.b === b.a || u.b === b.b) continue;
      for (let i = 0; i + 1 < b.pts.length; i++) for (let k = 0; k + 1 < u.pts.length; k++) {
        const h = segX(b.pts[i], b.pts[i + 1], u.pts[k], u.pts[k + 1]);
        if (!h) continue;
        const yb = b.ys[i] + (b.ys[i + 1] - b.ys[i]) * h[0];
        const yu = u.ys[k] + (u.ys[k + 1] - u.ys[k]) * h[1];
        const x = b.pts[i][0] + (b.pts[i + 1][0] - b.pts[i][0]) * h[0], z = b.pts[i][1] + (b.pts[i + 1][1] - b.pts[i][1]) * h[0];
        raw.push({ x, z, need: CLEAR - (yb - yu), keep: b.name, under: u.name, keepMotor: b.cls.startsWith('motorway'), underMotor: u.cls.startsWith('motorway') });
      }
    }
  }
  // Both carriageways of a divided road cross together: merge nearby pairs.
  const crossings = [];
  for (const c of raw) {
    const m = crossings.find((q) => q.keep === c.keep && q.under === c.under && Math.hypot(q.x - c.x, q.z - c.z) < 70);
    if (m) { m.need = Math.max(m.need, c.need); m.n++; m.sx += c.x; m.sz += c.z; m.x = m.sx / m.n; m.z = m.sz / m.n; }
    else crossings.push({ ...c, n: 1, sx: c.x, sz: c.z });
  }
  const active = crossings.filter((c) => c.need > 0);
  const f = (d, R) => (d >= R ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / R)));
  const field = (x, z, isKeep) => {
    let dy = 0;
    for (const c of active) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (isKeep(c.keep)) dy += c.need * 0.45 * f(d, c.keepMotor ? 150 : 95);
      else dy -= c.need * 0.55 * f(d, c.underMotor ? 120 : 80);
    }
    return dy;
  };
  const incident = outNodes.map(() => new Set());
  for (const e of edges) { incident[e.a].add(e.name); incident[e.b].add(e.name); }
  const nodeDy = outNodes.map(([, x, z], n) => field(x, z, (keep) => incident[n].has(keep)));
  for (const e of edges) {
    const rawDy = e.pts.map(([x, z]) => field(x, z, (keep) => keep === e.name));
    const L = e.cum[e.cum.length - 1] || 1;
    const fixA = nodeDy[e.a] - rawDy[0], fixB = nodeDy[e.b] - rawDy[rawDy.length - 1];
    e.ys = e.ys.map((y, i) => y + rawDy[i] + fixA * (1 - e.cum[i] / L) + fixB * (e.cum[i] / L));
  }
  nodeDy.forEach((dy, n) => (nodeY[n] += dy));
  for (const c of active) console.log(`grade separation: ${c.keep} over ${c.under} at ${Math.round(c.x)},${Math.round(c.z)}: +${c.need.toFixed(1)} m`);
}

// ------------------------------------------------------------------ grade limit
// Junction pinning can leave short steep kinks; relax interior points until no
// segment is steeper than the road class allows (ends stay on their nodes).
{
  let fixed = 0;
  for (const e of edges) {
    if (e.bridge || e.ys.length < 3) continue;
    const g = e.cls === 'motorway' ? 0.06 : e.cls === 'motorway_link' ? 0.08 : MAP.maxGrade;
    const y = e.ys, c = e.cum;
    for (let it = 0; it < 200; it++) {
      let changed = false;
      for (let i = 1; i < y.length - 1; i++) {
        const L1 = c[i] - c[i - 1] || 1, L2 = c[i + 1] - c[i] || 1;
        if (Math.abs(y[i] - y[i - 1]) / L1 > g || Math.abs(y[i + 1] - y[i]) / L2 > g) {
          y[i] = (y[i - 1] * L2 + y[i + 1] * L1) / (L1 + L2);
          changed = true;
        }
      }
      if (!changed) break;
      if (it === 0) fixed++;
    }
  }
  console.log(`grade limit: relaxed ${fixed} edges`);
}

// ------------------------------------------------------------------ stamp terrain
const touched = new Float32Array(gw * gh).fill(-1); // weight of strongest stamp so far
function stamp(x, z, y, radiusFull, radiusBlend, lowerOnly = false) {
  const r = radiusFull + radiusBlend;
  const i0 = Math.max(0, Math.floor((x - r - minX) / GRID)), i1 = Math.min(gw - 1, Math.ceil((x + r - minX) / GRID));
  const j0 = Math.max(0, Math.floor((z - r - minZ) / GRID)), j1 = Math.min(gh - 1, Math.ceil((z + r - minZ) / GRID));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const gx = minX + i * GRID, gz = minZ + j * GRID;
    const d = Math.hypot(gx - x, gz - z);
    if (d > r) continue;
    const wgt = d <= radiusFull ? 1 : 1 - (d - radiusFull) / radiusBlend;
    const k = j * gw + i;
    if (wgt <= touched[k]) continue;
    touched[k] = wgt;
    const cur = rawHeights[k];
    const target = lowerOnly ? Math.min(cur, y) : y;
    heights[k] = cur + (target - cur) * wgt;
  }
}
for (const w of waterPolys) {
  // Lower the lakebed below the surface; leave a soft shore.
  const xs = w.poly.map((p) => p[0]), zs = w.poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  for (let x = Math.floor((x0 - minX) / GRID) * GRID + minX; x <= x1; x += GRID) {
    for (let z = Math.floor((z0 - minZ) / GRID) * GRID + minZ; z <= z1; z += GRID) {
      if (!pointInPoly([x, z], w.poly)) continue;
      const i = Math.round((x - minX) / GRID), j = Math.round((z - minZ) / GRID);
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      heights[j * gw + i] = Math.min(heights[j * gw + i], w.level - 2.2);
    }
  }
}
for (const e of edges) {
  if (e.bridge) continue;
  const full = e.width / 2 + 3 + MAP.shelf, blend = e.cls === 'motorway' ? 16 : 9;
  for (let i = 0; i < e.pts.length; i++) {
    stamp(e.pts[i][0], e.pts[i][1], e.ys[i] - 0.05, full, blend);
    if (i > 0) {
      const mx = (e.pts[i][0] + e.pts[i - 1][0]) / 2, mz = (e.pts[i][1] + e.pts[i - 1][1]) / 2;
      stamp(mx, mz, (e.ys[i] + e.ys[i - 1]) / 2 - 0.05, full, blend);
    }
  }
}
// Keep ground under bridges clear of the deck.
for (const e of edges) {
  if (!e.bridge) continue;
  for (let i = 1; i < e.pts.length - 1; i++) {
    const g = hAt(e.pts[i][0], e.pts[i][1]);
    if (g > e.ys[i] - 5.2) stamp(e.pts[i][0], e.pts[i][1], e.ys[i] - 5.5, e.width / 2, 4, true);
  }
}

// ------------------------------------------------------------------ landcover
const landcover = [];
const addCover = (kind, pred, simp = 2) => {
  for (const p of polygons(pred, simp)) landcover.push({ k: kind, n: p.tags.name ?? '', p: p.poly.flatMap((q) => [r1(q[0]), r1(q[1])]) });
};
addCover('forest', (t) => t.landuse === 'forest' || t.natural === 'wood');
addCover('wetland', (t) => t.natural === 'wetland');
addCover('farm', (t) => t.landuse === 'farmland' || t.landuse === 'meadow' || t.natural === 'grassland' || t.landuse === 'farmyard');
addCover('residential', (t) => t.landuse === 'residential');
addCover('commercial', (t) => t.landuse === 'commercial' || t.landuse === 'retail' || t.landuse === 'industrial');
addCover('park', (t) => t.leisure === 'park' || t.leisure === 'golf_course' || t.leisure === 'pitch' || t.landuse === 'recreation_ground' || t.landuse === 'grass' || t.landuse === 'cemetery' || t.leisure === 'nature_reserve');
addCover('parking', (t) => t.amenity === 'parking');
const villages = [];
for (const r of relations) {
  const t = r.tags ?? {};
  if (t.boundary !== 'administrative' || t.admin_level !== '8' || !MAP.villages.includes(t.name)) continue;
  const rings = assembleRings((r.members ?? []).filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => m.ref));
  for (const ring of rings) {
    const poly = clipPolygonToRect(toPoly(ring));
    if (poly.length < 3) continue;
    const s = dpSimplify(poly.concat([poly[0]]), 4).slice(0, -1);
    villages.push({ n: t.name, kind: t['border_type'] ?? '', p: s.flatMap((q) => [r1(q[0]), r1(q[1])]) });
  }
}

// ------------------------------------------------------------------ road index for placement checks
const CELL = 40;
const roadCells = new Map();
const cellKey = (cx, cz) => cx * 100000 + cz;
edges.forEach((e, ei) => {
  for (let i = 1; i < e.pts.length; i++) {
    const [ax, az] = e.pts[i - 1], [bx, bz] = e.pts[i];
    for (let x = Math.floor(Math.min(ax, bx) / CELL) - 1; x <= Math.floor(Math.max(ax, bx) / CELL) + 1; x++)
      for (let z = Math.floor(Math.min(az, bz) / CELL) - 1; z <= Math.floor(Math.max(az, bz) / CELL) + 1; z++) {
        const k = cellKey(x, z);
        if (!roadCells.has(k)) roadCells.set(k, new Set());
        roadCells.get(k).add(ei * 10000 + i);
      }
  }
});
function roadClearance(x, z) {
  // Distance from point to the nearest road edge (centerline distance minus half width).
  let best = Infinity, bestEdge = -1, bestT = null;
  const set = roadCells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!set) return { d: Infinity, edge: -1 };
  for (const packed of set) {
    const ei = Math.floor(packed / 10000), i = packed % 10000;
    const e = edges[ei];
    const [ax, az] = e.pts[i - 1], [bx, bz] = e.pts[i];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z) - e.width / 2;
    if (d < best) { best = d; bestEdge = ei; bestT = [ax + dx * t, az + dz * t]; }
  }
  return { d: best, edge: bestEdge, at: bestT };
}

// ------------------------------------------------------------------ buildings
const buildings = [];
const bldCells = new Map();
const addBldIndex = (b, id) => {
  const k = cellKey(Math.floor(b.cx / CELL), Math.floor(b.cz / CELL));
  if (!bldCells.has(k)) bldCells.set(k, []);
  bldCells.get(k).push(id);
};
const nearBuilding = (x, z, r) => {
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const list = bldCells.get(cellKey(Math.floor(x / CELL) + dx, Math.floor(z / CELL) + dz));
    if (!list) continue;
    for (const id of list) { const b = buildings[id]; if (Math.hypot(b.cx - x, b.cz - z) < r + b.r) return true; }
  }
  return false;
};
const inWater = (x, z) => waterPolys.some((w) => pointInPoly([x, z], w.poly));
const coverAt = (x, z) => {
  for (const c of landcover) {
    if (c.k === 'parking') continue;
    const poly = [];
    for (let i = 0; i < c.p.length; i += 2) poly.push([c.p[i], c.p[i + 1]]);
    if (pointInPoly([x, z], poly)) return c.k;
  }
  return '';
};
const INSTITUTIONAL = new Set(['school', 'university', 'college', 'church', 'chapel', 'public', 'civic', 'hospital', 'government', 'library', 'fire_station']);
const COMMERCIAL = new Set(['commercial', 'retail', 'office', 'hotel', 'supermarket', 'industrial', 'warehouse']);
for (const w of ways.values()) {
  const t = w.tags ?? {};
  if (!t.building || t.building === 'no' || w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue;
  let poly = toPoly(w.nodes);
  if (poly.length < 3) continue;
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  if (!inside([cx, cz])) continue;
  poly = dpSimplify(poly.concat([poly[0]]), 0.4).slice(0, -1);
  if (poly.length < 3) continue;
  let a = area(poly);
  if (Math.abs(a) < 12) continue;
  if (a < 0) { poly.reverse(); a = -a; }
  const b = t.building;
  const kind = INSTITUTIONAL.has(b) || t.amenity === 'school' ? 'i' : COMMERCIAL.has(b) ? 'c' : ['garage', 'garages', 'shed', 'barn', 'farm_auxiliary', 'carport'].includes(b) ? 's' : ['house', 'detached', 'residential', 'apartments', 'semidetached_house'].includes(b) ? 'h' : 'y';
  const out = { p: poly.flatMap((q) => [r1(q[0]), r1(q[1])]), k: kind, cx: r1(cx), cz: r1(cz), r: r1(Math.sqrt(a / Math.PI)) };
  const levels = Number.parseFloat(t['building:levels']), height = Number.parseFloat(t.height);
  if (Number.isFinite(height)) out.h = r1(height); else if (Number.isFinite(levels)) out.l = levels;
  if (t.name) out.n = t.name;
  if (b === 'barn') out.barn = 1;
  addBldIndex(out, buildings.length);
  buildings.push(out);
}
const osmBuildings = buildings.length;

// Deterministic RNG for generated placements.
let seed = 1337;
const rnd = () => { let t = (seed += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rectPoly = (cx, cz, ax, az, hl, hw) => {
  const bx = -az, bz = ax;
  return [[cx + ax * hl + bx * hw, cz + az * hl + bz * hw], [cx - ax * hl + bx * hw, cz - az * hl + bz * hw], [cx - ax * hl - bx * hw, cz - az * hl - bz * hw], [cx + ax * hl - bx * hw, cz + az * hl - bz * hw]];
};
const addGenerated = (cx, cz, faceX, faceZ, hl, hw, kind, extra = {}) => {
  // Long axis along the street; faceX/Z points from house to street.
  let poly = rectPoly(cx, cz, -faceZ, faceX, hl, hw);
  if (area(poly) < 0) poly = poly.reverse();
  const out = { p: poly.flat().map(r1), k: kind, cx: r1(cx), cz: r1(cz), r: r1(Math.max(hl, hw)), gen: 1, fx: r2(faceX), fz: r2(faceZ), ...extra };
  addBldIndex(out, buildings.length);
  buildings.push(out);
};

// 1. Estate houses at the ends of private driveways (Chenequa's lakefront estates).
let estates = 0;
for (const w of ways.values()) {
  const t = w.tags ?? {};
  if (t.highway !== 'service' || t.service !== 'driveway') continue;
  const pts = w.nodes.map(P).filter(Boolean);
  if (pts.length < 2) continue;
  // The end farther from a public road is the house end.
  const a = pts[0], b = pts[pts.length - 1];
  const ca = roadClearance(a[0], a[1]).d, cb = roadClearance(b[0], b[1]).d;
  const [end, prev] = ca > cb ? [a, pts[1]] : [b, pts[pts.length - 2]];
  if (!inside(end, -30)) continue;
  let fx = prev[0] - end[0], fz = prev[1] - end[1];
  const l = Math.hypot(fx, fz) || 1;
  fx /= l; fz /= l;
  const big = w.tags.access === 'private';
  const hw = big ? 7 + rnd() * 4 : 5 + rnd() * 2.5, hl = big ? 9 + rnd() * 6 : 6 + rnd() * 3;
  const cx = end[0] - fx * (hw + 3), cz = end[1] - fz * (hw + 3);
  if (roadClearance(cx, cz).d < hw + 6 || nearBuilding(cx, cz, hl + 4) || inWater(cx, cz)) continue;
  addGenerated(cx, cz, fx, fz, hl, hw, 'h', { est: big ? 1 : 0, drive: pts.flat().map(r1) });
  estates++;
}
// 2. Houses along residential streets where OSM has no footprints yet.
let streetHouses = 0;
for (const e of edges) {
  if (!['residential', 'unclassified', 'living_street', 'tertiary'].includes(e.cls) || e.bridge) continue;
  const total = e.cum[e.cum.length - 1];
  if (total < 40) continue;
  for (const side of [-1, 1]) {
    let s = 14 + rnd() * 10;
    while (s < total - 14) {
      // Point and direction along the polyline.
      let i = 1;
      while (i < e.cum.length - 1 && e.cum[i] < s) i++;
      const t = (s - e.cum[i - 1]) / ((e.cum[i] - e.cum[i - 1]) || 1);
      const px = e.pts[i - 1][0] + (e.pts[i][0] - e.pts[i - 1][0]) * t, pz = e.pts[i - 1][1] + (e.pts[i][1] - e.pts[i - 1][1]) * t;
      let dx = e.pts[i][0] - e.pts[i - 1][0], dz = e.pts[i][1] - e.pts[i - 1][1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const rx = -dz * side, rz = dx * side;
      const hw = 4.5 + rnd() * 2, hl = 6 + rnd() * 3.5;
      const setback = e.width / 2 + 9 + rnd() * 6 + hw;
      const cx = px + rx * setback, cz = pz + rz * setback;
      const cover = coverAt(cx, cz);
      const ok = inside([cx, cz], -20) && cover !== 'farm' && cover !== 'wetland' && cover !== 'commercial' && cover !== 'park'
        && roadClearance(cx, cz).d > hw + 7 && !nearBuilding(cx, cz, hl + 3) && !inWater(cx, cz) && !inWater(cx + rx * 12, cz + rz * 12);
      // Chenequa's woods are sparse along through-roads; Hartland's streets are lined.
      if (ok && (cover === 'residential' || e.cls === 'residential' || rnd() < 0.35)) {
        addGenerated(cx, cz, -rx, -rz, hl, hw, 'h');
        streetHouses++;
      }
      s += 26 + rnd() * 14;
    }
  }
}
// 3. Docks on lakefront houses.
const docks = [];
for (const b of buildings) {
  if (!b.gen && b.k !== 'h') continue;
  for (const w of waterPolys) {
    if (w.level === undefined || Math.abs(area(w.poly)) < 40000) continue;
    // Nearest shore point within 70 m.
    let best = Infinity, bp = null;
    for (let i = 0; i < w.poly.length; i++) {
      const a = w.poly[i], c = w.poly[(i + 1) % w.poly.length];
      const dx = c[0] - a[0], dz = c[1] - a[1], l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((b.cx - a[0]) * dx + (b.cz - a[1]) * dz) / l2));
      const d = Math.hypot(a[0] + dx * t - b.cx, a[1] + dz * t - b.cz);
      if (d < best) { best = d; bp = [a[0] + dx * t, a[1] + dz * t]; }
    }
    if (best < 70 && bp && roadClearance(bp[0], bp[1]).d > 8) {
      const dx = (bp[0] - b.cx) / best, dz = (bp[1] - b.cz) / best;
      docks.push({ x: r1(bp[0]), z: r1(bp[1]), dx: r2(dx), dz: r2(dz), len: r1(14 + rnd() * 16), y: r2(w.level) });
      break;
    }
  }
}

// ------------------------------------------------------------------ rail, streams, landmarks
const rail = [];
for (const w of ways.values()) {
  const t = w.tags ?? {};
  if (t.railway !== 'rail') continue;
  const pts = w.nodes.map(P).filter((p) => p && inside(p, 50));
  if (pts.length >= 2) rail.push({ n: t.name ?? t.operator ?? '', br: t.bridge === 'yes' ? 1 : 0, pts: dpSimplify(pts, 1).flatMap((p) => [r1(p[0]), r1(p[1])]) });
}
const streams = [];
for (const w of ways.values()) {
  const t = w.tags ?? {};
  if (!['river', 'stream'].includes(t.waterway) || t.tunnel === 'culvert' || t.tunnel === 'yes') continue;
  const pts = w.nodes.map(P).filter((p) => p && inside(p));
  if (pts.length >= 2) streams.push({ n: t.name ?? '', w: t.waterway === 'river' ? 9 : 3, pts: dpSimplify(pts, 1.5).flatMap((p) => [r1(p[0]), r1(p[1])]) });
}
const landmarks = [];
const seen = new Set();
for (const el of [...ways.values(), ...nodes.values()]) {
  const t = el.tags ?? {};
  if (!t.name || seen.has(t.name)) continue;
  const kind = ['school', 'library', 'townhall', 'place_of_worship', 'fire_station', 'police'].includes(t.amenity) ? t.amenity : ['village', 'town', 'hamlet', 'neighbourhood'].includes(t.place) ? 'place' : null;
  if (!kind) continue;
  let p;
  if (el.type === 'node') p = project(el.lat, el.lon);
  else { const poly = toPoly(el.nodes); if (!poly.length) continue; p = [poly.reduce((s, q) => s + q[0], 0) / poly.length, poly.reduce((s, q) => s + q[1], 0) / poly.length]; }
  if (!inside(p)) continue;
  seen.add(t.name);
  landmarks.push({ name: t.name, kind, x: r1(p[0]), z: r1(p[1]) });
}
for (const w of waterPolys) if (w.name && !seen.has(w.name)) {
  seen.add(w.name);
  const cx = w.poly.reduce((s, q) => s + q[0], 0) / w.poly.length, cz = w.poly.reduce((s, q) => s + q[1], 0) / w.poly.length;
  landmarks.push({ name: w.name, kind: 'lake', x: r1(cx), z: r1(cz) });
}

// ------------------------------------------------------------------ write
const metaPath = path.join(path.dirname(INPUT), `${MAP.file}.meta.json`);
const fetchMeta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
// Heights in centimeters as little-endian Uint16, base64 in JSON (static hosts that
// only serve web types, such as claude.ai artifacts, will not serve a raw .bin).
const terrainFile = OUT.replace(/\.json$/, '-terrain.json');
const q = new Uint16Array(gw * gh);
for (let i = 0; i < q.length; i++) q[i] = Math.max(0, Math.min(65535, Math.round(heights[i] * 100)));
fs.writeFileSync(terrainFile, JSON.stringify({ format: 'u16le-base64', width: gw, height: gh, data: Buffer.from(q.buffer).toString('base64') }));

const out = {
  meta: {
    title: MAP.title,
    map: MAP.id,
    verticalScale: MAP.vscale,
    attribution: '© OpenStreetMap contributors',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
    terrainAttribution: 'Elevation: USGS 3DEP via AWS Terrain Tiles (Terrarium)',
    license: 'ODbL-1.0 (see LICENSE-ODbL-1.0.txt)',
    source: fetchMeta?.endpoint ?? 'Overpass API',
    snapshot: fetchMeta?.fetchedAt ?? null,
    crop: { south: CROP.s, west: CROP.w, north: CROP.n, east: CROP.e },
    anchor: { ...ORIGIN, label: 'Fixed local origin' },
    elevationBase: base,
    convertedAt: new Date().toISOString(),
    command: `node scripts/convert-lakecountry.mjs --map ${MAP.id}`,
    counts: { nodes: outNodes.length, edges: edges.length, bridges: edges.filter((e) => e.bridge).length, osmBuildings, estates, streetHouses, docks: docks.length, water: waterPolys.length, landcover: landcover.length },
  },
  bounds: { minX: r1(minX), maxX: r1(maxX), minZ: r1(minZ), maxZ: r1(maxZ) },
  terrain: { file: path.basename(terrainFile), width: gw, height: gh, spacing: GRID, originX: r1(minX), originZ: r1(minZ), scale: 0.01 },
  nodes: outNodes,
  nodeY: nodeY.map(r2),
  edges: edges.map((e) => ({
    a: e.a, b: e.b, way: e.way, name: e.name, cls: e.cls, w: e.width, lf: e.lf, lb: e.lb, ow: e.oneway, br: e.bridge, ly: e.layer, sp: e.speed,
    pts: e.pts.flatMap((p) => [r1(p[0]), r1(p[1])]), ys: e.ys.map(r2),
  })),
  boundaryExits: outNodes.map((n, i) => (n[0] < 0 ? i : -1)).filter((i) => i >= 0),
  water: waterPolys.map((w) => ({ name: w.name, level: r2(w.level), outer: w.poly.flatMap((p) => [r1(p[0]), r1(p[1])]), holes: [] })),
  rivers: streams,
  buildings,
  parks: [],
  landcover,
  villages,
  docks,
  rail,
  landmarks,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KiB) and ${terrainFile} (${(q.byteLength / 1024).toFixed(0)} KiB, ${gw}x${gh})`);
console.log(JSON.stringify(out.meta.counts), 'base elevation', base);
