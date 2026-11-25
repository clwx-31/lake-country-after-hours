// Rotating HUD minimap, drawn as vectors every frame from the same road,
// building and water data as the 3D world.
//
// One transform maps world -> minimap for everything (map layers, route,
// markers): screen = centre + R(rot) * (world - player) * k, with rot = heading + PI
// so the travel direction always points up. Map content is clipped to the
// circle; markers stay fully inside a padded radius, and off-map objectives
// become edge pointers that keep their true bearing and never overlap.
import { ROAD_RANK, type District } from '../map/District';
import type { MiniMarker } from './Hud';
import { MAP } from '../map/maps';

/** CSS pixel widths per road class, so every street of a class reads the same. */
const ROAD_STYLE: Record<string, { w: number; color: string }> = {
  motorway: { w: 7, color: '#d98c4f' },
  motorway_link: { w: 4.5, color: '#c48a5a' },
  trunk: { w: 6.5, color: '#d9a35a' },
  primary: { w: 6, color: '#cdb47e' },
  secondary: { w: 5.5, color: '#cdb47e' },
  tertiary: { w: 4.5, color: '#a9a291' },
  residential: { w: 3.5, color: '#7a808b' },
  unclassified: { w: 3.5, color: '#7a808b' },
  living_street: { w: 3, color: '#6b717c' },
  service: { w: 2.5, color: '#5b616b' },
};
const DEFAULT_ROAD = { w: 3, color: '#6b717c' };
// Multi-level maps: tunnels dim and dashed underneath, elevated roads drawn on top.
const TUNNEL_ROAD = { w: 5, color: '#4a6a8c' };
const ELEVATED_ROAD = { w: 6, color: '#e2a35e' };
const AREA_FILL: Record<string, string> = { park: '#1a2c20', forest: '#172419', water: '#1f4e6e' };
const BG = '#121821';
const BUILDING = '#2a313c';
const CELL = 200;

/** Icon radius (CSS px) including its outline, per marker kind. */
const ICON_R: Record<MiniMarker['kind'], number> = {
  dot: 4, police: 7.5, event: 9.5, garage: 9.5, checkpoint: 10, gate: 10, block: 9, ghost: 6, rival: 7.5,
};

interface Feature { path: Path2D; x0: number; z0: number; x1: number; z1: number }
interface RoadFeature extends Feature { rank: number; level: number; style: { w: number; color: string } }

export class Minimap {
  readonly canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d')!;
  private roads: RoadFeature[] = [];
  private buildings: Feature[] = [];
  private areas: (Feature & { fill: string })[] = [];
  private grid = new Map<number, { r: number[]; b: number[]; a: number[] }>();
  private stamp = new Uint32Array(0);
  private frame = 1;
  private css = 220;
  private dpr = 1;
  /** CSS px per meter; eases out with speed so you can see further when fast. */
  zoom = 0.7;
  private view = { x: 0, z: 0, rot: 0, k: 1, c: 110 };
  /** Last marker layout (canvas px), for automated checks. */
  lastLayout: { c: number; R: number; pad: number; inside: { x: number; y: number; r: number }[]; edge: { x: number; y: number; r: number; ang: number; trueAng: number }[] } = { c: 0, R: 0, pad: 0, inside: [], edge: [] };

