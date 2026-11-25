// Heightfield for the moraine country: heights on the mesh's own triangles, normals, and a flat
// fallback so maps without terrain still work.

export interface TerrainInfo {
  file: string;
  width: number;
  height: number;
  spacing: number;
  originX: number;
  originZ: number;
  scale: number;
}

export class Terrain {
  constructor(
    readonly info: TerrainInfo | null,
    readonly data: Float32Array | null,
  ) {}

  static flat() {
    return new Terrain(null, null);
  }

  static fromBuffer(info: TerrainInfo, buf: ArrayBuffer) {
    const q = new Uint16Array(buf);
    const f = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) f[i] = q[i] * info.scale;
    return new Terrain(info, f);
  }

  /** Raw grid sample (clamped). */
  sample(i: number, j: number) {
    const t = this.info!;
    i = i < 0 ? 0 : i >= t.width ? t.width - 1 : i;
    j = j < 0 ? 0 : j >= t.height ? t.height - 1 : j;
    return this.data![j * t.width + i];
  }

  height(x: number, z: number) {
    const t = this.info;
    if (!t || !this.data) return 0;
    const fx = (x - t.originX) / t.spacing, fz = (z - t.originZ) / t.spacing;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > t.width - 2) i = t.width - 2;
    if (j < 0) j = 0; else if (j > t.height - 2) j = t.height - 2;
    let tx = fx - i, tz = fz - j;
    tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
    tz = tz < 0 ? 0 : tz > 1 ? 1 : tz;
    const w = t.width, d = this.data;
    const a = d[j * w + i], b = d[j * w + i + 1], c = d[(j + 1) * w + i], e = d[(j + 1) * w + i + 1];
    // The same two triangles the ground mesh draws (diagonal b-c), so anything
    // placed with height() sits exactly on the visible surface.
    return tx + tz <= 1 ? a + (b - a) * tx + (c - a) * tz : e + (c - e) * (1 - tx) + (b - e) * (1 - tz);
  }

  /** Unit normal from central differences (y up). */
  normal(x: number, z: number, out = { x: 0, y: 1, z: 0 }) {
    const e = 2;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    let nx = -hx / (2 * e), nz = -hz / (2 * e), ny = 1;
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    out.x = nx; out.y = ny; out.z = nz;
    return out;
  }
}
