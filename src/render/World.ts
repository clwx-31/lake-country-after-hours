// Builds the static lake-country world: terrain chunks, draped roads with
// bridges and piers, lakes, detailed houses, docks, rail, and collisions.
import { MAP } from '../map/maps';
import * as THREE from 'three';
import { pointInPolygon } from '../core/math';
import { Rng, hash32 } from '../core/rng';
import { District, ROAD_RANK } from '../map/District';
import { LC, Landcover, fbm } from '../map/Landcover';
import {
  PolygonIndex, buildCurbs, buildRoadLayer, layerIndex, offsetPolyline, stripPolygon, type RoadLayer,
} from '../map/roadGeometry';
import { Ground, type RoofDeck } from '../sim/Ground';
import { StaticWorld } from '../sim/Physics';
import { GeoBuilder, hexColor } from './GeoBuilder';
import { buildingMaterial, concreteMaterial, waterMaterial, wetAsphalt } from './materials';

export const SURF_ROAD = 0;
export const SURF_WALK = 1;
export const SURF_GRASS = 2;
export const SURF_WATER = 3;

export interface WorldOptions {
  lowEffects: boolean;
}

export interface HouseInfo {
  cx: number;
  cz: number;
  ax: number;
  az: number;
  halfL: number;
  halfW: number;
  wallH: number;
  street: { x: number; z: number };
}

/** Shared uniforms the time-of-day system drives. */
export const worldUniforms = {
  windowLight: { value: 1 },
  wetness: { value: 1 },
  time: { value: 0 },
};

/** One colour per land-use class; parks, farms, lots and wetlands stay distinct. */
const TERRAIN_PALETTE: Record<number, [number, number, number]> = {
  [LC.open]: [0.30, 0.34, 0.15], // October grass
  [LC.lawn]: [0.26, 0.35, 0.14], // mown yards, a touch greener
  [LC.park]: [0.23, 0.36, 0.14],
  [LC.forest]: [0.25, 0.27, 0.13], // shaded woodland floor
  [LC.woods]: [0.28, 0.31, 0.14],
  [LC.farm]: [0.46, 0.40, 0.23], // harvested stubble
  [LC.paved]: [0.38, 0.37, 0.35],
  [LC.wetland]: [0.41, 0.37, 0.22], // marsh reeds
  [LC.water]: [0.33, 0.31, 0.22],
};

const ROAD_LIFT = 0.07;

export class World {
  readonly group = new THREE.Group();
  readonly statics = new StaticWorld();
  readonly asphalt: RoadLayer;
  readonly asphaltIndex: PolygonIndex;
  readonly walkIndex: PolygonIndex;
  readonly waterIndex = new PolygonIndex(48);
  readonly buildingIndex = new PolygonIndex(32);
  readonly bridgeDecks: { edge: number; poly: number[] }[] = [];
  readonly houses: HouseInfo[] = [];
  readonly windowLight = worldUniforms.windowLight;
  readonly time = worldUniforms.time;
  readonly reserved: { x: number; z: number; r: number }[] = [];
  readonly landcover: Landcover;
  readonly ground: Ground;
  readonly town = new Set<number>(); // edges with curbs, sidewalks and streetlights
  readonly downtown: { x: number; z: number; r: number };
  readonly terrainChunks: { center: THREE.Vector3; hi: THREE.Mesh; lo: THREE.Mesh }[] = [];
  private sidewalk: RoadLayer;
  private terrace: RoadLayer;
  private curbs: number[][] = [];
  private hartland: number[][];

  constructor(readonly d: District, readonly opts: WorldOptions, reserved: { x: number; z: number; r: number }[] = []) {
    this.reserved.push(...reserved);
    const lib = MAP.downtownLandmark ? d.data.landmarks.find((l) => l.name === MAP.downtownLandmark) : undefined;
    this.downtown = lib ? { x: lib.x, z: lib.z, r: 330 } : { x: 1e9, z: 1e9, r: 0 };
    this.hartland = (d.data.villages ?? []).filter((v) => MAP.townVillages.includes(v.n)).map((v) => v.p);
    this.landcover = new Landcover(d);
    for (const e of d.edges) {
      // A generated city: every street-level road gets curbs and sidewalks.
      if (MAP.city) { if (e.level === 0 && !e.bridge) this.town.add(e.index); continue; }
      const mid = e.path.pointAt(e.length / 2);
      const inTown = this.hartland.some((p) => pointInPolygon(mid.x, mid.z, p)) || this.isDowntown(mid.x, mid.z);
      const lc = this.landcover.at(mid.x, mid.z);
      if (inTown && !e.cls.startsWith('motorway') && lc !== LC.farm && lc !== LC.woods && lc !== LC.forest) this.town.add(e.index);
    }
    this.asphalt = buildRoadLayer(d, 0);
    this.sidewalk = buildRoadLayer(d, (ei) => (d.edges[ei].bridge ? 1.4 : this.town.has(ei) ? 4.3 : d.edges[ei].cls === 'motorway' ? 2.5 : 1.6));
    this.terrace = buildRoadLayer(d, (ei) => (this.town.has(ei) && !d.edges[ei].bridge && !this.isDowntown(...this.mid(ei)) ? 2.4 : 0));
    const aIdx = layerIndex(this.asphalt);
    this.asphaltIndex = aIdx.index;
    this.walkIndex = layerIndex(this.sidewalk).index;
    this.curbs = buildCurbs(d, this.asphalt, aIdx).filter((c) => {
      const hit = d.nearestEdge(c[0], c[1], 30);
      return hit ? this.town.has(hit.edge) : false;
    });
    this.sidewalk.strips.forEach((s) => { if (d.edges[s.edge].bridge) this.bridgeDecks.push({ edge: s.edge, poly: stripPolygon(s) }); });
    // Junctions up on a deck, and the street-level slabs over tunnels, are decks too.
    const flat: { poly: number[]; y: number; node?: number; lid?: boolean }[] = [];
    for (const j of this.sidewalk.junctions) {
      const n = d.nodes[j.node];
      const y = d.data.nodeY?.[j.node];
      if (y === undefined || !n.edges.some((ei) => d.edges[ei].bridge)) continue;
      flat.push({ poly: j.poly, y, node: j.node });
    }
    const U = d.data.under;
    if (U) {
      const rect = (r: number[]) => [r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3]];
      for (const r of U.lids) flat.push({ poly: rect(r), y: U.top, lid: true });
      for (const r of U.copings) flat.push({ poly: rect(r), y: U.top });
    }
    // Caves (roof = the hill) and speed tubes (roof = the tube) on generated maps.
    const roofs: RoofDeck[] = [];
    for (const t of d.data.tubes ?? []) {
      const e = d.edges[t.edge];
      const half = t.cave ? t.hw + 33 : t.hw + 0.8;
      const L = offsetPolyline(e.pts, -half), R = offsetPolyline(e.pts, half);
      const poly = L.slice();
      for (let i = R.length - 2; i >= 0; i -= 2) poly.push(R[i], R[i + 1]);
      roofs.push({ edge: t.edge, poly, under: t.h, hill: t.cave ? d.surface ?? undefined : undefined, above: t.cave ? undefined : t.h + 0.7 });
    }
    this.ground = new Ground(d, this.bridgeDecks, flat, roofs);
    for (const w of d.data.water) this.waterIndex.add(w.outer, 0);

