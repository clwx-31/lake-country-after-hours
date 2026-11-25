// Streamed woodland: deterministic trees per 256 m chunk, generated around the
// camera, detailed up close and low-poly further out. Fall maples, oaks and
// birches with white pines mixed in, dense in Chenequa's woods.
import * as THREE from 'three';
import { MAP } from '../map/maps';
import { Rng } from '../core/rng';
import { LC, fbm } from '../map/Landcover';
import type { World } from './World';

const CHUNK = 256;
const DENSITY: Record<number, [number, number]> = {
  // [cell spacing m, probability]
  [LC.forest]: [6, 0.95],
  [LC.woods]: [6.5, 0.92],
  [LC.lawn]: [9, 0.22], // yard and street trees
  [LC.park]: [10, 0.2],
  [LC.open]: [9, 0.09],
  [LC.farm]: [12, 0.006], // open fields; their edges get hedgerows below
  [LC.wetland]: [8, 0.3],
  [LC.paved]: [10, 0.015],
  [LC.water]: [10, 0],
};
const HEDGEROW: [number, number] = [6, 0.4];
const FALL = ['#9e2a1c', '#b8461d', '#cc6a1e', '#d9a12b', '#e0b538', '#a3741f', '#7a4a22', '#8e3b24', '#5f6b2c'];
const PINE = ['#1f3b26', '#24402a', '#2b4a2f', '#1b3322'];

type Kind = 0 | 1; // 0 broadleaf, 1 conifer
interface Tree { x: number; y: number; z: number; s: number; kind: Kind; color: THREE.Color; birch: boolean }
interface Chunk {
  key: string;
  cx: number;
  cz: number;
  trees: Tree[];
  near: THREE.Group | null;
  far: THREE.Group | null;
}

function canopyGeo(detail: number) {
  // Three lumpy blobs merged into one crown.
  const parts: THREE.BufferGeometry[] = [];
  const offsets = detail ? [[0, 0, 0, 1], [0.9, 0.7, -0.4, 0.75], [-0.7, 0.5, 0.6, 0.72]] : [[0, 0.2, 0, 1.15]];
  for (const [x, y, z, r] of offsets) {
    const g = new THREE.IcosahedronGeometry(2.6 * r, detail);
    const pos = g.attributes.position;
    // Lumps keyed on the vertex position (not its index), so corners shared by
    // neighbouring triangles move together and the crown stays watertight.
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      const k = 1 + 0.12 * Math.sin(px * 3.71 + py * 2.13 + pz * 5.37 + x * 7);
      pos.setXYZ(i, px * k, py * k * 0.88, pz * k);
    }
    g.translate(x, 5.6 + y, z);
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  return merge(parts);
}
function pineGeo(detail: number) {
  const parts: THREE.BufferGeometry[] = [];
  const tiers = detail ? [[2.6, 4.2, 3.2], [2.1, 3.6, 5.6], [1.5, 3.0, 7.8], [0.9, 2.4, 9.6]] : [[2.4, 9.5, 6.4]];
  for (const [r, h, y] of tiers) {
    const g = new THREE.ConeGeometry(r, h, detail ? 8 : 6);
    g.translate(0, y, 0);
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  return merge(parts);
}
function merge(parts: THREE.BufferGeometry[]) {
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, o * 3);
    p.computeVertexNormals();
    nrm.set(p.attributes.normal.array as Float32Array, o * 3);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.computeBoundingSphere();
  return g;
}

