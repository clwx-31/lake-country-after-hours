// Builds Ironport, the third level: a fictional city made for police chases.
// Nothing here comes from real map data. The street grid is 150 m blocks; three
// avenues dive into covered tunnels between at-grade intersections, an elevated
// ring circles downtown, and two viaducts cross above it at the Stack, with
// ramps between every level. Output uses the same district format as
// convert-lakecountry.mjs, plus `under` (tunnel walls, lids, copings, barriers).
//
// Usage: node scripts/build-ironport.mjs
// Output: public/data/ironport.json and public/data/ironport-terrain.json
// Coordinates: meters, +X east, +Z south, Y up. Street level is Y = 30.
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'public/data/ironport.json';

// ------------------------------------------------------------------ constants
const Y0 = 30; // street level
const TUN = 20; // tunnel floor
const RING = 40, VIA = 48, HIGH = 56; // elevated decks
const G = 150; // block pitch
const LIM = 1650; // outermost streets
const EXT = 1800; // map edge
const SPACING = 8; // terrain grid (m)
const FLOOR_HW = 10; // tunnel floor half-width: 16 m road plus shoulders
// Terrain steps from the trench floor up to street level at STEP (hidden under
// the copings). With an 8 m grid the floor is exact out to FLOOR_HW and the
// street exact beyond CORR.
const STEP = 22;
const CORR = 34;
const BRIDGE = CORR + 1; // cross streets bridge this far either side of a tunnel
const RAMP = 200; // tunnel ramp length
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a, b, t) => a + (b - a) * t;
/** 0..1 along a ramp of length L: parabolic transitions of length e, constant grade between. */
const easeRamp = (s, L, e) => {
  if (s <= 0) return 0;
  if (s >= L) return 1;
  const k = L - e;
  if (s < e) return (s * s) / (2 * e) / k;
  if (s > L - e) return 1 - ((L - s) * (L - s)) / (2 * e) / k;
  return (s - e / 2) / k;
};

let seed = 20261124;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const range = (a, b) => a + (b - a) * rand();
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ------------------------------------------------------------------ tunnels
// axis 'x': runs east-west at z = at. Stations are at-grade intersections; between
// them the road dives, runs covered, and climbs back. Skylights are open slots.
const TUNNELS = [
  { name: 'Canal Underway', axis: 'x', at: 450, stations: [-1650, -900, 0, 900, 1650], skylights: [-1275, -225, 525, 1275] },
  { name: 'Market Underway', axis: 'z', at: -450, stations: [-1650, -900, 0, 900, 1650], skylights: [-1275, -525, 225, 1275] },
  { name: 'Bessemer Underway', axis: 'x', at: -900, stations: [-1650, -450, 450, 1650], skylights: [-1275, -825, -225, 225, 825, 1275] },
];
const TD = Y0 - TUN;
function tunnelDepth(t, a) {
  const st = t.stations;
  for (let k = 0; k + 1 < st.length; k++) {
    const A = st[k], B = st[k + 1];
    if (a >= A && a <= B) return TD * Math.min(smooth((a - A) / RAMP), smooth((B - a) / RAMP));
  }
  return 0;
}
function tunnelCovered(t, a) {
  const st = t.stations;
  for (let k = 0; k + 1 < st.length; k++) {
    const A = st[k], B = st[k + 1];
    if (a >= A + 165 && a <= B - 165) return !t.skylights.some((c) => Math.abs(a - c) <= 25);
  }
  return false;
}
const tunnelOnLine = (axis, at) => TUNNELS.find((t) => t.axis === axis && t.at === at);
// Tunnel frame: along / lateral for a point.
const tAlong = (t, x, z) => (t.axis === 'x' ? x : z);
const tLat = (t, x, z) => (t.axis === 'x' ? z - t.at : x - t.at);

// ------------------------------------------------------------------ graph
const nodes = []; // { id, x, z, y }
const nodeIdx = new Map();
const levelCode = (y) => (y < Y0 - 0.5 ? 1 : y < Y0 + 0.5 ? 0 : y < 44 ? 2 : y < 52 ? 3 : 4);
/** Stable junction ids from position and level, so events and venues can name them. */
const nodeId = (x, z, y = Y0) => levelCode(y) * 1e8 + (Math.round(x) + 2000) * 1e4 + (Math.round(z) + 2000);
function node(x, z, y) {
  const id = nodeId(x, z, y);
  let i = nodeIdx.get(id);
  if (i === undefined) {
    i = nodes.length;
    nodes.push({ id, x, z, y });
    nodeIdx.set(id, i);
  } else if (Math.abs(nodes[i].x - x) > 0.6 || Math.abs(nodes[i].z - z) > 0.6 || Math.abs(nodes[i].y - y) > 0.6) {
    throw new Error(`node ${id} reused at a different spot`);
  }
  return i;
}

/** A road: dense points [x, z, y] with some marked as junctions. */
const roads = [];
function road(props, pts, isNode, bridgeSeg = () => null) {
  roads.push({ ...props, pts, isNode, bridgeSeg });
}