    this.buildTerrain();
    this.buildRoads();
    this.buildCurbs();
    this.buildMarkings();
    this.buildWater();
    this.buildBridges();
    this.buildUnder();
    this.buildTubes();
    this.buildBuildings();
    this.buildDocks();
    this.buildRail();
    this.buildBoundary();
  }

  private mid(ei: number): [number, number] {
    const e = this.d.edges[ei];
    const p = e.path.pointAt(e.length / 2);
    return [p.x, p.z];
  }

  isDowntown(x: number, z: number) {
    if (MAP.city) return true;
    return Math.hypot(x - this.downtown.x, z - this.downtown.z) < this.downtown.r;
  }

  surfaceAt(x: number, z: number) {
    if (this.asphaltIndex.query(x, z) >= 0) return SURF_ROAD;
    if (this.walkIndex.query(x, z) >= 0) return SURF_WALK;
    if (this.waterIndex.query(x, z) >= 0) return SURF_WATER;
    return SURF_GRASS;
  }

  onRoad(x: number, z: number) {
    return this.asphaltIndex.query(x, z) >= 0;
  }

  insideBuilding(x: number, z: number) {
    return this.buildingIndex.query(x, z) >= 0;
  }

  isReserved(x: number, z: number, pad = 0) {
    return this.reserved.some((r) => Math.hypot(r.x - x, r.z - z) < r.r + pad);
  }

  /** Surface height for meshes: deck on bridges, terrain elsewhere. */
  private surfY(edge: number, x: number, z: number, s?: number) {
    const e = this.d.edges[edge];
    if (e.bridge) return this.d.heightOnEdge(edge, s ?? e.path.project(x, z).s);
    return this.d.terrain.height(x, z);
  }

  // ------------------------------------------------------------------ terrain
  private buildTerrain() {
    const t = this.d.data.terrain;
    if (!t) return;
    const T = this.d.terrain;
    const lc = this.landcover;
    const CH = 32; // cells per chunk (320 m)
    const ground = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
    ground.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix*vec4(transformed,1.0)).xyz;');
      // Fine grass grain only; broad variation lives in the vertex colours.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWP;
          float th(vec2 p){ p=fract(p*vec2(127.1,311.7)); p+=dot(p,p+19.19); return fract(p.x*p.y); }
          float tn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f); return mix(mix(th(i),th(i+vec2(1,0)),u.x),mix(th(i+vec2(0,1)),th(i+vec2(1,1)),u.x),u.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float g1 = tn(vWP.xz*1.7), g3 = tn(vWP.xz*6.0);
          diffuseColor.rgb *= 0.94 + g1*0.07 + g3*0.04;`);
    };
    const PALETTE = TERRAIN_PALETTE;
    const classAt = (i: number, j: number) => {
      i = Math.max(0, Math.min(t.width - 1, i));
      j = Math.max(0, Math.min(t.height - 1, j));
      return PALETTE[lc.cls[j * t.width + i]] ?? PALETTE[LC.open];
    };
    // Lake levels for the shoreline band.
    const lakeLevel = (x: number, z: number) => {
      const id = this.waterIndex.query(x, z);
      if (id >= 0) return this.d.data.water[id].level ?? -1;
      for (const [ox, oz] of [[12, 0], [-12, 0], [0, 12], [0, -12]]) {
        const j = this.waterIndex.query(x + ox, z + oz);
        if (j >= 0) return this.d.data.water[j].level ?? -1;
      }
      return -1;
    };
    const W = [1, 2, 1, 2, 4, 2, 1, 2, 1];
    // Colour of grid vertex (i, j): class colours blended over the 3x3 neighbourhood
    // (soft ~20 m boundaries instead of 10 m blocks), broad low-frequency variation,
    // bare soil on steep slopes, a narrow shore band. Identical for every LOD.
    const vertexColor = (i: number, j: number) => {
      let r = 0, g = 0, b = 0, k = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const c = classAt(i + di, j + dj), w = W[k++];
        r += c[0] * w; g += c[1] * w; b += c[2] * w;
      }
      r /= 16; g /= 16; b /= 16;
      const x = t.originX + i * t.spacing, z = t.originZ + j * t.spacing;
      const v = 0.95 + 0.1 * fbm(x / 450, z / 450);
      r *= v; g *= v; b *= v;
      const hx = T.sample(i + 1, j) - T.sample(i - 1, j), hz = T.sample(i, j + 1) - T.sample(i, j - 1);
      const slope = Math.hypot(hx, hz) / (2 * t.spacing);
      const soil = Math.min(1, Math.max(0, (slope - 0.35) / 0.25));
      r += (0.36 - r) * soil; g += (0.31 - g) * soil; b += (0.22 - b) * soil;
      const level = lakeLevel(x, z);
      const y = T.sample(i, j);
      if (level >= 0 && y < level + 0.6) { r = 0.42; g = 0.38; b = 0.27; }
      return [r, g, b];
    };
    // Normals from the whole heightfield, so lighting is continuous across chunks and LODs.
    const vertexNormal = (i: number, j: number): [number, number, number] => {
      const nx = -(T.sample(i + 1, j) - T.sample(i - 1, j)) / (2 * t.spacing);
      const nz = -(T.sample(i, j + 1) - T.sample(i, j - 1)) / (2 * t.spacing);
      const l = Math.hypot(nx, 1, nz);
      return [nx / l, 1 / l, nz / l];
    };
    const colorCache = new Map<number, number[]>();
    const colorOf = (i: number, j: number) => {
      const key = j * t.width + i;
      let c = colorCache.get(key);
      if (!c) colorCache.set(key, (c = vertexColor(i, j)));
      return c;
    };
    const build = (ci: number, cj: number, step: number) => {
      const i0 = ci * CH, j0 = cj * CH;
      const i1 = Math.min(t.width - 1, i0 + CH), j1 = Math.min(t.height - 1, j0 + CH);
      const pos: number[] = [], col: number[] = [], nor: number[] = [], idx: number[] = [];
      const cols = Math.floor((i1 - i0) / step) + 1, rows = Math.floor((j1 - j0) / step) + 1;
      const gi = (ii: number) => Math.min(i1, i0 + ii * step), gj = (jj: number) => Math.min(j1, j0 + jj * step);
      const vert = (i: number, j: number, drop = 0) => {
        pos.push(t.originX + i * t.spacing, T.sample(i, j) - drop, t.originZ + j * t.spacing);
        col.push(...colorOf(i, j));
        nor.push(...vertexNormal(i, j));
        return pos.length / 3 - 1;
      };
      for (let jj = 0; jj < rows; jj++) for (let ii = 0; ii < cols; ii++) vert(gi(ii), gj(jj));
      for (let jj = 0; jj < rows - 1; jj++) for (let ii = 0; ii < cols - 1; ii++) {
        const a = jj * cols + ii, b = a + 1, c = a + cols, e = c + 1;
        idx.push(a, c, b, b, c, e);
      }
      // Skirts: a short wall down from every border vertex hides any crack where a
      // detailed chunk meets a coarse one.
      const border: number[] = [];
      for (let ii = 0; ii < cols; ii++) border.push(ii);
      for (let jj = 1; jj < rows; jj++) border.push(jj * cols + cols - 1);
      for (let ii = cols - 2; ii >= 0; ii--) border.push((rows - 1) * cols + ii);
      for (let jj = rows - 2; jj >= 1; jj--) border.push(jj * cols);
      const skirt = border.map((v) => {
        const i = Math.round((pos[v * 3] - t.originX) / t.spacing), j = Math.round((pos[v * 3 + 2] - t.originZ) / t.spacing);
        return vert(i, j, 4);
      });
      for (let k = 0; k < border.length; k++) {
        const a = border[k], b = border[(k + 1) % border.length], sa = skirt[k], sb = skirt[(k + 1) % border.length];
        idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa); // both windings: seen from either side
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      return geo;
    };
    for (let cj = 0; cj * CH < t.height - 1; cj++) for (let ci = 0; ci * CH < t.width - 1; ci++) {
      const hi = new THREE.Mesh(build(ci, cj, 1), ground);
      const lo = new THREE.Mesh(build(ci, cj, 4), ground);
      hi.receiveShadow = true;
      lo.visible = false;
      this.group.add(hi, lo);
      this.terrainChunks.push({ center: hi.geometry.boundingSphere!.center.clone(), hi, lo });
    }
    // The material's shader hook shares this scope's closure context, which would
    // otherwise keep ~1M cached colours alive for the whole session.
    colorCache.clear();
  }

  // ------------------------------------------------------------------ roads
  private buildRoads() {
    const walk = new GeoBuilder();
    const terrace = new GeoBuilder();
    const road = new GeoBuilder();
    const ground = this.d.terrain;
    // `shoulders`: the layer is wider than the asphalt; drape only the strips
    // outside the asphalt so terrain beside a cut can never lift it through the road.
    const drape = (layer: RoadLayer, g: GeoBuilder, lift: number, colorFor: (edge: number) => [number, number, number], shoulders = false) => {
      for (const s of layer.strips) {
        const e = this.d.edges[s.edge];
        g.color = colorFor(s.edge);
        const L = s.left, R = s.right, C = s.center;
        for (let i = 0; i + 3 < L.length; i += 2) {
          // Subdivide each quad every ~4 m so the road follows the hills.
          const segLen = Math.hypot(C[i + 2] - C[i], C[i + 3] - C[i + 1]);
          const n = Math.max(1, Math.ceil(segLen / 4));
          // Cross-section fraction where the asphalt edge sits (1 = outer edge).
          const half0 = Math.hypot(L[i] - C[i], L[i + 1] - C[i + 1]) || 1;
          const f = shoulders ? Math.min(0.98, e.width / 2 / half0) : 0;
          for (let k = 0; k < n; k++) {
            const t0 = k / n, t1 = (k + 1) / n;
            const P = (arr: number[], tt: number, toward = 0): [number, number, number] => {
              let x = arr[i] + (arr[i + 2] - arr[i]) * tt, z = arr[i + 1] + (arr[i + 3] - arr[i + 1]) * tt;
              const cx = C[i] + (C[i + 2] - C[i]) * tt, cz = C[i + 1] + (C[i + 3] - C[i + 1]) * tt;
              if (toward) { x = cx + (x - cx) * toward; z = cz + (z - cz) * toward; }
              const y = e.bridge ? this.surfY(s.edge, cx, cz) : ground.height(x, z);
              return [x, y + lift, z];
            };
            if (!shoulders && !e.bridge && e.width > 15) {
              // Wide roads on the ground: split across too, so a crowned or uneven
              // stamp never rises through the middle of the asphalt.
              const m = Math.ceil(e.width / 6);
              const A0 = P(L, t0), B0 = P(R, t0), A1 = P(L, t1), B1 = P(R, t1);
              const at = (a: [number, number, number], b: [number, number, number], u: number): [number, number, number] => {
                const x = a[0] + (b[0] - a[0]) * u, z = a[2] + (b[2] - a[2]) * u;
                return [x, ground.height(x, z) + lift, z];
              };
              for (let q = 0; q < m; q++) g.quad(at(A0, B0, q / m), at(A0, B0, (q + 1) / m), at(A1, B1, (q + 1) / m), at(A1, B1, q / m), 0, 1, 0);
            } else if (!shoulders || e.bridge) g.quad(P(L, t0), P(R, t0), P(R, t1), P(L, t1), 0, 1, 0);
            else {
              g.quad(P(L, t0), P(L, t0, f), P(L, t1, f), P(L, t1), 0, 1, 0);
              g.quad(P(R, t0, f), P(R, t0), P(R, t1), P(R, t1, f), 0, 1, 0);
            }
          }
        }
      }
      for (const j of layer.junctions) {
        const n = this.d.nodes[j.node];
        g.color = colorFor(n.edges[0]);
        const contour: THREE.Vector2[] = [];
        for (let i = 0; i < j.poly.length; i += 2) contour.push(new THREE.Vector2(j.poly[i], j.poly[i + 1]));
        if (contour.length < 3) continue;
        const tris = THREE.ShapeUtils.triangulateShape(contour, []);
        const onBridge = n.edges.some((ei) => this.d.edges[ei].bridge);
        const ny = onBridge ? (this.d.data.nodeY?.[j.node] ?? ground.height(n.x, n.z)) : 0;
        // Wide layers: never above the junction's own asphalt.
        const cap = shoulders ? ground.height(n.x, n.z) + 0.02 : Infinity;
        const Y = (v: THREE.Vector2) => (onBridge ? ny : Math.min(cap, ground.height(v.x, v.y))) + lift;
        for (const [a, b, c] of tris) {
          g.tri([contour[a].x, Y(contour[a]), contour[a].y], [contour[b].x, Y(contour[b]), contour[b].y], [contour[c].x, Y(contour[c]), contour[c].y], 0, 1, 0);
        }
      }
    };
    const tint = (ei: number): [number, number, number] => {
      const e = this.d.edges[ei];
      // Decks that merge overlap at ramps: one shade, so the overlap never shimmers.
      if (MAP.city && e.bridge) return [0.95, 0.95, 0.97];
      const v = (hash32(ei) % 100) / 100;
      const base = e.cls === 'motorway' || e.cls.endsWith('link') ? 0.92 : e.cls === 'residential' ? 1.08 : 1.0;
      const k = base * (0.92 + v * 0.14);
      return [k, k, k * 1.02];
    };
    drape(this.sidewalk, walk, 0.03, (ei) => (this.town.has(ei) || this.d.edges[ei].bridge ? [1, 1, 1] : [0.72, 0.62, 0.48]), true);
    drape(this.terrace, terrace, 0.045, () => hexColor('#3b5a24'), true);
    drape(this.asphalt, road, ROAD_LIFT, tint);
    // Layer order on the ground: terrain < shoulders/sidewalks < terrace < asphalt < markings.
    const walkMat = concreteMaterial();
    walkMat.polygonOffset = true;
    walkMat.polygonOffsetFactor = -1;
    walkMat.polygonOffsetUnits = -1;
    const walkMesh = new THREE.Mesh(walk.build(), walkMat);
    const terraceMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    terraceMat.polygonOffset = true;
    terraceMat.polygonOffsetFactor = -1.5;
    terraceMat.polygonOffsetUnits = -1.5;
    const roadMat = wetAsphalt(this.opts.lowEffects, worldUniforms.wetness);
    roadMat.polygonOffset = true;
    roadMat.polygonOffsetFactor = -2;
    roadMat.polygonOffsetUnits = -2;
    const roadMesh = new THREE.Mesh(road.build(), roadMat);
    roadMesh.name = 'asphalt';
    for (const m of [walkMesh, roadMesh]) m.receiveShadow = true;
    this.group.add(walkMesh, new THREE.Mesh(terrace.build(), terraceMat), roadMesh);
  }

  private buildCurbs() {
    const g = new GeoBuilder();
    g.color = hexColor('#8d8a83');
    const h = 0.14, w = 0.24;
    const T = this.d.terrain;
    for (const c of this.curbs) {
      const outer = offsetPolyline(c, w);
      for (let i = 0; i + 3 < c.length; i += 2) {
        const ax = c[i], az = c[i + 1], bx = c[i + 2], bz = c[i + 3];
        const ox = outer[i], oz = outer[i + 1], px = outer[i + 2], pz = outer[i + 3];
        const ya = T.height(ax, az) + ROAD_LIFT - 0.02, yb = T.height(bx, bz) + ROAD_LIFT - 0.02;
        const dx = bx - ax, dz = bz - az;
        const l = Math.hypot(dx, dz) || 1;
        g.quad([ax, ya, az], [bx, yb, bz], [bx, yb + h, bz], [ax, ya + h, az], dz / l, 0, -dx / l);
        g.quad([ax, ya + h, az], [bx, yb + h, bz], [px, yb + h, pz], [ox, ya + h, oz], 0, 1, 0);
      }
    }
    this.group.add(new THREE.Mesh(g.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 })));
  }

  // ------------------------------------------------------------------ markings
  private buildMarkings() {
    const yellow = new GeoBuilder();
    const white = new GeoBuilder();
    yellow.color = hexColor('#d1a838');
    white.color = hexColor('#dedcd4');
    const lift = ROAD_LIFT + 0.015;
    const ribbon = (g: GeoBuilder, edge: number, pts: number[], off: number, width: number, dash = 0, gap = 0) => {
      const a = offsetPolyline(pts, off - width / 2);
      const b = offsetPolyline(pts, off + width / 2);
      const Y = (x: number, z: number, cx: number, cz: number) => this.surfY(edge, cx, cz) * (this.d.edges[edge].bridge ? 1 : 0) + (this.d.edges[edge].bridge ? 0 : this.d.terrain.height(x, z)) + lift;
      const onDeck = this.d.edges[edge].bridge;
      // Where two decks merge (ramps leaving a viaduct), only one set of lines shows.
      const put = (A: [number, number, number], B: [number, number, number], C: [number, number, number], D: [number, number, number]) => {
        if (onDeck && MAP.city) {
          const mx = (A[0] + C[0]) / 2, mz = (A[2] + C[2]) / 2;
          if (this.ground.otherDeckAt(mx, mz, (A[1] + C[1]) / 2 - lift, { self: edge, kinds: 'edges', tol: 0.6 })) return;
        }
        g.quad(A, B, C, D, 0, 1, 0);
      };
      let s = 0;
      for (let i = 0; i + 3 < a.length; i += 2) {
        const segL = Math.hypot(a[i + 2] - a[i], a[i + 3] - a[i + 1]);
        const step = dash ? 0 : 4;
        if (!dash) {
          const n = Math.max(1, Math.ceil(segL / step));
          for (let k = 0; k < n; k++) {
            const t0 = k / n, t1 = (k + 1) / n;
            const P = (arr: number[], tt: number): [number, number, number] => {
              const x = arr[i] + (arr[i + 2] - arr[i]) * tt, z = arr[i + 1] + (arr[i + 3] - arr[i + 1]) * tt;
              const cx = pts[i] + (pts[i + 2] - pts[i]) * tt, cz = pts[i + 1] + (pts[i + 3] - pts[i + 1]) * tt;
              return [x, Y(x, z, cx, cz), z];
            };
            put(P(a, t0), P(b, t0), P(b, t1), P(a, t1));
          }
          continue;
        }
        let t = 0;
        while (t < segL) {
          const phase = s % (dash + gap);
          const inDash = phase < dash;
          const st = Math.min(segL - t, inDash ? dash - phase : dash + gap - phase);
          if (inDash && st > 0.05) {
            const t0 = t / segL, t1 = (t + st) / segL;
            const P = (arr: number[], tt: number): [number, number, number] => {
              const x = arr[i] + (arr[i + 2] - arr[i]) * tt, z = arr[i + 1] + (arr[i + 3] - arr[i + 1]) * tt;
              const cx = pts[i] + (pts[i + 2] - pts[i]) * tt, cz = pts[i + 1] + (pts[i + 3] - pts[i + 1]) * tt;
              return [x, Y(x, z, cx, cz), z];
            };
            put(P(a, t0), P(b, t0), P(b, t1), P(a, t1));
          }
          t += st;
          s += st;
        }
      }
    };
    for (const s of this.asphalt.strips) {
      const e = this.d.edges[s.edge];
      if (s.s1 - s.s0 < 4) continue;
      const hw = e.width / 2;
      const rank = ROAD_RANK[e.cls] ?? 1;
      if (e.cls === 'motorway' || e.cls.endsWith('_link') && e.oneway) {
        // Freeway: yellow left edge, white right edge, dashed lanes.
        ribbon(yellow, s.edge, s.center, -(hw - 0.9), 0.15);
        ribbon(white, s.edge, s.center, hw - (e.cls === 'motorway' ? 2.6 : 0.6), 0.15);
        const lanes = Math.max(1, e.lanesF);
        const usable = e.cls === 'motorway' ? e.width - 4.5 : e.width - 1.5;
        const lw = usable / lanes;
        for (let k = 1; k < lanes; k++) ribbon(white, s.edge, s.center, -(hw - 0.9) + lw * k + 0.3, 0.13, 3, 9);
        continue;
      }
      if (!e.oneway && rank >= 2 && e.cls !== 'residential') {
        ribbon(yellow, s.edge, s.center, -0.13, 0.11);
        ribbon(yellow, s.edge, s.center, 0.13, 0.11);
        ribbon(white, s.edge, s.center, hw - 0.35, 0.1);
        ribbon(white, s.edge, s.center, -(hw - 0.35), 0.1);
      }
    }
    const mk = (g: GeoBuilder) => {
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, emissive: 0x1a1a18 });
      m.polygonOffset = true;
      m.polygonOffsetFactor = -4;
      m.polygonOffsetUnits = -4;
      return new THREE.Mesh(g.build(), m);
    };
    this.group.add(mk(yellow), mk(white));
  }

  // ------------------------------------------------------------------ water
  private insideDeck(x: number, z: number, margin = 0) {
    for (const deck of this.bridgeDecks) {
      if (pointInPolygon(x, z, deck.poly)) return true;
      if (margin > 0) for (let a = 0; a < 6; a++) {
        const t = (a / 6) * Math.PI * 2;
        if (pointInPolygon(x + Math.cos(t) * margin, z + Math.sin(t) * margin, deck.poly)) return true;
      }
    }
    return false;
  }

  private buildWater() {
    const surface = new GeoBuilder();
    for (const w of this.d.data.water) {
      const level = (w.level ?? 0) + 0.05;
      surface.flatPolygon(w.outer, level);
      // Shoreline collision: low banks stop cars at the water's edge.
      const ring = w.outer, n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const pieces = Math.max(1, Math.ceil(len / 3));
        for (let k = 0; k < pieces; k++) {
          const t0 = k / pieces, t1 = (k + 1) / pieces;
          const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
          if (this.insideDeck((x0 + x1) / 2, (z0 + z1) / 2, 2)) continue;
          // Only where a car could actually get to (near ground level of the shore).
          this.statics.addSegment(x0, z0, x1, z1, 'water', level - 3, level + 1.6);
        }
      }
    }
    const water = new THREE.Mesh(surface.build(), waterMaterial(this.time));
    water.name = 'water';
    this.group.add(water);
    // Rivers and streams as narrow ribbons.
    const streams = new GeoBuilder();
    streams.color = [1, 1, 1];
    for (const r of this.d.data.rivers) {
      const pts = r.pts;
      const width = (r as { w?: number }).w ?? 4;
      const a = offsetPolyline(pts, -width / 2), b = offsetPolyline(pts, width / 2);
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const Y = (x: number, z: number) => this.d.terrain.height(x, z) - 0.25;
        streams.quad([a[i], Y(a[i], a[i + 1]), a[i + 1]], [b[i], Y(b[i], b[i + 1]), b[i + 1]], [b[i + 2], Y(b[i + 2], b[i + 3]), b[i + 3]], [a[i + 2], Y(a[i + 2], a[i + 3]), a[i + 3]], 0, 1, 0);
      }
    }
    if (streams.count) {
      const m = waterMaterial(this.time);
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      this.group.add(new THREE.Mesh(streams.build(), m));
    }
  }

  private buildBridges() {
    const g = new GeoBuilder();
    g.color = hexColor('#8a857b');
    const rail = new GeoBuilder();
    rail.color = hexColor('#a8a296');
    const pier = new GeoBuilder();
    pier.color = hexColor('#77736a');
    const G = this.ground;
    const T = this.d.terrain;
    /**
     * Fascia, rail and rail collider along one deck edge segment. `nx, nz` points out
     * of the deck. Skipped where the outside is another deck at the same height
     * (a ramp merging, a slab over a tunnel): that edge is open road, not a drop.
     */
    const edgeSeg = (ax: number, az: number, bx: number, bz: number, ya: number, yb: number, nx: number, nz: number, self: number, selfNode: number) => {
      const mx = (ax + bx) / 2 + nx * 0.8, mz = (az + bz) / 2 + nz * 0.8;
      if (G.otherDeckAt(mx, mz, (ya + yb) / 2, { self, selfNode })) return;
      g.quad([ax, ya + 0.02, az], [bx, yb + 0.02, bz], [bx, yb - 1.4, bz], [ax, ya - 1.4, az], nx, 0, nz);
      const ix = -nx * 0.35, iz = -nz * 0.35, hh = 1.0;
      rail.quad([ax, ya, az], [bx, yb, bz], [bx, yb + hh, bz], [ax, ya + hh, az], nx, 0, nz);
      rail.quad([ax + ix, ya, az + iz], [bx + ix, yb, bz + iz], [bx + ix, yb + hh, bz + iz], [ax + ix, ya + hh, az + iz], -nx, 0, -nz);
      rail.quad([ax, ya + hh, az], [bx, yb + hh, bz], [bx + ix, yb + hh, bz + iz], [ax + ix, ya + hh, az + iz], 0, 1, 0);
      this.statics.addSegment(ax + ix, az + iz, bx + ix, bz + iz, 'rail', Math.min(ya, yb) - 0.6, Math.max(ya, yb) + 1.1);
    };
    /** A pier under a deck, unless it would stand on a road (at any level below). */
    const pierAt = (cx: number, cz: number, top: number, self: number, selfName: string) => {
      const below = G.surface(cx, cz, top - 1.3);
      // Never on a road deck, and never on the plaza over a tunnel (decks span those).
      if (below.deck >= 0) return;
      const base = below.h - 1;
      if (top - base < 2) return;
      // Never stand a pier in a road passing underneath (lanes plus shoulder).
      const under = this.d.nearestEdge(cx, cz, 30, (u) => u.index !== self && u.name !== selfName, below.h);
      if (under && Math.hypot(under.x - cx, under.z - cz) < this.d.edges[under.edge].width / 2 + 3) return;
      const r = 0.6;
      for (let k = 0; k < 8; k++) {
        const a0 = (k / 8) * Math.PI * 2, a1 = ((k + 1) / 8) * Math.PI * 2;
        const x0 = cx + Math.cos(a0) * r, z0 = cz + Math.sin(a0) * r, x1 = cx + Math.cos(a1) * r, z1 = cz + Math.sin(a1) * r;
        pier.quad([x0, base, z0], [x1, base, z1], [x1, top, z1], [x0, top, z0], Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2));
      }
      this.statics.addCircle(cx, cz, r, 'post', base, top);
    };
    for (const s of this.sidewalk.strips) {
      const e = this.d.edges[s.edge];
      if (!e.bridge) continue;
      const L = s.left, R = s.right, C = s.center;
      const Y = (cx: number, cz: number) => this.surfY(s.edge, cx, cz);
      for (const [side, sign] of [[L, -1], [R, 1]] as const) {
        for (let i = 0; i + 3 < side.length; i += 2) {
          const ax = side[i], az = side[i + 1], bx = side[i + 2], bz = side[i + 3];
          const ya = Y(C[i], C[i + 1]), yb = Y(C[i + 2], C[i + 3]);
          const dx = bx - ax, dz = bz - az;
          const l = Math.hypot(dx, dz) || 1;
          // Long straight pieces are split so merges clip cleanly.
          const n = Math.max(1, Math.ceil(l / 6));
          for (let k = 0; k < n; k++) {
            const t0 = k / n, t1 = (k + 1) / n;
            edgeSeg(ax + dx * t0, az + dz * t0, ax + dx * t1, az + dz * t1, ya + (yb - ya) * t0, ya + (yb - ya) * t1, (-dz / l) * sign, (dx / l) * sign, s.edge, -2);
          }
        }
      }
      for (let i = 0; i + 3 < L.length; i += 2) {
        const y0 = Y(C[i], C[i + 1]), y1 = Y(C[i + 2], C[i + 3]);
        // No underside inside a slab (a street crossing a tunnel lid).
        if (G.otherDeckAt((C[i] + C[i + 2]) / 2, (C[i + 1] + C[i + 3]) / 2, (y0 + y1) / 2, { kinds: 'slabs' })) continue;
        g.quad([L[i], y0 - 1.4, L[i + 1]], [R[i], y0 - 1.4, R[i + 1]], [R[i + 2], y1 - 1.4, R[i + 3]], [L[i + 2], y1 - 1.4, L[i + 3]], 0, -1, 0);
      }
      // Piers every ~18 m where the deck is well above the ground.
      const len = s.s1 - s.s0;
      for (let d = 6; d < len - 4; d += 18) {
        const p = e.path.pointAt(s.s0 + d);
        const top = this.d.heightOnEdge(s.edge, s.s0 + d) - 1.4;
        if (top - T.height(p.x, p.z) < 2) continue;
        const h = e.path.headingAt(s.s0 + d);
        const rx = -Math.cos(h), rz = Math.sin(h);
        for (const off of [-(e.width / 2 - 1.5), e.width / 2 - 1.5]) pierAt(p.x + rx * off, p.z + rz * off, top, s.edge, e.name);
      }
    }
    // Junctions up on a deck: fascia and rails around the open sides, an underside, a pier.
    for (const j of this.sidewalk.junctions) {
      const n = this.d.nodes[j.node];
      const y = this.d.data.nodeY?.[j.node];
      if (y === undefined || !n.edges.some((ei) => this.d.edges[ei].bridge) || y - T.height(n.x, n.z) < 1.5) continue;
      for (const out of j.edgesOut) {
        for (let i = 0; i + 3 < out.length; i += 2) {
          const ax = out[i], az = out[i + 1], bx = out[i + 2], bz = out[i + 3];
          const dx = bx - ax, dz = bz - az;
          const l = Math.hypot(dx, dz);
          if (l < 0.05) continue;
          let nx = -dz / l, nz = dx / l;
          if (pointInPolygon((ax + bx) / 2 + nx * 0.3, (az + bz) / 2 + nz * 0.3, j.poly)) { nx = -nx; nz = -nz; }
          edgeSeg(ax, az, bx, bz, y, y, nx, nz, -2, j.node);
        }
      }
      if (j.poly.length >= 6) {
        const contour: THREE.Vector2[] = [];
        for (let i = 0; i < j.poly.length; i += 2) contour.push(new THREE.Vector2(j.poly[i], j.poly[i + 1]));
        for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
          g.tri([contour[a].x, y - 1.4, contour[a].y], [contour[c].x, y - 1.4, contour[c].y], [contour[b].x, y - 1.4, contour[b].y], 0, -1, 0);
        }
      }
      pierAt(n.x, n.z, y - 1.4, -2, '');
    }
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
    this.group.add(new THREE.Mesh(g.build(), mat), new THREE.Mesh(rail.build(), mat), new THREE.Mesh(pier.build(), mat));
  }

  // ------------------------------------------------------------------ tunnels
  /** Trench walls, tunnel roofs and the street-level slabs and barriers around them. */
  private buildUnder() {
    const U = this.d.data.under;
    if (!U) return;
    const top = U.top;
    const wall = new GeoBuilder();
    const slab = new GeoBuilder();
    const ceil = new GeoBuilder();
    const barrier = new GeoBuilder();
    const concrete: [number, number, number] = [0.62, 0.61, 0.58];
    const grime: [number, number, number] = [0.33, 0.32, 0.3];
    for (const w of U.walls) {
      const [ax, az, bx, bz, fa, fb, side, covered] = w;
      const nx = Math.abs(side) === 1 ? Math.sign(side) : 0, nz = Math.abs(side) === 2 ? Math.sign(side) : 0;
      const roof = covered ? top - 1 : top;
      // Wound to face the floor side.
      const [px, pz, qx, qz, pa, pb] = (bx - ax) * nz - (bz - az) * nx > 0 ? [ax, az, bx, bz, fa, fb] : [bx, bz, ax, az, fb, fa];
      wall.color = grime;
      wall.quad([px, pa - 0.3, pz], [qx, pb - 0.3, qz], [qx, pb + 0.9, qz], [px, pa + 0.9, pz], nx, 0, nz);
      wall.color = concrete;
      wall.quad([px, pa + 0.9, pz], [qx, pb + 0.9, qz], [qx, roof, qz], [px, roof, pz], nx, 0, nz);
      this.statics.addSegment(ax, az, bx, bz, 'building', Math.min(fa, fb) - 1, top - 1.2);
    }
    const lift = 0.035;
    slab.color = [0.78, 0.77, 0.74];
    for (const r of [...U.copings, ...U.lids]) {
      const [x0, z0, x1, z1] = r;
      slab.quad([x0, top + lift, z0], [x0, top + lift, z1], [x1, top + lift, z1], [x1, top + lift, z0], 0, 1, 0);
    }
    ceil.color = [0.42, 0.41, 0.39];
    for (const r of U.lids) {
      const [x0, z0, x1, z1] = r;
      const yb = top - 1;
      ceil.quad([x0, yb, z0], [x1, yb, z0], [x1, yb, z1], [x0, yb, z1], 0, -1, 0);
      // Headwalls where the roof ends over an open trench.
      ceil.quad([x0, yb, z0], [x0, top, z0], [x1, top, z0], [x1, yb, z0], 0, 0, -1);
      ceil.quad([x1, yb, z1], [x1, top, z1], [x0, top, z1], [x0, yb, z1], 0, 0, 1);
      ceil.quad([x0, yb, z1], [x0, top, z1], [x0, top, z0], [x0, yb, z0], -1, 0, 0);
      ceil.quad([x1, yb, z0], [x1, top, z0], [x1, top, z1], [x1, yb, z1], 1, 0, 0);
    }
    barrier.color = [0.74, 0.73, 0.7];
    for (const b of U.barriers) {
      const [ax, az, bx, bz] = b;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      // A street bridging the trench here has its own rails.
      if (this.ground.otherDeckAt(mx, mz, top, { kinds: 'edges' })) continue;
      const dx = bx - ax, dz = bz - az;
      const l = Math.hypot(dx, dz) || 1;
      let nx = -dz / l, nz = dx / l;
      // Push the barrier onto the street side of the trench edge.
      if (this.d.terrain.height(mx + nx * 3, mz + nz * 3) < top - 0.5 && !this.ground.otherDeckAt(mx + nx * 3, mz + nz * 3, top, { kinds: 'slabs' })) { nx = -nx; nz = -nz; }
      const o = 0.3, hh = 1.05, w2 = 0.3;
      const P = (x: number, z: number, off: number, y: number): [number, number, number] => [x + nx * off, y, z + nz * off];
      barrier.quad(P(ax, az, o - w2, top), P(bx, bz, o - w2, top), P(bx, bz, o - w2 * 0.4, top + hh), P(ax, az, o - w2 * 0.4, top + hh), -nx, 0.2, -nz);
      barrier.quad(P(bx, bz, o + w2, top), P(ax, az, o + w2, top), P(ax, az, o + w2 * 0.4, top + hh), P(bx, bz, o + w2 * 0.4, top + hh), nx, 0.2, nz);
      barrier.quad(P(ax, az, o - w2 * 0.4, top + hh), P(bx, bz, o - w2 * 0.4, top + hh), P(bx, bz, o + w2 * 0.4, top + hh), P(ax, az, o + w2 * 0.4, top + hh), 0, 1, 0);
      this.statics.addSegment(ax + nx * o, az + nz * o, bx + nx * o, bz + nz * o, 'rail', top - 0.6, top + 1.1);
    }
    const wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide });
    const slabMat = concreteMaterial();
    slabMat.polygonOffset = true;
    slabMat.polygonOffsetFactor = -0.5;
    slabMat.polygonOffsetUnits = -0.5;
    const ceilMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
    const slabMesh = new THREE.Mesh(slab.build(), slabMat);
    slabMesh.receiveShadow = true;
    this.group.add(new THREE.Mesh(wall.build(), wallMat), slabMesh, new THREE.Mesh(ceil.build(), ceilMat), new THREE.Mesh(barrier.build(), wallMat));
  }

  /** Terrain-like colour for surfaces drawn over the ground (cave roofs). */
  private groundColorAt(x: number, z: number, slope: number): [number, number, number] {
    const c = TERRAIN_PALETTE[this.landcover.at(x, z)] ?? TERRAIN_PALETTE[LC.open];
    const v = 0.95 + 0.1 * fbm(x / 450, z / 450);
    let r = c[0] * v, g = c[1] * v, b = c[2] * v;
    const soil = Math.min(1, Math.max(0, (slope - 0.35) / 0.25));
    r += (0.36 - r) * soil; g += (0.31 - g) * soil; b += (0.22 - b) * soil;
    return [r, g, b];
  }

  /**
   * Caves and speed tubes: walls, a roof, the hill over a cave (drawn over the cut
   * in the terrain), portals at the open ends, and colliders along the walls.
   */
  private buildTubes() {
    const tubes = this.d.data.tubes ?? [];
    if (!tubes.length) return;
    const d = this.d;
    const S = d.surface ?? d.terrain;
    const rock = new GeoBuilder();
    const concrete = new GeoBuilder();
    const hill = new GeoBuilder();
    // A tube end that meets another tube is not a portal.
    const ends = new Map<number, number>();
    for (const t of tubes) for (const n of [d.edges[t.edge].a, d.edges[t.edge].b]) ends.set(n, (ends.get(n) ?? 0) + 1);
    for (const t of tubes) {
      const e = d.edges[t.edge];
      const n = Math.max(2, Math.ceil(e.length / 4));
      const at = (k: number) => {
        const sAt = (k / n) * e.length;
        const p = e.path.pointAt(sAt);
        const h = e.path.headingAt(sAt);
        return { x: p.x, z: p.z, rx: -Math.cos(h), rz: Math.sin(h), y: d.heightOnEdge(t.edge, sAt) };
      };
      const g = t.cave ? rock : concrete;
      const W = t.hw, top = t.h;
      const wallCol = (k: number): [number, number, number] => {
        if (!t.cave) return [0.66, 0.65, 0.62];
        const v = 0.85 + 0.3 * fbm(k * 0.21, t.edge * 3.7);
        return [0.36 * v, 0.33 * v, 0.29 * v];
      };
      // Roof top over a cave: the hill, lifted into a hood where it is thinner than the roof.
      const lat = t.cave ? [-1, -0.8, -0.6, -0.45, -0.32, -0.2, -0.1, 0, 0.1, 0.2, 0.32, 0.45, 0.6, 0.8, 1].map((f) => f * (W + 33)) : [];
      const hillY = (q: ReturnType<typeof at>, l: number) => {
        const x = q.x + q.rx * l, z = q.z + q.rz * l;
        const hood = q.y + top + 1.2 - Math.max(0, Math.abs(l) - (W + 1.5));
        return Math.max(S.height(x, z), hood) + 0.12;
      };
      for (let k = 0; k < n; k++) {
        const A = at(k), B = at(k + 1);
        // Walls (inside faces) and the ceiling.
        g.color = wallCol(k);
        for (const side of [-1, 1]) {
          const ax = A.x + A.rx * W * side, az = A.z + A.rz * W * side, bx = B.x + B.rx * W * side, bz = B.z + B.rz * W * side;
          g.quad([ax, A.y - 0.4, az], [bx, B.y - 0.4, bz], [bx, B.y + top, bz], [ax, A.y + top, az], -A.rx * side, 0, -A.rz * side);
          this.statics.addSegment(ax, az, bx, bz, 'building', Math.min(A.y, B.y) - 1, Math.max(A.y, B.y) + top);
        }
        g.color = t.cave ? [0.27, 0.25, 0.22] : [0.5, 0.5, 0.49];
        g.quad([A.x - A.rx * W, A.y + top, A.z - A.rz * W], [A.x + A.rx * W, A.y + top, A.z + A.rz * W], [B.x + B.rx * W, B.y + top, B.z + B.rz * W], [B.x - B.rx * W, B.y + top, B.z - B.rz * W], 0, -1, 0);
        if (!t.cave) {
          // The tube's outside: walls down to the ground (or the deck's fascia) and a roof.
          const O = W + 0.8, base = e.bridge ? -1.4 : -0.6, roof = top + 0.7;
          concrete.color = [0.74, 0.73, 0.7];
          for (const side of [-1, 1]) {
            const ax = A.x + A.rx * O * side, az = A.z + A.rz * O * side, bx = B.x + B.rx * O * side, bz = B.z + B.rz * O * side;
            concrete.quad([ax, A.y + base, az], [bx, B.y + base, bz], [bx, B.y + roof, bz], [ax, A.y + roof, az], A.rx * side, 0, A.rz * side);
          }
          concrete.color = [0.58, 0.57, 0.55];
          concrete.quad([B.x - B.rx * O, B.y + roof, B.z - B.rz * O], [B.x + B.rx * O, B.y + roof, B.z + B.rz * O], [A.x + A.rx * O, A.y + roof, A.z + A.rz * O], [A.x - A.rx * O, A.y + roof, A.z - A.rz * O], 0, 1, 0);
        } else {
          for (let i = 0; i + 1 < lat.length; i++) {
            const p0 = [A.x + A.rx * lat[i], hillY(A, lat[i]), A.z + A.rz * lat[i]] as [number, number, number];
            const p1 = [A.x + A.rx * lat[i + 1], hillY(A, lat[i + 1]), A.z + A.rz * lat[i + 1]] as [number, number, number];
            const p2 = [B.x + B.rx * lat[i + 1], hillY(B, lat[i + 1]), B.z + B.rz * lat[i + 1]] as [number, number, number];
            const p3 = [B.x + B.rx * lat[i], hillY(B, lat[i]), B.z + B.rz * lat[i]] as [number, number, number];
            const slope = Math.abs(p1[1] - p0[1]) / (Math.abs(lat[i + 1] - lat[i]) || 1) + Math.abs(p3[1] - p0[1]) / 4;
            hill.color = this.groundColorAt((p0[0] + p2[0]) / 2, (p0[2] + p2[2]) / 2, slope);
            hill.quad(p0, p3, p2, p1, 0, 1, 0);
          }
        }
      }
      // Portals at the open ends.
      for (const [k, node, out] of [[0, e.a, -1], [n, e.b, 1]] as const) {
        if ((ends.get(node) ?? 0) > 1) continue;
        const q = at(k);
        const fx = q.rz * out, fz = -q.rx * out; // along the road, out of the tube
        const nx = -fx, nz = -fz;
        void nx; void nz;
        const P = (l: number, y: number): [number, number, number] => [q.x + q.rx * l, y, q.z + q.rz * l];
        if (t.cave) {
          // Rock face from the roof up to the hill, and down beside the bore.
          rock.color = [0.4, 0.37, 0.33];
          for (let i = 0; i + 1 < lat.length; i++) {
            const l0 = lat[i], l1 = lat[i + 1];
            const b0 = Math.abs(l0) < W ? q.y + top : q.y - 3, b1 = Math.abs(l1) < W ? q.y + top : q.y - 3;
            const t0 = hillY(q, l0), t1 = hillY(q, l1);
            if (t0 <= b0 && t1 <= b1) continue;
            rock.quad(P(l0, b0), P(l1, b1), P(l1, Math.max(b1, t1)), P(l0, Math.max(b0, t0)), fx, 0, fz);
          }
          // A concrete collar around the mouth.
          concrete.color = [0.62, 0.6, 0.56];
          concrete.quad(P(-W - 1.5, q.y + top), P(W + 1.5, q.y + top), P(W + 1.5, q.y + top + 1.6), P(-W - 1.5, q.y + top + 1.6), fx, 0, fz);
          for (const side of [-1, 1]) concrete.quad(P(side * W, q.y - 0.4), P(side * (W + 1.5), q.y - 0.4), P(side * (W + 1.5), q.y + top), P(side * W, q.y + top), fx, 0, fz);
        } else {
          concrete.color = [0.82, 0.55, 0.2];
          const O = W + 0.8;
          concrete.quad(P(-O, q.y + top), P(O, q.y + top), P(O, q.y + top + 0.7), P(-O, q.y + top + 0.7), fx, 0, fz);
          for (const side of [-1, 1]) concrete.quad(P(side * W, q.y - 0.6), P(side * O, q.y - 0.6), P(side * O, q.y + top + 0.7), P(side * W, q.y + top + 0.7), fx, 0, fz);
        }
      }
    }
    const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
    const concreteMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    const hillMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96 });
    hillMat.polygonOffset = true;
    hillMat.polygonOffsetFactor = -1;
    hillMat.polygonOffsetUnits = -1;
    const hm = new THREE.Mesh(hill.build(), hillMat);
    hm.receiveShadow = true;
    this.group.add(new THREE.Mesh(rock.build(), rockMat), new THREE.Mesh(concrete.build(), concreteMat), hm);
  }

  // ------------------------------------------------------------------ buildings
  private buildBuildings() {
    const chunk = 400;
    const builders = new Map<string, GeoBuilder>();
    const getB = (x: number, z: number) => {
      const k = `${Math.floor(x / chunk)},${Math.floor(z / chunk)}`;
      let g = builders.get(k);
      if (!g) builders.set(k, (g = new GeoBuilder({ aFacade: 3, aStyle: 2 })));
      return g;
    };
    const drives = new GeoBuilder();
    const rng = new Rng(42);
    const siding = ['#e8e4da', '#d9d2c3', '#c7bfae', '#9aa7ad', '#7d8b93', '#b9a68b', '#a39886', '#8d9a84', '#c4b9a3', '#6f7a83', '#efece4', '#ad5a46'];
    const estateWall = ['#b6a790', '#9b8b74', '#c9bda6', '#8a6b55', '#d8d0c0', '#7d6a5a'];
    const brick = ['#7a3b2a', '#8a4a33', '#6e3426', '#94593d'];
    const stone = ['#a89c86', '#8c8172', '#b3a68e'];
    const roofCols = ['#2a2a2c', '#3a332e', '#2f3437', '#43352d', '#4d4a44', '#5a2e24'];
    const T = this.d.terrain;

    const wallLoop = (g: GeoBuilder, poly: number[], y0: number, y1: number, collide: boolean) => {
      const n = poly.length / 2;
      let u = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[j * 2], bz = poly[j * 2 + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.01) continue;
        const nx = (bz - az) / len, nz = -(bx - ax) / len;
        const h = y1 - y0;
        const f = (uu: number, v: number) => ({ aFacade: [uu, v, h] });
        g.tri([ax, y0, az], [bx, y0, bz], [bx, y1, bz], nx, 0, nz, f(u, 0), f(u + len, 0), f(u + len, h));
        g.tri([ax, y0, az], [bx, y1, bz], [ax, y1, az], nx, 0, nz, f(u, 0), f(u + len, h), f(u, h));
        u += len;
        if (collide) this.statics.addSegment(ax, az, bx, bz, 'building', y0 - 1, y1 + 2);
      }
    };
    const gable = (g: GeoBuilder, cx: number, cz: number, ax: number, az: number, halfL: number, halfW: number, yWall: number, pitch: number, color: string, wallColor: string, style: number, seed: number, hip: boolean) => {
      const ov = 0.4;
      const rise = Math.min(4.2, halfW * pitch);
      const L = halfL + ov, W = halfW + ov;
      const bx = -az, bz = ax;
      const P = (l: number, w: number, y: number): [number, number, number] => [cx + ax * l + bx * w, y, cz + az * l + bz * w];
      g.color = hexColor(color);
      g.set('aStyle', 5, seed);
      const yh = yWall + rise, y0 = yWall - ov * pitch;
      const ridge = hip ? Math.max(0.5, halfL - halfW) : L;
      g.quad(P(-L, W, y0), P(L, W, y0), P(ridge, 0, yh), P(-ridge, 0, yh), bx * 0.6, 0.8, bz * 0.6);
      g.quad(P(-L, -W, y0), P(L, -W, y0), P(ridge, 0, yh), P(-ridge, 0, yh), -bx * 0.6, 0.8, -bz * 0.6);
      if (hip) {
        g.tri(P(L, W, y0), P(L, -W, y0), P(ridge, 0, yh), ax, 0.8, az);
        g.tri(P(-L, W, y0), P(-L, -W, y0), P(-ridge, 0, yh), -ax, 0.8, -az);
      } else {
        g.color = hexColor(wallColor);
        g.set('aStyle', style, seed);
        const fA = { aFacade: [0, 0, 0] };
        g.tri(P(-halfL, halfW, yWall), P(-halfL, -halfW, yWall), P(-halfL, 0, yh), -ax, 0, -az, fA, fA, fA);
        g.tri(P(halfL, halfW, yWall), P(halfL, -halfW, yWall), P(halfL, 0, yh), ax, 0, az, fA, fA, fA);
      }
      return yh;
    };
    const box = (g: GeoBuilder, cx: number, cz: number, ax: number, az: number, halfL: number, halfW: number, y0: number, y1: number, color: string) => {
      const bx = -az, bz = ax;
      const P = (l: number, w: number, y: number): [number, number, number] => [cx + ax * l + bx * w, y, cz + az * l + bz * w];
      g.color = hexColor(color);
      g.set('aStyle', 5, 0);
      const faces: [number, number, number, number][] = [[1, 1, 1, -1], [1, -1, -1, -1], [-1, -1, -1, 1], [-1, 1, 1, 1]];
      for (const [l0, w0, l1, w1] of faces) {
        const nx = (l0 + l1) / 2 * ax + (w0 + w1) / 2 * bx, nz = (l0 + l1) / 2 * az + (w0 + w1) / 2 * bz;
        g.quad(P(l0 * halfL, w0 * halfW, y0), P(l1 * halfL, w1 * halfW, y0), P(l1 * halfL, w1 * halfW, y1), P(l0 * halfL, w0 * halfW, y1), nx, 0, nz);
      }
      g.quad(P(halfL, halfW, y1), P(-halfL, halfW, y1), P(-halfL, -halfW, y1), P(halfL, -halfW, y1), 0, 1, 0);
    };

    for (const bd of this.d.data.buildings) {
      const poly = bd.p;
      const n = poly.length / 2;
      let cx = 0, cz = 0, area = 0;
      for (let i = 0; i < n; i++) {
        cx += poly[i * 2]; cz += poly[i * 2 + 1];
        const j = (i + 1) % n;
        area += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
      }
      cx /= n; cz /= n; area = Math.abs(area / 2);
      if (this.isReserved(cx, cz, 4)) continue;
      let onRoad = 0;
      for (let i = 0; i < n; i++) if (this.walkIndex.query(poly[i * 2], poly[i * 2 + 1]) >= 0) onRoad++;
      if (onRoad > 0 || this.asphaltIndex.query(cx, cz) >= 0) continue;
      let ymin = Infinity, ymax = -Infinity;
      for (let i = 0; i < n; i++) { const y = T.height(poly[i * 2], poly[i * 2 + 1]); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
      const base = ymin - 0.4;
      const seed = (hash32(poly[0] * 1000 + poly[1]) % 1000) / 1000;
      const g = getB(cx, cz);
      this.buildingIndex.add(poly, 0);

      if (bd.gen) {
        // Generated house: main block, attached garage, roof, chimney, driveway.
        const fx = bd.fx ?? 0, fz = bd.fz ?? 1; // toward the street
        const ax = -fz, az = fx; // long axis along the street
        const halfL = Math.hypot(poly[0] - poly[2], poly[1] - poly[3]) / 2;
        const halfW = Math.hypot(poly[2] - poly[4], poly[3] - poly[5]) / 2;
        const estate = !!bd.est || halfL > 9;
        const stories = estate ? 2 : rng.chance(0.45) ? 2 : 1;
        const wallTop = ymax + 0.6 + stories * 2.9;
        const wall = estate ? rng.pick(estateWall) : rng.pick(siding);
        g.color = hexColor(wall);
        g.set('aStyle', estate && rng.chance(0.5) ? 1 : 0, seed);
        wallLoop(g, poly, base, wallTop, true);
        const top = gable(g, cx, cz, ax, az, halfL, halfW, wallTop, estate ? 0.55 : 0.6, rng.pick(roofCols), wall, estate ? 1 : 0, seed, estate || rng.chance(0.3));
        // Attached two-car garage on one end, door facing the street.
        const side = rng.chance(0.5) ? 1 : -1;
        const gl = 3.3, gw = Math.min(halfW, 4.2);
        const gx = cx + ax * side * (halfL + gl) + fx * (halfW - gw), gz = cz + az * side * (halfL + gl) + fz * (halfW - gw);
        const gTop = ymax + 3.0;
        box(g, gx, gz, ax, az, gl, gw, base, gTop, wall);
        gable(g, gx, gz, fx, fz, gw, gl, gTop, 0.45, rng.pick(roofCols), wall, 0, seed, false);
        // Garage door and front door panels on the street face.
        const door = (dcx: number, dcz: number, width: number, height: number, col: string) => {
          const bx = -fz, bz = fx;
          g.color = hexColor(col);
          g.set('aStyle', 5, seed);
          const y0 = T.height(dcx, dcz) + 0.05;
          const o = 0.06;
          g.quad([dcx + bx * width / 2 + fx * o, y0, dcz + bz * width / 2 + fz * o], [dcx - bx * width / 2 + fx * o, y0, dcz - bz * width / 2 + fz * o], [dcx - bx * width / 2 + fx * o, y0 + height, dcz - bz * width / 2 + fz * o], [dcx + bx * width / 2 + fx * o, y0 + height, dcz + bz * width / 2 + fz * o], fx, 0, fz);
        };
        door(gx + fx * gw, gz + fz * gw, 4.8, 2.3, '#d9d6cf');
        door(cx + fx * halfW - ax * side * 1.5, cz + fz * halfW - az * side * 1.5, 1.0, 2.1, rng.pick(['#5a2e24', '#283a52', '#2f3a2c', '#1d1d1d']));
        this.statics.addPolyline([
          gx + ax * gl + fx * gw, gz + az * gl + fz * gw, gx - ax * gl + fx * gw, gz - az * gl + fz * gw,
          gx - ax * gl - fx * gw, gz - az * gl - fz * gw, gx + ax * gl - fx * gw, gz + az * gl - fz * gw,
        ], 'building', true, base - 1, gTop + 2);
        if (rng.chance(0.55)) box(g, cx - ax * side * (halfL * 0.6), cz - az * side * (halfL * 0.6), ax, az, 0.6, 0.7, top - 2.2, top + 1.0, rng.pick(brick));
        // Driveway from the garage door to the street.
        const dx0 = gx + fx * gw, dz0 = gz + fz * gw;
        const drive = bd.drive && bd.drive.length >= 4 ? bd.drive : null;
        drives.color = estate ? hexColor('#5c574f') : hexColor('#8f8c86');
        if (drive) this.ribbon(drives, drive, 3.4, 0.03);
        else {
          const hit = this.d.nearestEdge(dx0, dz0, 60);
          if (hit) {
            const e = this.d.edges[hit.edge];
            const tx = hit.x + (dx0 - hit.x) * (e.width / 2) / Math.max(1, hit.d);
            const tz = hit.z + (dz0 - hit.z) * (e.width / 2) / Math.max(1, hit.d);
            this.ribbon(drives, [dx0, dz0, tx, tz], 4.6, 0.03);
          }
        }
        if (stories >= 1) this.houses.push({ cx, cz, ax, az, halfL, halfW, wallH: wallTop - base, street: { x: cx + fx * 30, z: cz + fz * 30 } });
        continue;
      }

      // OpenStreetMap footprint (or a generated city block).
      const downtown = this.isDowntown(cx, cz);
      let style: number, height: number, color: string;
      if (bd.st !== undefined) { style = bd.st; height = bd.h ?? 12; color = bd.col ?? rng.pick(stone); }
      else if (bd.barn) { style = 3; height = 7; color = '#8a2b22'; }
      else if (bd.k === 's' || area < 38) { style = 3; height = 3 + seed * 0.6; color = rng.pick(siding); }
      else if (bd.k === 'i') { style = 1; height = bd.h ?? (bd.l ? bd.l * 3.6 + 1 : 8 + seed * 4); color = rng.pick(brick); }
      else if (downtown && area > 70) { style = 2; height = bd.h ?? (bd.l ? bd.l * 3.6 + 0.8 : 7.5 + Math.floor(seed * 2) * 3.4); color = seed > 0.5 ? rng.pick(brick) : rng.pick(stone); }
      else if (bd.k === 'c' || area > 450) { style = 4; height = bd.h ?? (bd.l ? bd.l * 3.6 : 6 + seed * 3); color = rng.pick(stone); }
      else { style = 0; height = bd.h ?? (bd.l ? bd.l * 3 + 0.6 : 5.2 + seed * 1.4); color = rng.pick(siding); }
      if (!bd.tall) height = Math.min(height, 30);
      const wallTop = ymax + height;
      g.color = hexColor(color);
      g.set('aStyle', style, seed);
      wallLoop(g, poly, base, wallTop, true);
      const obb = orientedRect(poly);
      const fill = area / (obb.halfL * obb.halfW * 4);
      if ((style === 0 || style === 3) && fill > 0.72 && obb.halfW < 10) {
        gable(g, obb.cx, obb.cz, obb.ax, obb.az, obb.halfL, obb.halfW, wallTop, bd.barn ? 0.8 : style === 3 ? 0.35 : 0.62, bd.barn ? '#4a4844' : roofCols[Math.floor(seed * roofCols.length)], color, style, seed, false);
        if (style === 0) this.houses.push({ cx: obb.cx, cz: obb.cz, ax: obb.ax, az: obb.az, halfL: obb.halfL, halfW: obb.halfW, wallH: height, street: { x: 0, z: 0 } });
      } else {
        g.color = hexColor(style === 2 ? '#3b3632' : '#34322f');
        g.set('aStyle', 5, seed);
        g.set('aFacade', 0, 0, 0);
        g.flatPolygon(poly.slice(), wallTop);
      }
    }
    const mat = buildingMaterial(this.windowLight);
    for (const g of builders.values()) {
      const mesh = new THREE.Mesh(g.build(), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    const dm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    dm.polygonOffset = true;
    dm.polygonOffsetFactor = -1;
    this.group.add(new THREE.Mesh(drives.build(), dm));
  }

  /** Flat ribbon draped on the terrain. */
  private ribbon(g: GeoBuilder, pts: number[], width: number, lift: number) {
    const a = offsetPolyline(pts, -width / 2), b = offsetPolyline(pts, width / 2);
    const T = this.d.terrain;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const segL = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
      const n = Math.max(1, Math.ceil(segL / 5));
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const P = (arr: number[], tt: number): [number, number, number] => {
          const x = arr[i] + (arr[i + 2] - arr[i]) * tt, z = arr[i + 1] + (arr[i + 3] - arr[i + 1]) * tt;
          return [x, T.height(x, z) + lift, z];
        };
        g.quad(P(a, t0), P(b, t0), P(b, t1), P(a, t1), 0, 1, 0);
      }
    }
  }

  // ------------------------------------------------------------------ docks and rail
  private buildDocks() {
    const docks = this.d.data.docks ?? [];
    if (!docks.length) return;
    const wood = new GeoBuilder();
    const boats = new GeoBuilder();
    const rng = new Rng(7);
    const T = this.d.terrain;
    for (const k of docks) {
      const y = Math.max(k.y + 0.55, T.height(k.x, k.z) + 0.2);
      const bx = -k.dz, bz = k.dx;
      const w = 1.3;
      const P = (l: number, s: number, yy: number): [number, number, number] => [k.x + k.dx * l + bx * s, yy, k.z + k.dz * l + bz * s];
      wood.color = hexColor(rng.pick(['#7a6248', '#8a7457', '#6b5640']));
      wood.quad(P(-2, -w, y), P(-2, w, y), P(k.len, w, y), P(k.len, -w, y), 0, 1, 0);
      wood.quad(P(-2, -w, y - 0.25), P(k.len, -w, y - 0.25), P(k.len, -w, y), P(-2, -w, y), -bx, 0, -bz);
      wood.quad(P(-2, w, y - 0.25), P(k.len, w, y - 0.25), P(k.len, w, y), P(-2, w, y), bx, 0, bz);
      if (rng.chance(0.4)) {
        // A moored runabout beside the end of the dock.
        const l0 = k.len - 6.5, side = w + 1.4;
        boats.color = hexColor(rng.pick(['#f2f0ea', '#d8dde2', '#2b4a6b', '#7a1f2b']));
        const yb = k.y + 0.05;
        const Q = (l: number, s: number, yy: number): [number, number, number] => P(l0 + l, side + s, yy);
        boats.quad(Q(0, -0.9, yb + 0.6), Q(5.5, -0.9, yb + 0.6), Q(5.5, 0.9, yb + 0.6), Q(0, 0.9, yb + 0.6), 0, 1, 0);
        boats.tri(Q(5.5, -0.9, yb + 0.6), Q(6.5, 0, yb + 0.6), Q(5.5, 0.9, yb + 0.6), 0, 1, 0);
        for (const s of [-0.9, 0.9]) boats.quad(Q(0, s, yb - 0.1), Q(5.5, s, yb - 0.1), Q(5.5, s, yb + 0.6), Q(0, s, yb + 0.6), bx * Math.sign(s), 0, bz * Math.sign(s));
      }
    }
    this.group.add(
      new THREE.Mesh(wood.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })),
      new THREE.Mesh(boats.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.1 })),
    );
  }

  private buildRail() {
    const rails = this.d.data.rail ?? [];
    if (!rails.length) return;
    const ballast = new GeoBuilder();
    ballast.color = hexColor('#5e5850');
    const steel = new GeoBuilder();
    steel.color = hexColor('#3b3530');
    for (const r of rails) {
      this.ribbon(ballast, r.pts, 3.4, 0.05);
      for (const off of [-0.72, 0.72]) {
        const line = offsetPolyline(r.pts, off);
        this.ribbon(steel, line, 0.12, 0.25);
      }
    }
    this.group.add(new THREE.Mesh(ballast.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));
    this.group.add(new THREE.Mesh(steel.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.7 })));
  }

  private buildBoundary() {
    const b = this.d.bounds;
    const m = 8;
    this.statics.addPolyline([b.minX - m, b.minZ - m, b.maxX + m, b.minZ - m, b.maxX + m, b.maxZ + m, b.minX - m, b.maxZ + m], 'boundary', true);
  }

  /** Swap terrain chunks between detail levels and drop ones far beyond the fog. */
  updateLod(camera: THREE.Camera, far: number) {
    const p = camera.position;
    for (const c of this.terrainChunks) {
      const d = Math.hypot(c.center.x - p.x, c.center.z - p.z);
      c.hi.visible = d < 700;
      c.lo.visible = d >= 700 && d < far + 400;
    }
  }

  update(dt: number) {
    this.time.value += dt;
  }
}

/** Minimum-area oriented rectangle using footprint edge directions. */
export function orientedRect(poly: number[]) {
  const n = poly.length / 2;
  let best = { area: Infinity, ax: 1, az: 0, cx: 0, cz: 0, halfL: 1, halfW: 1 };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let ax = poly[j * 2] - poly[i * 2], az = poly[j * 2 + 1] - poly[i * 2 + 1];
    const l = Math.hypot(ax, az);
    if (l < 0.5) continue;
    ax /= l; az /= l;
    const bx = -az, bz = ax;
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (let k = 0; k < n; k++) {
      const pa = poly[k * 2] * ax + poly[k * 2 + 1] * az;
      const pb = poly[k * 2] * bx + poly[k * 2 + 1] * bz;
      minA = Math.min(minA, pa); maxA = Math.max(maxA, pa);
      minB = Math.min(minB, pb); maxB = Math.max(maxB, pb);
    }
    const area = (maxA - minA) * (maxB - minB);
    if (area < best.area) {
      const ca = (minA + maxA) / 2, cb = (minB + maxB) / 2;
      let hl = (maxA - minA) / 2, hw = (maxB - minB) / 2;
      let fax = ax, faz = az;
      if (hw > hl) { [hl, hw] = [hw, hl]; fax = bx; faz = bz; }
      best = { area, ax: fax, az: faz, cx: ax * ca + bx * cb, cz: az * ca + bz * cb, halfL: hl, halfW: hw };
    }
  }
  return best;
}
