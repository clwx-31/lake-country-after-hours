// Landcover raster on the terrain grid: what grows or stands at each 10 m cell.
// Drives ground colours and tree density. Chenequa's unmapped woods are filled
// in with a noise mask inside the village boundary.
import { MAP } from './maps';
import type { District } from './District';

export const LC = {
  open: 0, // mown or rough grass
  forest: 1,
  farm: 2,
  lawn: 3, // residential yards
  paved: 4, // commercial / parking
  park: 5,
  wetland: 6,
  water: 7,
  woods: 8, // generated woodland (Chenequa estates, ravines)
} as const;

function hash2(x: number, z: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, z: number) {
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
export function fbm(x: number, z: number) {
  return vnoise(x, z) * 0.55 + vnoise(x * 2.1 + 7, z * 2.1 - 3) * 0.3 + vnoise(x * 4.3 - 11, z * 4.3 + 5) * 0.15;
}

export class Landcover {
  readonly width: number;
  readonly height: number;
  readonly spacing: number;
  readonly ox: number;
  readonly oz: number;
  readonly cls: Uint8Array;

  constructor(d: District) {
    const t = d.data.terrain;
    const b = d.bounds;
    this.spacing = t?.spacing ?? 10;
    this.ox = t?.originX ?? b.minX;
    this.oz = t?.originZ ?? b.minZ;
    this.width = t?.width ?? Math.ceil((b.maxX - b.minX) / this.spacing) + 1;
    this.height = t?.height ?? Math.ceil((b.maxZ - b.minZ) / this.spacing) + 1;
    this.cls = new Uint8Array(this.width * this.height);
    const order: [string, number][] = [
      ['farm', LC.farm], ['park', LC.park], ['residential', LC.lawn], ['commercial', LC.lawn], ['parking', LC.paved],
      ['forest', LC.forest], ['wetland', LC.wetland],
    ];
    // Wooded by default (Chenequa's estate country; the whole Kettle Moraine), thinned by noise.
    const wooded = MAP.woodedVillages;
    if (wooded === 'all') this.cls.fill(255);
    else for (const v of d.data.villages?.filter((vv) => wooded.includes(vv.n)) ?? []) this.fill(v.p, 255);
    for (let j = 0; j < this.height; j++) for (let i = 0; i < this.width; i++) {
      const k = j * this.width + i;
      const x = this.ox + i * this.spacing, z = this.oz + j * this.spacing;
      const n = fbm(x / 140, z / 140);
      if (this.cls[k] === 255) this.cls[k] = n > 0.38 ? LC.woods : LC.open;
      else this.cls[k] = n > 0.66 ? LC.woods : LC.open; // hedgerows and ravine woods elsewhere
    }
    for (const [kind, code] of order) for (const c of d.data.landcover ?? []) if (c.k === kind) this.fill(c.p, code);
    this.smoothGrass();
    for (const w of d.data.water) this.fill(w.outer, LC.water);
  }

  /**
   * Neighbouring residential polygons rarely share edges exactly, which leaves
   * slivers of open field between them. A majority filter folds those slivers
   * (and lone lawn cells in fields) into their surroundings; other classes are untouched.
   */
  private smoothGrass() {
    const w = this.width, h = this.height;
    for (let pass = 0; pass < 2; pass++) {
      const src = this.cls.slice();
      for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
        const k = j * w + i, c = src[k];
        if (c !== LC.open && c !== LC.lawn) continue;
        let lawn = 0, open = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const o = src[k + dj * w + di];
          if (o === LC.lawn) lawn++; else if (o === LC.open) open++;
        }
        if (c === LC.open && lawn >= 5) this.cls[k] = LC.lawn;
        else if (c === LC.lawn && open >= 6) this.cls[k] = LC.open;
      }
    }
  }

  /** Scanline-fill a polygon (x,z pairs) into the raster. */
  private fill(poly: number[], code: number) {
    const n = poly.length / 2;
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < n; i++) { zmin = Math.min(zmin, poly[i * 2 + 1]); zmax = Math.max(zmax, poly[i * 2 + 1]); }
    const j0 = Math.max(0, Math.ceil((zmin - this.oz) / this.spacing)), j1 = Math.min(this.height - 1, Math.floor((zmax - this.oz) / this.spacing));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const z = this.oz + j * this.spacing;
      xs.length = 0;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const za = poly[a * 2 + 1], zb = poly[b * 2 + 1];
        if ((za > z) !== (zb > z)) xs.push(poly[a * 2] + ((z - za) / (zb - za)) * (poly[b * 2] - poly[a * 2]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.ox) / this.spacing)), i1 = Math.min(this.width - 1, Math.floor((xs[k + 1] - this.ox) / this.spacing));
        for (let i = i0; i <= i1; i++) this.cls[j * this.width + i] = code;
      }
    }
  }

  at(x: number, z: number) {
    const i = Math.round((x - this.ox) / this.spacing), j = Math.round((z - this.oz) / this.spacing);
    if (i < 0 || j < 0 || i >= this.width || j >= this.height) return LC.open;
    return this.cls[j * this.width + i];
  }
}