export class Forest {
  readonly group = new THREE.Group();
  private chunks = new Map<string, Chunk>();
  private collided = new Set<string>();
  private geo = {
    trunk: new THREE.CylinderGeometry(0.18, 0.32, 1, 6).translate(0, 0.5, 0),
    trunkFar: new THREE.CylinderGeometry(0.2, 0.3, 1, 4).translate(0, 0.5, 0),
    crown: canopyGeo(1),
    crownFar: canopyGeo(0),
    pine: pineGeo(1),
    pineFar: pineGeo(0),
  };
  private mat = {
    bark: new THREE.MeshStandardMaterial({ color: 0x3a2c22, roughness: 1 }),
    birch: new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.9 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }),
  };
  radius = 1150;
  nearRadius = 340;

  constructor(private world: World, low: boolean) {
    if (low) { this.radius = 700; this.nearRadius = 200; }
  }

  private generate(cx: number, cz: number): Tree[] {
    // The generated city has no trees (nothing small to hit).
    if (MAP.city) return [];
    const w = this.world;
    const T = w.d.terrain;
    const lc = w.landcover;
    const rng = new Rng((cx * 73856093) ^ (cz * 19349663));
    const trees: Tree[] = [];
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const b = w.d.bounds;
    const step = 5.5;
    for (let x = x0; x < x0 + CHUNK; x += step) {
      for (let z = z0; z < z0 + CHUNK; z += step) {
        if (x < b.minX - 200 || x > b.maxX + 200 || z < b.minZ - 200 || z > b.maxZ + 200) continue;
        const code = lc.at(x, z);
        let [sp, p] = DENSITY[code] ?? [10, 0.05];
        // Hedgerows and tree lines along the edges of real farm fields.
        if (code === LC.farm) {
          for (const [ox, oz] of [[14, 0], [-14, 0], [0, 14], [0, -14]]) {
            const o = lc.at(x + ox, z + oz);
            if (o !== LC.farm && o !== LC.water) { [sp, p] = HEDGEROW; break; }
          }
        }
        if (rng.next() > p * (step * step) / (sp * sp)) continue;
        const tx = x + rng.range(0, step), tz = z + rng.range(0, step);
        // Keep clear of roads, shoulders, buildings, water and reserved lots.
        if (w.walkIndex.query(tx, tz) >= 0 || w.walkIndex.query(tx + 2.5, tz) >= 0 || w.walkIndex.query(tx - 2.5, tz) >= 0 || w.walkIndex.query(tx, tz + 2.5) >= 0 || w.walkIndex.query(tx, tz - 2.5) >= 0) continue;
        if (w.buildingIndex.query(tx, tz) >= 0 || w.buildingIndex.query(tx + 4, tz) >= 0 || w.buildingIndex.query(tx - 4, tz) >= 0 || w.buildingIndex.query(tx, tz + 4) >= 0 || w.buildingIndex.query(tx, tz - 4) >= 0) continue;
        if (w.waterIndex.query(tx, tz) >= 0 || w.isReserved(tx, tz, 3)) continue;
        // Nothing over a cave, on a tube or a deck, and (on fast maps) well back from the speedways.
        if (w.ground.height(tx, tz, Infinity) > T.height(tx, tz) + 0.3) continue;
        if (MAP.treeClear) {
          const near = w.d.nearestEdge(tx, tz, MAP.treeClear + 14, (e) => e.cls === 'primary');
          if (near && near.d < w.d.edges[near.edge].width / 2 + MAP.treeClear) continue;
        }
        const n = fbm(tx / 90 + 31, tz / 90 - 17);
        const conifer = (code === LC.forest || code === LC.woods) ? n > 0.62 || rng.chance(0.12) : rng.chance(0.15);
        const birch = !conifer && rng.chance(0.1);
        const color = new THREE.Color(conifer ? rng.pick(PINE) : birch ? rng.pick(['#e0b538', '#d9a12b', '#c9a43a']) : rng.pick(FALL));
        color.multiplyScalar(rng.range(0.85, 1.12));
        const wooded = code === LC.forest || code === LC.woods;
        // Woods get an understory of young trees; yards and parks a few big old ones.
        const s = (wooded ? (rng.chance(0.25) ? rng.range(0.45, 0.7) : rng.range(0.95, 1.5))
          : (code === LC.lawn || code === LC.park) && rng.chance(0.12) ? rng.range(1.4, 1.85) : rng.range(0.8, 1.25)) * (conifer ? 1.1 : 1);
        trees.push({ x: tx, y: T.height(tx, tz), z: tz, s, kind: conifer ? 1 : 0, color, birch });
      }
    }
    return trees;
  }

  private build(c: Chunk, near: boolean) {
    const g = new THREE.Group();
    const broad = c.trees.filter((t) => t.kind === 0);
    const pines = c.trees.filter((t) => t.kind === 1);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, list: Tree[], fn: (t: Tree, i: number, im: THREE.InstancedMesh) => void) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((t, i) => fn(t, i, im));
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      g.add(im);
    };
    const rot = (t: Tree) => q.setFromAxisAngle(up, (t.x * 13.1 + t.z * 7.7) % (Math.PI * 2));
    const trunkFor = (t: Tree) => (t.kind === 1 ? 4.5 : 4.3) * t.s;
    const birches = broad.filter((t) => t.birch), oaks = broad.filter((t) => !t.birch);
    mk(near ? this.geo.trunk : this.geo.trunkFar, this.mat.bark, [...oaks, ...pines], (t, i, im) => {
      m.compose(p.set(t.x, t.y - 0.3, t.z), rot(t), sc.set(t.s, trunkFor(t) + 0.3, t.s));
      im.setMatrixAt(i, m);
    });
    mk(near ? this.geo.trunk : this.geo.trunkFar, this.mat.birch, birches, (t, i, im) => {
      m.compose(p.set(t.x, t.y - 0.3, t.z), rot(t), sc.set(t.s * 0.8, trunkFor(t) + 0.3, t.s * 0.8));
      im.setMatrixAt(i, m);
    });
    mk(near ? this.geo.crown : this.geo.crownFar, this.mat.leaf, broad, (t, i, im) => {
      m.compose(p.set(t.x, t.y, t.z), rot(t), sc.set(t.s, t.s * (t.birch ? 1.15 : 1), t.s));
      im.setMatrixAt(i, m);
      im.setColorAt(i, t.color);
    });
    mk(near ? this.geo.pine : this.geo.pineFar, this.mat.leaf, pines, (t, i, im) => {
      m.compose(p.set(t.x, t.y, t.z), rot(t), sc.set(t.s, t.s * 1.15, t.s));
      im.setMatrixAt(i, m);
      im.setColorAt(i, t.color);
    });
    return g;
  }

  private dispose(g: THREE.Group | null) {
    if (!g) return;
    this.group.remove(g);
    g.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
  }

  /** Stream chunks around the camera; at most a few new builds per frame. */
  update(camera: THREE.Camera, budget = 3) {
    const cxCam = camera.position.x, czCam = camera.position.z;
    const r = this.radius;
    const want = new Set<string>();
    const todo: { key: string; cx: number; cz: number; d: number }[] = [];
    for (let cx = Math.floor((cxCam - r) / CHUNK); cx <= Math.floor((cxCam + r) / CHUNK); cx++) {
      for (let cz = Math.floor((czCam - r) / CHUNK); cz <= Math.floor((czCam + r) / CHUNK); cz++) {
        const mx = (cx + 0.5) * CHUNK, mz = (cz + 0.5) * CHUNK;
        const d = Math.hypot(mx - cxCam, mz - czCam);
        if (d > r + CHUNK * 0.7) continue;
        const key = `${cx},${cz}`;
        want.add(key);
        todo.push({ key, cx, cz, d });
      }
    }
    todo.sort((a, b) => a.d - b.d);
    let built = 0;
    for (const t of todo) {
      let c = this.chunks.get(t.key);
      if (!c) {
        if (built >= budget) continue;
        c = { key: t.key, cx: t.cx, cz: t.cz, trees: this.generate(t.cx, t.cz), near: null, far: null };
        this.chunks.set(t.key, c);
        this.addColliders(c);
        built++;
      }
      const isNear = t.d < this.nearRadius;
      if (isNear && !c.near) {
        if (built >= budget + 2) continue;
        c.near = this.build(c, true);
        this.group.add(c.near);
        built++;
      }
      if (!isNear && !c.far) {
        if (built >= budget + 2) continue;
        c.far = this.build(c, false);
        this.group.add(c.far);
        built++;
      }
      if (c.near) c.near.visible = isNear;
      if (c.far) c.far.visible = !isNear || !c.near;
    }
    for (const [key, c] of this.chunks) {
      if (want.has(key)) continue;
      this.dispose(c.near);
      this.dispose(c.far);
      this.chunks.delete(key);
    }
  }

  /** Trees close to roads get trunks you can hit. Added once per chunk. */
  private addColliders(c: Chunk) {
    if (this.collided.has(c.key)) return;
    this.collided.add(c.key);
    const w = this.world;
    for (const t of c.trees) {
      let near = false;
      for (const [dx, dz] of [[8, 0], [-8, 0], [0, 8], [0, -8], [5, 5], [-5, -5], [5, -5], [-5, 5]]) {
        if (w.walkIndex.query(t.x + dx, t.z + dz) >= 0) { near = true; break; }
      }
      if (near) w.statics.addCircle(t.x, t.z, 0.4 * t.s, 'tree', t.y - 1, t.y + 6);
    }
  }

  /** Pre-generate chunks around a point (so colliders exist before driving). */
  prime(x: number, z: number) {
    const fake = new THREE.PerspectiveCamera();
    fake.position.set(x, 0, z);
    for (let i = 0; i < 40; i++) this.update(fake, 50);
  }
}