// ------------------------------------------------------------------ street names
const NS_AVE = { '-9': 'Foundry Avenue', '-6': 'Union Avenue', '0': 'Central Avenue', '3': 'Signal Avenue', '6': 'Kettle Avenue', '9': 'Dock Avenue' };
const NS_ST = ['Ash Street', 'Birch Street', 'Cedar Street', 'Elm Street', 'Fir Street', 'Hazel Street', 'Juniper Street', 'Larch Street', 'Maple Street', 'Oak Street', 'Pine Street', 'Spruce Street', 'Walnut Street', 'Willow Street'];
const EW_AVE = { '-9': 'Northgate Avenue', '-3': 'Mill Avenue', '0': 'Main Street', '6': 'Rail Avenue', '9': 'Harbor Avenue' };
const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th', '13th', '14th', '15th'];
let nsCount = 0, ewCount = 0;
const nsName = (i) => (i === -11 ? 'West Perimeter Road' : i === 11 ? 'East Perimeter Road' : NS_AVE[i] ?? NS_ST[nsCount++]);
const ewName = (j) => (j === -11 ? 'North Perimeter Road' : j === 11 ? 'South Perimeter Road' : EW_AVE[j] ?? `${ORD[ewCount++]} Street`);
const isAve = (i) => i % 3 === 0;
function streetProps(i, name) {
  if (Math.abs(i) === 11) return { name, cls: 'secondary', w: 14, lf: 2, lb: 2, ow: 0, sp: 45 };
  if (isAve(i)) return { name, cls: 'primary', w: 16, lf: 2, lb: 2, ow: 0, sp: 40 };
  return { name, cls: 'tertiary', w: 11, lf: 1, lb: 1, ow: 0, sp: 30 };
}

// Extra at-grade junctions on streets where ramps land: key `${axis}:${line}` -> positions.
const landings = new Map();
const addLanding = (axis, line, pos) => {
  const k = `${axis}:${line}`;
  if (!landings.has(k)) landings.set(k, []);
  landings.get(k).push(pos);
};

// ------------------------------------------------------------------ elevated
const ELEV = [];
const elevated = (props, pts, nodeAt) => ELEV.push({ props, pts, nodeAt });

/** Straight elevated line along an axis with descents to street level at both ends. */
function viaductLine(axis, at, h, name, nodePos) {
  // A steady grade with short eased ends, so the deck is still high over the last
  // cross street before it lands.
  const L = h - Y0 > 20 ? 380 : 300;
  const D1 = LIM, D0 = D1 - L;
  const yAt = (a) => (Math.abs(a) <= D0 ? h : lerp(h, Y0, easeRamp(Math.abs(a) - D0, L, 40)));
  const stops = new Set(nodePos);
  for (let a = -D1; a <= D1; a += 10) if (Math.abs(a) >= D0 || a % 50 === 0) stops.add(a);
  stops.add(-D0); stops.add(D0);
  const list = [...stops].sort((p, q) => p - q);
  const pts = list.map((a) => (axis === 'x' ? [a, at, yAt(a)] : [at, a, yAt(a)]));
  elevated({ name, cls: 'primary', w: 20, lf: 3, lb: 3, ow: 0, sp: 65 }, pts, (p, i) => i === 0 || i === pts.length - 1 || nodePos.includes(axis === 'x' ? p[0] : p[1]));
  // Both ends land on the perimeter roads.
  const crossAxis = axis === 'x' ? 'z' : 'x';
  addLanding(crossAxis, -D1, at);
  addLanding(crossAxis, D1, at);
}

// Skyway ring: a rounded square at the mid-block lines x, z = +-975.
const RS = 975, RR = 150;
const ringNodes = [
  // side ramps (diverge points)
  [975, -560], [975, 560], [-975, -560], [-975, 560], [-560, -975], [560, -975], [-560, 975], [560, 975],
  // connectors from the viaduct and the highline
  [975, 225], [-975, -375], [475, 975], [-325, -975],
];
{
  const pts = [];
  const side = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.ceil(len / 25);
    const on = ringNodes.filter(([x, z]) => (x0 === x1 ? x === x0 && (z - z0) * (z - z1) < 0 : z === z0 && (x - x0) * (x - x1) < 0));
    const ts = new Set();
    for (let k = 0; k < n; k++) ts.add(k / n);
    for (const [x, z] of on) ts.add(x0 === x1 ? (z - z0) / (z1 - z0) : (x - x0) / (x1 - x0));
    for (const t of [...ts].sort((a, b) => a - b)) pts.push([lerp(x0, x1, t), lerp(z0, z1, t), RING]);
  };
  const arc = (cx, cz, a0, a1) => {
    const n = 18;
    for (let k = 0; k < n; k++) {
      const a = lerp(a0, a1, k / n);
      pts.push([cx + RR * Math.cos(a), cz + RR * Math.sin(a), RING]);
    }
  };
  const I = RS - RR;
  side(RS, -I, RS, I); arc(I, I, 0, Math.PI / 2);
  side(I, RS, -I, RS); arc(-I, I, Math.PI / 2, Math.PI);
  side(-RS, I, -RS, -I); arc(-I, -I, Math.PI, Math.PI * 1.5);
  side(-I, -RS, I, -RS); arc(I, -I, Math.PI * 1.5, Math.PI * 2);
  pts.push([...pts[0]]);
  const isRingNode = (p) => ringNodes.some(([x, z]) => Math.abs(p[0] - x) < 0.01 && Math.abs(p[1] - z) < 0.01);
  elevated({ name: 'Skyway Loop', cls: 'primary', w: 21, lf: 3, lb: 3, ow: 0, sp: 65 }, pts, (p) => isRingNode(p));
}

