import * as THREE from 'three';

/** Accumulates non-indexed triangles with optional colors and custom attributes. */
export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  custom: Record<string, { size: number; data: number[] }> = {};
  private cur: Record<string, number[]> = {};
  color: [number, number, number] = [1, 1, 1];

  constructor(attrs: Record<string, number> = {}) {
    for (const [k, size] of Object.entries(attrs)) {
      this.custom[k] = { size, data: [] };
      this.cur[k] = new Array(size).fill(0);
    }
  }

  set(name: string, ...v: number[]) {
    const c = this.cur[name];
    for (let i = 0; i < c.length; i++) c[i] = v[i] ?? 0;
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, extra?: Record<string, number[]>) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(this.color[0], this.color[1], this.color[2]);
    for (const [k, a] of Object.entries(this.custom)) {
      const v = extra?.[k] ?? this.cur[k];
      for (let i = 0; i < a.size; i++) a.data.push(v[i]);
    }
  }

  /** Triangle, re-wound so its face normal agrees with the hint (nx,ny,nz). */
  tri(
    a: [number, number, number], b: [number, number, number], c: [number, number, number],
    nx: number, ny: number, nz: number,
    ea?: Record<string, number[]>, eb?: Record<string, number[]>, ec?: Record<string, number[]>,
  ) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * nx + cy * ny + cz * nz < 0) {
      [b, c] = [c, b];
      [eb, ec] = [ec, eb];
    }
    this.vert(a[0], a[1], a[2], nx, ny, nz, ea);
    this.vert(b[0], b[1], b[2], nx, ny, nz, eb);
    this.vert(c[0], c[1], c[2], nx, ny, nz, ec);
  }

  quad(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], nx: number, ny: number, nz: number) {
    this.tri(a, b, c, nx, ny, nz);
    this.tri(a, c, d, nx, ny, nz);
  }

  /** Flat horizontal polygon (x,z pairs) at height y, facing up. */
  flatPolygon(poly: number[], y: number) {
    const contour: THREE.Vector2[] = [];
    for (let i = 0; i < poly.length; i += 2) contour.push(new THREE.Vector2(poly[i], poly[i + 1]));
    if (contour.length > 2 && contour[0].distanceTo(contour[contour.length - 1]) < 1e-4) contour.pop();
    if (contour.length < 3) return;
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [i, j, k] of tris) {
      this.tri([contour[i].x, y, contour[i].y], [contour[j].x, y, contour[j].y], [contour[k].x, y, contour[k].y], 0, 1, 0);
    }
  }

  get count() {
    return this.pos.length / 3;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    for (const [k, a] of Object.entries(this.custom)) g.setAttribute(k, new THREE.Float32BufferAttribute(a.data, a.size));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export function hexColor(hex: string | number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}
