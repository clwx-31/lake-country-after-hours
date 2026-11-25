// Map rendering for the minimap and the full map. The district is ~9 km across,
// so the minimap streams 512 m tiles at 1 px/m around the player, and the full
// map uses one overview canvas at 0.25 px/m.
import type { District } from '../map/District';
import { ROAD_RANK } from '../map/District';

const TILE = 512;
const OVERVIEW = 0.25;

// Same restrained palette as the HUD minimap: only woods, parks and water get fills.
const LANDCOVER: Record<string, string> = { forest: '#172419' };

interface Feature {
  x0: number; z0: number; x1: number; z1: number;
  pts: number[];
  fill: string;
}

function bbox(pts: number[]) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    z0 = Math.min(z0, pts[i + 1]); z1 = Math.max(z1, pts[i + 1]);
  }
  return { x0, z0, x1, z1 };
}

export class MapPainter {
  private static cache = new WeakMap<District, MapPainter>();
  static for(d: District) {
    let p = MapPainter.cache.get(d);
    if (!p) MapPainter.cache.set(d, (p = new MapPainter(d)));
    return p;
  }

  readonly ox: number;
  readonly oz: number;
  readonly w: number;
  readonly h: number;
  private areas: Feature[] = [];
  private buildings: Feature[] = [];
  private roads: { e: District['edges'][number]; x0: number; z0: number; x1: number; z1: number }[] = [];
  private tiles = new Map<number, HTMLCanvasElement>();
  private overviewCanvas: HTMLCanvasElement | null = null;

  private constructor(readonly d: District) {
    const b = d.bounds;
    this.ox = b.minX - 40;
    this.oz = b.minZ - 40;
    this.w = Math.ceil(b.maxX - b.minX + 80);
    this.h = Math.ceil(b.maxZ - b.minZ + 80);
    const area = (pts: number[], fill: string) => this.areas.push({ ...bbox(pts), pts, fill });
    for (const l of d.data.landcover ?? []) if (LANDCOVER[l.k]) area(l.p, LANDCOVER[l.k]);
    for (const p of d.data.parks) area(p.p, '#1a2c20');
    for (const w of d.data.water) area(w.outer, '#1f4e6e');
    for (const bd of d.data.buildings) this.buildings.push({ ...bbox(bd.p), pts: bd.p, fill: bd.lm ? '#4a3a36' : '#2a313c' });
    const edges = [...d.edges].sort((a, b2) => a.level - b2.level || (ROAD_RANK[a.cls] ?? 1) - (ROAD_RANK[b2.cls] ?? 1));
    for (const e of edges) this.roads.push({ e, ...bbox(e.pts) });
  }

  /** Paint the world rectangle [x0, x0+span] x [z0, z0+span] into g at `scale` px/m. */
  private paint(g: CanvasRenderingContext2D, x0: number, z0: number, spanX: number, spanZ: number, scale: number) {
    g.fillStyle = '#121821';
    g.fillRect(0, 0, spanX * scale, spanZ * scale);
    const x1 = x0 + spanX, z1 = z0 + spanZ;
    const hit = (f: { x0: number; z0: number; x1: number; z1: number }, pad = 0) => f.x1 >= x0 - pad && f.x0 <= x1 + pad && f.z1 >= z0 - pad && f.z0 <= z1 + pad;
    const path = (pts: number[]) => {
      g.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        const x = (pts[i] - x0) * scale, y = (pts[i + 1] - z0) * scale;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
    };
    for (const a of this.areas) {
      if (!hit(a)) continue;
      path(a.pts);
      g.closePath();
      g.fillStyle = a.fill;
      g.fill();
    }
    if (scale >= 0.5) {
      for (const b of this.buildings) {
        if (!hit(b)) continue;
        path(b.pts);
        g.closePath();
        g.fillStyle = b.fill;
        g.fill();
      }
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const minW = 1.4 / scale;
    // Level by level (tunnels dashed underneath, viaducts on top), casing then fill.
    const city = this.d.data.under !== undefined;
    let i = 0;
    while (i < this.roads.length) {
      let j = i;
      while (j < this.roads.length && this.roads[j].e.level === this.roads[i].e.level) j++;
      const tier = this.roads.slice(i, j);
      const lv = tier[0].e.level;
      g.setLineDash(lv < 0 ? [Math.max(4, 24 * scale), Math.max(3, 14 * scale)] : []);
      for (const r of tier) {
        if (!hit(r, 20)) continue;
        path(r.e.pts);
        g.lineWidth = (Math.max(r.e.width, minW) + 3) * scale;
        g.strokeStyle = '#05070a';
        g.stroke();
      }
      for (const r of tier) {
        if (!hit(r, 20)) continue;
        const rank = ROAD_RANK[r.e.cls] ?? 1;
        path(r.e.pts);
        g.lineWidth = Math.max(r.e.width, minW) * scale;
        g.strokeStyle = lv < 0 ? '#4a6a8c' : city && lv > 0 ? '#e2a35e' : r.e.cls === 'motorway' ? '#d98c4f' : r.e.cls === 'motorway_link' ? '#c48a5a' : rank >= 4 ? '#cdb47e' : rank >= 3 ? '#a9a291' : '#7a808b';
        g.stroke();
      }
      i = j;
    }
    g.setLineDash([]);
  }

  private tileKey(i: number, j: number) {
    return i * 4096 + j;
  }

  private tile(i: number, j: number) {
    const k = this.tileKey(i, j);
    let c = this.tiles.get(k);
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = TILE;
      this.paint(c.getContext('2d')!, this.ox + i * TILE, this.oz + j * TILE, TILE, TILE, 1);
      this.tiles.set(k, c);
    }
    return c;
  }