viaductLine('x', -75, VIA, 'Crosstown Viaduct', [-675, -225, 375, 675]);
viaductLine('z', 75, HIGH, 'Highline', [-575, -375, 225, 575]);

/** Arc connector between two elevated lines it is tangent to; flat while it overlaps either. */
function arcConnector(name, cx, cz, R, a0, a1, h0, h1) {
  const L = R * Math.abs(a1 - a0);
  const flat = R * Math.acos(1 - 21 / R); // stays level until 21 m clear of the parent deck
  const n = Math.ceil(L / 6);
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const s = (k / n) * L;
    const a = lerp(a0, a1, k / n);
    const y = lerp(h0, h1, smooth((s - flat) / (L - 2 * flat)));
    pts.push([cx + R * Math.cos(a), cz + R * Math.sin(a), y]);
  }
  pts[0][0] = Math.round(pts[0][0]); pts[0][1] = Math.round(pts[0][1]);
  pts[n][0] = Math.round(pts[n][0]); pts[n][1] = Math.round(pts[n][1]);
  elevated({ name, cls: 'secondary', w: 11, lf: 1, lb: 1, ow: 0, sp: 50 }, pts, (_p, i) => i === 0 || i === n);
}
const D = Math.PI / 180;
// The Stack: four connectors between the Highline (56) and the Crosstown Viaduct (48).
arcConnector('Stack Ramp NE', 375, -375, 300, 180 * D, 90 * D, HIGH, VIA);
arcConnector('Stack Ramp SE', 375, 225, 300, 180 * D, 270 * D, HIGH, VIA);
arcConnector('Stack Ramp SW', -225, 225, 300, 0, -90 * D, HIGH, VIA);
arcConnector('Stack Ramp NW', -225, -375, 300, 0, 90 * D, HIGH, VIA);
// Viaduct and Highline down to the Skyway.
arcConnector('Skyway Ramp East', 675, 225, 300, 270 * D, 360 * D, VIA, RING);
arcConnector('Skyway Ramp West', -675, -375, 300, 90 * D, 180 * D, VIA, RING);
arcConnector('Skyway Ramp South', 475, 575, 400, 180 * D, 90 * D, HIGH, RING);
arcConnector('Skyway Ramp North', -325, -575, 400, 0, -90 * D, HIGH, RING);

/** Side ramp: leaves the ring sideways, runs beside it and lands on a cross street. */
function sideRamp(name, x0, z0, fx, fz, ox, oz) {
  const pts = [];
  const OFF = 19, SEP = 80, DESC = 180;
  for (let s = 0; s <= SEP + DESC + 0.01; s += s < SEP ? 5 : 10) {
    const off = OFF * smooth(s / SEP);
    const y = s <= SEP ? RING : lerp(RING, Y0, smooth((s - SEP) / DESC));
    pts.push([x0 + fx * s + ox * off, z0 + fz * s + oz * off, y]);
  }
  const last = pts[pts.length - 1];
  last[0] = Math.round(last[0]); last[1] = Math.round(last[1]); last[2] = Y0;
  elevated({ name, cls: 'secondary', w: 10, lf: 1, lb: 1, ow: 0, sp: 40 }, pts, (_p, i) => i === 0 || i === pts.length - 1);
  // Landing on the cross street it meets.
  if (fx === 0) addLanding('x', last[1], last[0]); else addLanding('z', last[0], last[1]);
}
sideRamp('Skyway Ramp', 975, -560, 0, 1, 1, 0);
sideRamp('Skyway Ramp', 975, 560, 0, -1, 1, 0);
sideRamp('Skyway Ramp', -975, -560, 0, 1, -1, 0);
sideRamp('Skyway Ramp', -975, 560, 0, -1, -1, 0);
sideRamp('Skyway Ramp', -560, -975, 1, 0, 0, -1);
sideRamp('Skyway Ramp', 560, -975, -1, 0, 0, -1);
sideRamp('Skyway Ramp', -560, 975, 1, 0, 0, 1);
sideRamp('Skyway Ramp', 560, 975, -1, 0, 0, 1);