  constructor(d: District) {
    this.canvas.className = 'minimap';
    const key = (i: number, j: number) => (i + 1000) * 4096 + (j + 1000);
    const cellsOf = (f: Feature) => {
      const out: number[] = [];
      for (let i = Math.floor(f.x0 / CELL); i <= Math.floor(f.x1 / CELL); i++) {
        for (let j = Math.floor(f.z0 / CELL); j <= Math.floor(f.z1 / CELL); j++) out.push(key(i, j));
      }
      return out;
    };
    const bucket = (k: number) => {
      let c = this.grid.get(k);
      if (!c) this.grid.set(k, (c = { r: [], b: [], a: [] }));
      return c;
    };
    const poly = (pts: ArrayLike<number>, close: boolean) => {
      const p = new Path2D();
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        if (i === 0) p.moveTo(pts[i], pts[i + 1]); else p.lineTo(pts[i], pts[i + 1]);
        x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); z0 = Math.min(z0, pts[i + 1]); z1 = Math.max(z1, pts[i + 1]);
      }
      if (close) p.closePath();
      return { path: p, x0, z0, x1, z1 };
    };
    const data = d.data;
    for (const l of data.landcover ?? []) if (l.k === 'forest') this.areas.push({ ...poly(l.p, true), fill: AREA_FILL.forest });
    for (const p of data.parks) this.areas.push({ ...poly(p.p, true), fill: AREA_FILL.park });
    for (const w of data.water) this.areas.push({ ...poly(w.outer, true), fill: AREA_FILL.water });
    this.areas.forEach((f, i) => cellsOf(f).forEach((k) => bucket(k).a.push(i)));
    for (const b of data.buildings) this.buildings.push(poly(b.p, true));
    this.buildings.forEach((f, i) => cellsOf(f).forEach((k) => bucket(k).b.push(i)));
    for (const e of d.edges) {
      const style = e.level < 0 ? TUNNEL_ROAD : e.level > 0 && MAP.city ? ELEVATED_ROAD : ROAD_STYLE[e.cls] ?? DEFAULT_ROAD;
      this.roads.push({ ...poly(e.pts, false), rank: ROAD_RANK[e.cls] ?? 1, level: Math.max(-1, Math.min(3, e.level)), style });
    }
    this.roads.forEach((f, i) => cellsOf(f).forEach((k) => bucket(k).r.push(i)));
    this.stamp = new Uint32Array(Math.max(this.roads.length, this.buildings.length, this.areas.length));
    this.cellKey = key;
  }
  private cellKey: (i: number, j: number) => number;

  /** Match the canvas backing store to its CSS size and the screen's pixel density. */
  private fit() {
    const css = this.canvas.clientWidth || 220;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (css === this.css && dpr === this.dpr && this.canvas.width === Math.round(css * dpr)) return;
    this.css = css;
    this.dpr = dpr;
    this.canvas.width = this.canvas.height = Math.round(css * dpr);
  }

  /** World -> canvas pixels (the single transform every layer uses). */
  toScreen(wx: number, wz: number): [number, number] {
    const v = this.view;
    const dx = wx - v.x, dz = wz - v.z, c = Math.cos(v.rot), s = Math.sin(v.rot);
    return [v.c + (dx * c - dz * s) * v.k, v.c + (dx * s + dz * c) * v.k];
  }

  private applyWorldTransform() {
    const v = this.view, c = Math.cos(v.rot), s = Math.sin(v.rot);
    this.g.setTransform(v.k * c, v.k * s, -v.k * s, v.k * c, v.c - v.k * (v.x * c - v.z * s), v.c - v.k * (v.x * s + v.z * c));
  }

  /** Visible feature ids of one kind, each once (frame-stamped). */
  private visible(kind: 'r' | 'b' | 'a', radius: number) {
    const v = this.view, out: number[] = [];
    const f = ++this.frame;
    for (let i = Math.floor((v.x - radius) / CELL); i <= Math.floor((v.x + radius) / CELL); i++) {
      for (let j = Math.floor((v.z - radius) / CELL); j <= Math.floor((v.z + radius) / CELL); j++) {
        const c = this.grid.get(this.cellKey(i, j));
        if (!c) continue;
        for (const id of c[kind]) if (this.stamp[id] !== f) { this.stamp[id] = f; out.push(id); }
      }
    }
    return out;
  }

  draw(x: number, z: number, h: number, speed: number, markers: MiniMarker[], route: number[] | null) {
    this.fit();
    const g = this.g, dpr = this.dpr, size = this.canvas.width;
    // ~155 m visible around the car at rest, widening to ~240 m at speed.
    const target = 0.7 - Math.min(1, Math.max(0, (speed - 10) / 30)) * 0.25;
    this.zoom += (target - this.zoom) * 0.06;
    const R = size / 2 - 2 * dpr; // map disc radius in device px
    this.view = { x, z, rot: h + Math.PI, k: this.zoom * dpr, c: size / 2 };
    const worldR = (R / this.view.k) * 1.05;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, size, size);

    // ---- map disc (clipped)
    g.save();
    g.beginPath();
    g.arc(size / 2, size / 2, R, 0, Math.PI * 2);
    g.fillStyle = BG;
    g.fill();
    g.clip();
    this.applyWorldTransform();
    const px = 1 / this.view.k; // one device pixel in world meters
    for (const id of this.visible('a', worldR)) {
      const a = this.areas[id];
      g.fillStyle = a.fill;
      g.fill(a.path);
    }
    g.fillStyle = BUILDING;
    for (const id of this.visible('b', worldR)) g.fill(this.buildings[id].path);
    const roads = this.visible('r', worldR).map((id) => this.roads[id]).sort((a, b) => a.level - b.level || a.rank - b.rank);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Level by level, so a viaduct's casing covers the street it crosses.
    for (let i = 0; i < roads.length;) {
      let j = i;
      while (j < roads.length && roads[j].level === roads[i].level) j++;
      const tier = roads.slice(i, j);
      g.setLineDash(tier[0].level < 0 ? [7 * dpr * px, 5 * dpr * px] : []);
      g.strokeStyle = '#07090c';
      for (const r of tier) {
        g.lineWidth = (r.style.w + 2) * dpr * px;
        g.stroke(r.path);
      }
      for (const r of tier) {
        g.strokeStyle = r.style.color;
        g.lineWidth = r.style.w * dpr * px;
        g.stroke(r.path);
      }
      i = j;
    }
    g.setLineDash([]);
    // Navigation route: continuous, rounded joins, on top of the roads.
    let dest: [number, number] | null = null;
    if (route && route.length >= 4) {
      const p = new Path2D();
      p.moveTo(route[0], route[1]);
      for (let i = 2; i < route.length; i += 2) p.lineTo(route[i], route[i + 1]);
      g.strokeStyle = 'rgba(40,24,0,0.85)';
      g.lineWidth = 8 * dpr * px;
      g.stroke(p);
      g.strokeStyle = '#ffd34d';
      g.lineWidth = 4.5 * dpr * px;
      g.stroke(p);
      dest = [route[route.length - 2], route[route.length - 1]];
    }
    g.restore();

    // ---- rim
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.beginPath();
    g.arc(size / 2, size / 2, R, 0, Math.PI * 2);
    g.lineWidth = 2 * dpr;
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.stroke();

    // ---- markers (unclipped, always fully inside the disc)
    const all = dest ? [...markers, { x: dest[0], z: dest[1], color: '#ffd34d', kind: 'gate' as const, label: '' }] : markers;
    this.drawMarkers(all, R);

    // ---- player arrow, at the centre, pointing along the car
    g.setTransform(dpr, 0, 0, dpr, size / 2, size / 2);
    g.fillStyle = '#ffb347';
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(0, -11); g.lineTo(8, 9); g.lineTo(0, 4.5); g.lineTo(-8, 9); g.closePath();
    g.stroke();
    g.fill();
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawMarkers(markers: MiniMarker[], R: number) {
    const g = this.g, dpr = this.dpr, c = this.view.c, pad = 3 * dpr;
    type Placed = { m: MiniMarker; x: number; y: number; r: number; edge: boolean; ang: number };
    const inside: Placed[] = [], edge: Placed[] = [];
    const EDGE_R = 8 * dpr; // edge pointer radius
    for (const m of markers) {
      const [sx, sy] = this.toScreen(m.x, m.z);
      const r = ICON_R[m.kind] * dpr;
      const dx = sx - c, dy = sy - c, dist = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      if (dist <= R - pad - r) inside.push({ m, x: sx, y: sy, r, edge: false, ang });
      else if (m.kind !== 'dot' && m.kind !== 'ghost') edge.push({ m, x: 0, y: 0, r: EDGE_R, edge: true, ang, trueAng: ang } as Placed & { trueAng: number });
    }
    // Interior: nudge overlapping icons apart a little (deterministic), then keep them inside.
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < inside.length; i++) for (let j = i + 1; j < inside.length; j++) {
        const a = inside[i], b = inside[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const need = a.r + b.r + 1.5 * dpr;
        if (d >= need) continue;
        if (d < 0.01) { dx = Math.cos(i * 2.39996 + j); dy = Math.sin(i * 2.39996 + j); d = 1; }
        const push = (need - d) / 2;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
      }
      for (const p of inside) {
        const dx = p.x - c, dy = p.y - c, d = Math.hypot(dx, dy), lim = R - pad - p.r;
        if (d > lim) { p.x = c + (dx / d) * lim; p.y = c + (dy / d) * lim; }
      }
    }
    // Edge pointers: on a ring just inside the rim, spread so none overlap,
    // each cluster centred on its mean bearing.
    const ringR = R - pad - EDGE_R;
    const minGap = (2 * EDGE_R + 2 * dpr) / ringR;
    edge.sort((a, b) => a.ang - b.ang);
    for (let it = 0; it < 6 && edge.length > 1; it++) {
      let moved = false;
      let i = 0;
      while (i < edge.length) {
        let j = i;
        while (j + 1 < edge.length && edge[j + 1].ang - edge[j].ang < minGap) j++;
        if (j > i) {
          const mean = edge.slice(i, j + 1).reduce((s, p) => s + p.ang, 0) / (j - i + 1);
          const span = (j - i) * minGap;
          for (let k = i; k <= j; k++) edge[k].ang = mean - span / 2 + (k - i) * minGap;
          moved = true;
        }
        i = j + 1;
      }
      // Wrap-around neighbours (last and first).
      const first = edge[0], last = edge[edge.length - 1];
      if (first.ang + Math.PI * 2 - last.ang < minGap) {
        const over = minGap - (first.ang + Math.PI * 2 - last.ang);
        first.ang += over / 2; last.ang -= over / 2; moved = true;
      }
      if (!moved) break;
    }
    for (const p of edge) { p.x = c + Math.cos(p.ang) * ringR; p.y = c + Math.sin(p.ang) * ringR; }
    this.lastLayout = {
      c, R, pad,
      inside: inside.map((p) => ({ x: p.x, y: p.y, r: p.r })),
      edge: edge.map((p) => ({ x: p.x, y: p.y, r: p.r, ang: p.ang, trueAng: (p as Placed & { trueAng: number }).trueAng })),
    };

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.lineJoin = 'round';
    for (const p of edge) {
      // A rounded pointer: the marker's colour, tip toward the objective.
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.ang);
      g.beginPath();
      g.moveTo(EDGE_R, 0);
      g.lineTo(-EDGE_R * 0.55, EDGE_R * 0.75);
      g.lineTo(-EDGE_R * 0.25, 0);
      g.lineTo(-EDGE_R * 0.55, -EDGE_R * 0.75);
      g.closePath();
      g.fillStyle = p.m.color;
      g.strokeStyle = '#000';
      g.lineWidth = 1.6 * dpr;
      g.stroke();
      g.fill();
      g.restore();
    }
    for (const p of inside) this.icon(p.m, p.x, p.y);
  }

  private icon(m: MiniMarker, x: number, y: number) {
    const g = this.g, s = this.dpr;
    g.fillStyle = m.color;
    g.strokeStyle = '#000';
    g.lineWidth = 2 * s;
    g.beginPath();
    switch (m.kind) {
      case 'police': case 'rival': g.arc(x, y, 5.5 * s, 0, Math.PI * 2); break;
      case 'event': case 'garage': g.rect(x - 6 * s, y - 6 * s, 12 * s, 12 * s); break;
      case 'checkpoint': case 'gate': g.moveTo(x, y - 8 * s); g.lineTo(x + 7 * s, y); g.lineTo(x, y + 8 * s); g.lineTo(x - 7 * s, y); g.closePath(); break;
      case 'block': g.rect(x - 7 * s, y - 3 * s, 14 * s, 6 * s); break;
      case 'ghost': g.arc(x, y, 4 * s, 0, Math.PI * 2); break;
      default: g.arc(x, y, 2.5 * s, 0, Math.PI * 2);
    }
    if (m.kind !== 'dot') g.stroke();
    g.fill();
    if (m.label) {
      g.font = `600 ${11 * s}px "Barlow Condensed", sans-serif`;
      g.textAlign = 'center';
      g.lineWidth = 3 * s;
      g.strokeText(m.label, x, y - 11 * s);
      g.fillStyle = '#fff';
      g.fillText(m.label, x, y - 11 * s);
    }
  }
}