  /** Make sure the tiles around a point exist (at most `budget` new ones per call). */
  pump(x: number, z: number, radius = 700, budget = 1) {
    const i0 = Math.floor((x - radius - this.ox) / TILE), i1 = Math.floor((x + radius - this.ox) / TILE);
    const j0 = Math.floor((z - radius - this.oz) / TILE), j1 = Math.floor((z + radius - this.oz) / TILE);
    const want: { i: number; j: number; d: number }[] = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      if (this.tiles.has(this.tileKey(i, j))) continue;
      const cx = this.ox + (i + 0.5) * TILE, cz = this.oz + (j + 0.5) * TILE;
      want.push({ i, j, d: Math.hypot(cx - x, cz - z) });
    }
    want.sort((a, b) => a.d - b.d);
    for (const t of want.slice(0, budget)) this.tile(t.i, t.j);
    // Drop far tiles to bound memory (each is 1 MB).
    if (this.tiles.size > 40) {
      for (const k of [...this.tiles.keys()]) {
        const i = Math.floor(k / 4096), j = k - i * 4096;
        const cx = this.ox + (i + 0.5) * TILE, cz = this.oz + (j + 0.5) * TILE;
        if (Math.hypot(cx - x, cz - z) > 2200) this.tiles.delete(k);
      }
    }
  }

  get overview() {
    if (!this.overviewCanvas) {
      const c = document.createElement('canvas');
      c.width = Math.ceil(this.w * OVERVIEW);
      c.height = Math.ceil(this.h * OVERVIEW);
      this.paint(c.getContext('2d')!, this.ox, this.oz, this.w, this.h, OVERVIEW);
      this.overviewCanvas = c;
    }
    return this.overviewCanvas;
  }

  /** Draw the map so world point (cx,cz) lands at canvas (px,py) with rotation and zoom. */
  draw(g: CanvasRenderingContext2D, cx: number, cz: number, px: number, py: number, pxPerM: number, rot: number) {
    g.save();
    g.translate(px, py);
    g.rotate(rot);
    g.scale(pxPerM, pxPerM);
    g.translate(-(cx - this.ox), -(cz - this.oz));
    g.imageSmoothingEnabled = true;
    if (pxPerM < 0.6) {
      g.drawImage(this.overview, 0, 0, this.w, this.h);
    } else {
      // Visible radius in meters (the canvas diagonal covers any rotation).
      const r = Math.hypot(g.canvas.width, g.canvas.height) / 2 / pxPerM + 10;
      const i0 = Math.floor((cx - r - this.ox) / TILE), i1 = Math.floor((cx + r - this.ox) / TILE);
      const j0 = Math.floor((cz - r - this.oz) / TILE), j1 = Math.floor((cz + r - this.oz) / TILE);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        if (i < 0 || j < 0 || i * TILE > this.w || j * TILE > this.h) continue;
        const t = this.tiles.get(this.tileKey(i, j)) ?? this.tile(i, j);
        // Overlap a hair so tile seams never show when rotated.
        g.drawImage(t, i * TILE - 0.5, j * TILE - 0.5, TILE + 1, TILE + 1);
      }
    }
    g.restore();
  }
}