// ------------------------------------------------------------------ surface streets
// axis 'x' street runs east-west at z = line; 'z' runs north-south at x = line.
for (const axis of ['z', 'x']) {
  for (let i = -11; i <= 11; i++) {
    const line = i * G;
    if (tunnelOnLine(axis === 'z' ? 'z' : 'x', line)) continue; // that avenue is a tunnel line
    const props = streetProps(i, axis === 'z' ? nsName(i) : ewName(i));
    const stops = new Map(); // along -> { node: bool, bridge?: boolean }
    for (let k = -11; k <= 11; k++) {
      const a = k * G;
      const cross = TUNNELS.find((t) => t.axis !== (axis === 'z' ? 'z' : 'x') && t.at === a);
      if (!cross) { stops.set(a, 'node'); continue; }
      const dep = tunnelDepth(cross, line);
      if (dep < 0.05) { stops.set(a, 'node'); continue; }
      stops.set(a - BRIDGE, 'node');
      stops.set(a + BRIDGE, 'node');
    }
    for (const p of landings.get(`${axis}:${line}`) ?? []) stops.set(p, 'node');
    const list = [...stops.keys()].filter((a) => a >= -LIM && a <= LIM).sort((p, q) => p - q);
    const pts = list.map((a) => (axis === 'z' ? [line, a, Y0] : [a, line, Y0]));
    // Bridge segments: between the two split points around a tunnel crossing.
    const bridgeSeg = (p, q) => {
      const ap = axis === 'z' ? p[1] : p[0], aq = axis === 'z' ? q[1] : q[0];
      const mid = (ap + aq) / 2;
      const t = TUNNELS.find((tt) => tt.axis !== (axis === 'z' ? 'z' : 'x') && Math.abs(tt.at - mid) < 1 && Math.abs(aq - ap - 2 * BRIDGE) < 1);
      return t ? { tunnel: t } : null;
    };
    road(props, pts, () => true, bridgeSeg);
  }
}

// ------------------------------------------------------------------ tunnel roads
for (const t of TUNNELS) {
  const stops = new Set();
  for (let a = -LIM; a <= LIM; a += 10) stops.add(a);
  const crossings = [];
  for (const o of TUNNELS) {
    if (o === t || o.axis === t.axis) continue;
    // Crossing point: along this tunnel at o.at.
    const a = o.at, b = t.at;
    const dt = tunnelDepth(t, a), dO = tunnelDepth(o, b);
    if (dt > 0.05 && dO > 0.05) {
      if (Math.abs(dt - dO) > 0.01 || Math.abs(dt - TD) > 0.01) throw new Error(`${t.name} meets ${o.name} mid-ramp`);
      crossings.push(a);
    } else if ((dt > 0.05) !== (dO > 0.05)) throw new Error(`${t.name} and ${o.name} cross at different depths`);
  }
  const pts = [...stops].sort((p, q) => p - q).map((a) => {
    const y = Y0 - tunnelDepth(t, a);
    return t.axis === 'x' ? [a, t.at, y] : [t.at, a, y];
  });
  const nodeAlong = new Set([...t.stations, ...crossings]);
  road({ name: t.name, cls: 'primary', w: 16, lf: 2, lb: 2, ow: 0, sp: 50, tunnel: t }, pts, (p) => nodeAlong.has(t.axis === 'x' ? p[0] : p[1]));
}

for (const e of ELEV) road(e.props, e.pts, e.nodeAt);

// ------------------------------------------------------------------ edges
const edges = [];
for (const r of roads) {
  const idx = [];
  r.pts.forEach((p, i) => { if (i === 0 || i === r.pts.length - 1 || r.isNode(p, i)) idx.push(i); });
  for (let k = 0; k + 1 < idx.length; k++) {
    const seg = r.pts.slice(idx[k], idx[k + 1] + 1);
    const p = seg[0], q = seg[seg.length - 1];
    const a = node(p[0], p[1], p[2]), b = node(q[0], q[1], q[2]);
    const maxY = Math.max(...seg.map((s) => s[2])), minY = Math.min(...seg.map((s) => s[2]));
    const over = r.bridgeSeg(p, q);
    const br = maxY > Y0 + 0.3 || over ? 1 : 0;
    const lv = minY < Y0 - 0.3 ? -1 : maxY < Y0 + 0.3 ? 0 : maxY < 44 ? 1 : maxY < 52 ? 2 : 3;
    edges.push({
      a, b, way: roads.indexOf(r) + 1, name: r.name, cls: r.cls, w: r.w, lf: r.lf, lb: r.lb, ow: r.ow, br, ly: lv, sp: r.sp,
      pts: seg.flatMap((s) => [r1(s[0]), r1(s[1])]), ys: seg.map((s) => r2(s[2])), lv,
    });
  }
}
// Merge duplicate parallel edges (none expected) and drop zero-length ones.
for (const e of edges) if (e.a === e.b && e.pts.length <= 4) throw new Error(`zero-length edge ${e.name}`);

// ------------------------------------------------------------------ validation
const problems = [];
const segs = []; // sampled every ~3 m: { e, x, z, y, hw }
const CELL = 24;
const grid = new Map();
edges.forEach((e, ei) => {
  const p = e.pts, ys = e.ys;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
    const ya = ys[i / 2], yb = ys[i / 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len > 0.5 && Math.abs(yb - ya) / len > 0.115) problems.push(`steep: ${e.name} ${(Math.abs(yb - ya) / len * 100).toFixed(1)}% near ${r1(ax)},${r1(az)}`);
    const n = Math.max(1, Math.ceil(len / 3));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const s = { e: ei, x: lerp(ax, bx, t), z: lerp(az, bz, t), y: lerp(ya, yb, t), hw: e.w / 2 + (e.br ? 1.4 : 1) };
      segs.push(s);
      const key = `${Math.floor(s.x / CELL)},${Math.floor(s.z / CELL)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(s);
    }
  }
});
const sharesNode = (e1, e2) => {
  const A = edges[e1], B = edges[e2];
  return A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b;
};
let checked = 0;
const bad = new Set();
for (const s of segs) {
  const cx = Math.floor(s.x / CELL), cz = Math.floor(s.z / CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const o of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
      if (o.e <= s.e) continue;
      const d = Math.hypot(o.x - s.x, o.z - s.z);
      if (d > s.hw + o.hw) continue;
      checked++;
      const dy = Math.abs(o.y - s.y);
      if (dy < 1.0) continue; // same level (junctions, merges)
      // Decks need room above whatever passes underneath.
      const lower = o.y < s.y ? o : s, upper = o.y < s.y ? s : o;
      const clearance = upper.y - 1.4 - lower.y;
      if (clearance >= 5.0) continue;
      const key = `${Math.min(s.e, o.e)}-${Math.max(s.e, o.e)}`;
      if (bad.has(key)) continue;
      bad.add(key);
      problems.push(`clash: ${edges[s.e].name} (y ${r1(s.y)}) and ${edges[o.e].name} (y ${r1(o.y)}) at ${r1(s.x)},${r1(s.z)}${sharesNode(s.e, o.e) ? ' [share a node]' : ''}`);
    }
  }
}
// Every junction reachable from the middle of town.
{
  const adj = nodes.map(() => []);
  edges.forEach((e) => { adj[e.a].push(e.b); adj[e.b].push(e.a); });
  const seen = new Uint8Array(nodes.length);
  const stack = [nodeIdx.get(nodeId(0, 0))];
  seen[stack[0]] = 1;
  while (stack.length) { const v = stack.pop(); for (const w of adj[v]) if (!seen[w]) { seen[w] = 1; stack.push(w); } }
  nodes.forEach((n, i) => { if (!seen[i]) problems.push(`unreachable junction ${n.id} at ${n.x},${n.z},${n.y}`); });
  nodes.forEach((n, i) => { if (adj[i].length === 1 && Math.abs(n.x) < LIM && Math.abs(n.z) < LIM) problems.push(`dead end at ${n.x},${n.z},${n.y}`); });
}

// ------------------------------------------------------------------ terrain
const gw = Math.round((2 * EXT) / SPACING) + 1, gh = gw;
const originX = -EXT, originZ = -EXT;
const H = new Float32Array(gw * gh).fill(Y0);
for (const t of TUNNELS) {
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const x = originX + i * SPACING, z = originZ + j * SPACING;
    const lat = Math.abs(tLat(t, x, z));
    if (lat > STEP) continue;
    const dep = tunnelDepth(t, tAlong(t, x, z));
    if (dep <= 0) continue;
    H[j * gw + i] = Math.min(H[j * gw + i], Y0 - dep);
  }
}

// ------------------------------------------------------------------ underground: 1 m raster
// Cells: floor (inside a tunnel's floor), lid (floor under a roof), coping (street-level
// slab over the hidden terrain step). Walls run along floor boundaries.
const RW = 2 * EXT;
const FLOOR = 1, LID = 2, COPE = 4;
const cellsAt = new Uint8Array(RW * RW);
const floorY = new Float32Array(RW * RW).fill(Y0);
for (const t of TUNNELS) {
  for (let a = -LIM; a < LIM; a++) {
    const ac = a + 0.5;
    const dep = tunnelDepth(t, ac);
    if (dep <= 0.05) continue;
    const cov = tunnelCovered(t, ac);
    for (let l = -CORR; l < CORR; l++) {
      const lc = l + 0.5;
      const x = t.axis === 'x' ? ac : t.at + lc, z = t.axis === 'x' ? t.at + lc : ac;
      const ci = Math.floor(x) + EXT, cj = Math.floor(z) + EXT;
      const k = cj * RW + ci;
      if (Math.abs(lc) < FLOOR_HW) {
        cellsAt[k] |= FLOOR;
        if (cov) cellsAt[k] |= LID;
        floorY[k] = Math.min(floorY[k], Y0 - dep);
      } else cellsAt[k] |= COPE;
    }
  }
}
// A floor cell is never a coping cell; lid only over floor.
for (let k = 0; k < cellsAt.length; k++) if (cellsAt[k] & FLOOR) cellsAt[k] &= ~COPE;

/** Merge cells matching `want` into rectangles (row runs, then stacked runs). */
function rects(want) {
  const out = [];
  const open = new Map(); // "i0,i1" -> rect being grown downward
  for (let j = 0; j < RW; j++) {
    const runs = [];
    let i = 0;
    while (i < RW) {
      if (!want(cellsAt[j * RW + i])) { i++; continue; }
      const i0 = i;
      while (i < RW && want(cellsAt[j * RW + i])) i++;
      runs.push(`${i0},${i}`);
    }
    const next = new Map();
    for (const r of runs) {
      const cur = open.get(r);
      if (cur) { cur[3] = j + 1; next.set(r, cur); open.delete(r); }
      else { const [i0, i1] = r.split(',').map(Number); const nr = [i0, j, i1, j + 1]; next.set(r, nr); }
    }
    for (const r of open.values()) out.push(r);
    open.clear();
    for (const [k, v] of next) open.set(k, v);
  }
  for (const r of open.values()) out.push(r);
  return out.map(([i0, j0, i1, j1]) => [i0 - EXT, j0 - EXT, i1 - EXT, j1 - EXT]);
}
const lids = rects((c) => (c & LID) !== 0);
const copings = rects((c) => (c & COPE) !== 0);

// Walls: boundaries between floor and non-floor cells, merged along straight runs
// (split every 10 m so the base can follow a ramp).
const walls = [];
const barriers = [];
const isFloor = (i, j) => i >= 0 && j >= 0 && i < RW && j < RW && (cellsAt[j * RW + i] & FLOOR) !== 0;
const yAtCell = (i, j) => floorY[j * RW + i];
// Vertical grid lines x = i (between cell i-1 and i): floor on one side only.
for (let i = 1; i < RW; i++) {
  let run = null;
  const flush = () => { if (run) { walls.push(run.w); run = null; } };
  for (let j = 0; j < RW; j++) {
    const L = isFloor(i - 1, j), R = isFloor(i, j);
    if (L === R) { flush(); continue; }
    const side = L ? -1 : 1; // which side the floor is on (-x or +x)
    const fy = L ? yAtCell(i - 1, j) : yAtCell(i, j);
    const covered = (cellsAt[j * RW + (L ? i - 1 : i)] & LID) !== 0;
    if (run && run.side === side && run.len < 10) {
      run.w[3] = j + 1 - EXT; run.w[5] = fy; run.len++;
      run.cov = run.cov && covered;
    } else {
      flush();
      run = { side, len: 1, cov: covered, w: [i - EXT, j - EXT, i - EXT, j + 1 - EXT, fy, fy, side, 0] };
    }
    run.w[7] = run.cov ? 1 : 0;
  }
  flush();
}
for (let j = 1; j < RW; j++) {
  let run = null;
  const flush = () => { if (run) { walls.push(run.w); run = null; } };
  for (let i = 0; i < RW; i++) {
    const U = isFloor(i, j - 1), Dn = isFloor(i, j);
    if (U === Dn) { flush(); continue; }
    const side = U ? -2 : 2; // floor toward -z or +z
    const fy = U ? yAtCell(i, j - 1) : yAtCell(i, j);
    const covered = (cellsAt[(U ? j - 1 : j) * RW + i] & LID) !== 0;
    if (run && run.side === side && run.len < 10) {
      run.w[2] = i + 1 - EXT; run.w[5] = fy; run.len++;
      run.cov = run.cov && covered;
    } else {
      flush();
      run = { side, len: 1, cov: covered, w: [i - EXT, j - EXT, i + 1 - EXT, j - EXT, fy, fy, side, 0] };
    }
    run.w[7] = run.cov ? 1 : 0;
  }
  flush();
}
// Barriers along open trench edges deeper than 1.5 m (street level side).
for (const w of walls) if (!w[7] && Y0 - Math.max(w[4], w[5]) > 1.5) barriers.push([w[0], w[1], w[2], w[3]]);

// ------------------------------------------------------------------ venues (lots kept clear)
// Mirrors places.ts: anchor from junction `from` toward `to`, `along` meters, building on `side`.
const VENUE_LOTS = [
  { from: [-1200, 150], to: [-1200, 300], along: 70, side: -1, width: 13, depth: 10, setback: 9.5, w: 11 }, // garage, Birch Street
  { from: [-1500, -1350], to: [-1500, -1200], along: 75, side: 1, width: 14, depth: 11, setback: 10, w: 11 }, // lockup, west side
  { from: [1350, 1200], to: [1350, 1350], along: 80, side: 1, width: 14, depth: 12, setback: 6.5, w: 16 }, // the Lantern, Dock Avenue
];
const venueRects = VENUE_LOTS.map((v) => {
  const [ax, az] = v.from, [bx, bz] = v.to;
  const len = Math.hypot(bx - ax, bz - az);
  const fx = (bx - ax) / len, fz = (bz - az) / len;
  const px = ax + fx * v.along, pz = az + fz * v.along;
  // The game's right-of-travel vector for heading h = atan2(dx, dz) is (-cos h, sin h) = (-fz, fx).
  const off = (v.w / 2 + v.setback + v.depth / 2) * v.side;
  return { cx: px - fz * off, cz: pz + fx * off, r: Math.hypot(v.width, v.depth) / 2 + 12 };
});

// ------------------------------------------------------------------ buildings
// Blocks between streets, cut into lots; lots that touch a road, a ramp, a tunnel
// corridor or a venue are dropped or split.
const keepOut = []; // { x, z, r } samples
for (const s of segs) keepOut.push({ x: s.x, z: s.z, r: s.hw + (edges[s.e].br || edges[s.e].lv < 0 ? 7 : 5) });
for (const t of TUNNELS) {
  for (let a = -LIM; a <= LIM; a += 4) {
    if (tunnelDepth(t, a) <= 0.05) continue;
    const x = t.axis === 'x' ? a : t.at, z = t.axis === 'x' ? t.at : a;
    keepOut.push({ x, z, r: CORR + 4 });
  }
}
for (const v of venueRects) keepOut.push({ x: v.cx, z: v.cz, r: v.r });
const KC = 40;
const kgrid = new Map();
for (const k of keepOut) {
  const x0 = Math.floor((k.x - k.r) / KC), x1 = Math.floor((k.x + k.r) / KC), z0 = Math.floor((k.z - k.r) / KC), z1 = Math.floor((k.z + k.r) / KC);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const key = `${x},${z}`;
    if (!kgrid.has(key)) kgrid.set(key, []);
    kgrid.get(key).push(k);
  }
}
function rectClear(x0, z0, x1, z1) {
  const seen = new Set();
  for (let x = Math.floor(x0 / KC); x <= Math.floor(x1 / KC); x++) for (let z = Math.floor(z0 / KC); z <= Math.floor(z1 / KC); z++) {
    for (const k of kgrid.get(`${x},${z}`) ?? []) {
      if (seen.has(k)) continue;
      seen.add(k);
      const dx = Math.max(x0 - k.x, 0, k.x - x1), dz = Math.max(z0 - k.z, 0, k.z - z1);
      if (dx * dx + dz * dz < k.r * k.r) return false;
    }
  }
  return true;
}
const buildings = [];
const TOWER = ['#5d6b78', '#47525e', '#6f7c86', '#8a949b', '#3b4652', '#7d8a8f', '#a3a9ad'];
const BRICK = ['#7a3b2a', '#8a4a33', '#6e3426', '#94593d', '#5e3a2e'];
const WARE = ['#8d8a83', '#6f6a62', '#9a9488', '#5f6468', '#7c705f'];
function addBuilding(x0, z0, x1, z1) {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const r = Math.hypot(cx - 75, cz + 75);
  const core = Math.exp(-((r / 760) ** 2));
  const outer = Math.max(Math.abs(cx), Math.abs(cz)) > 1300;
  let h, st, col;
  if (outer) { h = range(9, 18); st = 1; col = pick(WARE); }
  else if (core > 0.35) { h = 30 + 130 * core * range(0.55, 1.15); st = 4; col = pick(TOWER); }
  else { h = 14 + 40 * core + range(0, 16); st = rand() < 0.5 ? 1 : 4; col = st === 1 ? pick(BRICK) : pick(TOWER); }
  buildings.push({ p: [x0, z0, x1, z0, x1, z1, x0, z1].map(r1), k: outer ? 'i' : 'c', h: r1(h), st, col, tall: 1 });
}
function fillLot(x0, z0, x1, z1, depth = 0) {
  if (x1 - x0 < 14 || z1 - z0 < 14) return;
  if (rectClear(x0, z0, x1, z1)) {
    const inset = range(1, 4);
    addBuilding(x0 + inset, z0 + inset, x1 - inset, z1 - inset);
    return;
  }
  if (depth >= 2) return;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  fillLot(x0, z0, mx - 1.5, mz - 1.5, depth + 1);
  fillLot(mx + 1.5, z0, x1, mz - 1.5, depth + 1);
  fillLot(x0, mz + 1.5, mx - 1.5, z1, depth + 1);
  fillLot(mx + 1.5, mz + 1.5, x1, z1, depth + 1);
}
const halfW = (i) => (Math.abs(i) === 11 ? 7 : isAve(i) ? 8 : 5.5);
for (let i = -11; i < 11; i++) for (let j = -11; j < 11; j++) {
  const x0 = i * G + halfW(i) + 6, x1 = (i + 1) * G - halfW(i + 1) - 6;
  const z0 = j * G + halfW(j) + 6, z1 = (j + 1) * G - halfW(j + 1) - 6;
  // One, two or four lots per block.
  const split = rand();
  if (split < 0.2) fillLot(x0, z0, x1, z1);
  else if (split < 0.5) {
    const mx = (x0 + x1) / 2;
    fillLot(x0, z0, mx - 3, z1); fillLot(mx + 3, z0, x1, z1);
  } else {
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    fillLot(x0, z0, mx - 3, mz - 3); fillLot(mx + 3, z0, x1, mz - 3);
    fillLot(x0, mz + 3, mx - 3, z1); fillLot(mx + 3, mz + 3, x1, z1);
  }
}
// Low warehouses beyond the perimeter roads frame the edge of the map.
for (let a = -EXT + 30; a < EXT - 60; a += 70) {
  for (const [x0, z0, x1, z1] of [[a, -EXT + 25, a + 52, -LIM - 30], [a, LIM + 30, a + 52, EXT - 25], [-EXT + 25, a, -LIM - 30, a + 52], [LIM + 30, a, EXT - 25, a + 52]]) {
    if (rectClear(x0, z0, x1, z1)) buildings.push({ p: [x0, z0, x1, z0, x1, z1, x0, z1].map(r1), k: 'i', h: r1(range(8, 15)), st: 1, col: pick(WARE), tall: 1 });
  }
}

// ------------------------------------------------------------------ landmarks and areas
const landmarks = [
  { name: 'The Stack', kind: 'interchange', x: 75, z: -75, addr: 'Highline over the Crosstown Viaduct' },
  { name: 'Skyway Loop', kind: 'freeway', x: 975, z: 0, addr: 'Elevated ring, 10 m up' },
  { name: 'Crosstown Viaduct', kind: 'freeway', x: -1350, z: -75, addr: 'Elevated, 18 m up' },
  { name: 'Highline', kind: 'freeway', x: 75, z: 1350, addr: 'Elevated, 26 m up' },
  { name: 'Canal Underway', kind: 'tunnel', x: -1275, z: 450, addr: 'Covered tunnel under Canal Avenue' },
  { name: 'Market Underway', kind: 'tunnel', x: -450, z: -1275, addr: 'Covered tunnel under Market Avenue' },
  { name: 'Bessemer Underway', kind: 'tunnel', x: 1275, z: -900, addr: 'Covered tunnel under Bessemer Avenue' },
  { name: 'Undercross', kind: 'tunnel', x: -450, z: 450, addr: 'Where the Canal and Market tunnels meet underground' },
  { name: 'Bessemer Circus', kind: 'interchange', x: -450, z: -900, addr: 'Four tunnel mouths around one crossing' },
];
const landcover = [{ k: 'parking', n: '', p: [-EXT, -EXT, EXT, -EXT, EXT, EXT, -EXT, EXT] }];

// ------------------------------------------------------------------ output
if (problems.length) {
  console.error(`${problems.length} problem(s):`);
  for (const p of problems.slice(0, 60)) console.error('  ' + p);
  process.exit(1);
}
const terrainFile = OUT.replace(/\.json$/, '-terrain.json');
const q = new Uint16Array(gw * gh);
for (let k = 0; k < q.length; k++) q[k] = Math.round(H[k] * 100);
fs.writeFileSync(terrainFile, JSON.stringify({ format: 'u16le-base64', width: gw, height: gh, data: Buffer.from(q.buffer).toString('base64') }));
const out = {
  meta: {
    title: 'Ironport (fictional city)',
    map: 'ironport',
    attribution: 'Fictional city generated by scripts/build-ironport.mjs',
    attributionUrl: '',
    license: 'Part of this game (no outside map data)',
    source: 'scripts/build-ironport.mjs',
    snapshot: null,
    crop: { south: 0, west: 0, north: 0, east: 0 },
    anchor: { lat: 0, lon: 0, label: 'Fictional origin' },
    convertedAt: new Date().toISOString(),
    command: 'node scripts/build-ironport.mjs',
    counts: { nodes: nodes.length, edges: edges.length, bridges: edges.filter((e) => e.br).length, tunnels: edges.filter((e) => e.lv < 0).length, buildings: buildings.length, lids: lids.length, copings: copings.length, walls: walls.length },
  },
  bounds: { minX: -EXT, maxX: EXT, minZ: -EXT, maxZ: EXT },
  terrain: { file: path.basename(terrainFile), width: gw, height: gh, spacing: SPACING, originX, originZ, scale: 0.01 },
  nodes: nodes.map((n) => [n.id, r1(n.x), r1(n.z)]),
  nodeY: nodes.map((n) => r2(n.y)),
  edges,
  boundaryExits: [],
  water: [],
  rivers: [],
  buildings,
  parks: [],
  landmarks,
  landcover,
  villages: [],
  docks: [],
  rail: [],
  under: {
    top: Y0,
    lids: lids.map((r) => r.map(r1)),
    copings: copings.map((r) => r.map(r1)),
    walls: walls.map((w) => [w[0], w[1], w[2], w[3], r2(w[4]), r2(w[5]), w[6], w[7]]),
    barriers,
  },
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(JSON.stringify(out.meta.counts), `checked ${checked} close pairs`);
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KiB) and ${terrainFile} (${(fs.statSync(terrainFile).size / 1024).toFixed(0)} KiB, ${gw}x${gh})`);
