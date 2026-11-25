// Procedural low-poly cars. Each model is an extruded side silhouette with its
// own greenhouse, stance, and rear-light signature so it reads from behind at night.
import * as THREE from 'three';
import type { CarId } from '../sim/cars';

export type TrafficType = 'compact' | 'sedan' | 'suv' | 'van' | 'pickup';
export type ModelId = CarId | TrafficType;

type P = [number, number];
interface Silhouette {
  L: number;
  W: number;
  wheelR: number;
  wheelbase: number;
  axleOffset: number; // z of the wheelbase centre
  track: number;
  body: P[];
  cabin: P[];
  cabinW: number;
  roof?: P[];
  tail: (add: LightAdder) => void;
  head: (add: LightAdder) => void;
  extras?: (g: THREE.Group, paint: THREE.Material, trim: THREE.Material) => void;
  /** Tire width (m); default 0.24. */
  tireW?: number;
}

/** Small helper for the extras: a box of a material at a position. */
function box(g: THREE.Group, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  g.add(m);
  return m;
}
const wood = new THREE.MeshStandardMaterial({ color: 0x7a4a26, roughness: 0.7 });
const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.15, metalness: 1 });
const cream = new THREE.MeshStandardMaterial({ color: 0xf1ece0, roughness: 0.4, metalness: 0.2 });
const darkGlass = new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 0.06, metalness: 0.9 });
const amber = new THREE.MeshStandardMaterial({ color: 0x332200, emissive: 0xffb020, emissiveIntensity: 1.2 });
type LightAdder = (x: number, y: number, z: number, w: number, h: number, d?: number, round?: boolean) => void;

const S: Record<ModelId, Silhouette> = {
  finch: {
    L: 4.05, W: 1.78, wheelR: 0.31, wheelbase: 2.5, axleOffset: 0.05, track: 1.52, cabinW: 0.86,
    body: [[-2.0, 0.32], [-2.03, 0.96], [-1.92, 1.0], [0.78, 0.99], [1.9, 0.82], [2.02, 0.62], [1.98, 0.32]],
    cabin: [[-1.92, 0.99], [-1.79, 1.41], [-1.55, 1.45], [0.2, 1.46], [0.8, 0.99]],
    roof: [[-1.66, 1.42], [-1.55, 1.47], [0.2, 1.48], [0.32, 1.42]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.72, 0.86, -2.03, 0.24, 0.26); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.62, 0.76, 2.0, 0.42, 0.13); },
    extras: (g, paint) => {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 0.32), paint);
      sp.position.set(0, 1.47, -1.72);
      sp.rotation.x = -0.18;
      g.add(sp);
    },
  },
  vesper: {
    L: 4.45, W: 1.86, wheelR: 0.33, wheelbase: 2.68, axleOffset: 0.08, track: 1.56, cabinW: 0.82,
    body: [[-2.2, 0.3], [-2.23, 0.82], [-2.15, 0.92], [-1.6, 0.93], [0.4, 0.9], [2.0, 0.72], [2.23, 0.56], [2.18, 0.3]],
    cabin: [[-1.72, 0.93], [-0.95, 1.27], [-0.55, 1.3], [0.02, 1.3], [0.48, 0.91]],
    roof: [[-1.0, 1.24], [-0.6, 1.31], [0.02, 1.31], [0.12, 1.25]],
    tail: (add) => add(0, 0.84, -2.22, 1.62, 0.07),
    head: (add) => { for (const s of [-1, 1]) add(s * 0.66, 0.68, 2.14, 0.46, 0.08); },
  },
  foundry: {
    L: 4.85, W: 1.94, wheelR: 0.34, wheelbase: 2.86, axleOffset: 0.0, track: 1.6, cabinW: 0.84,
    body: [[-2.4, 0.33], [-2.43, 0.96], [-2.35, 1.01], [-1.35, 1.01], [0.58, 1.0], [2.35, 0.96], [2.43, 0.86], [2.4, 0.33]],
    cabin: [[-1.38, 1.0], [-0.98, 1.34], [0.12, 1.36], [0.62, 1.0]],
    roof: [[-1.0, 1.32], [-0.95, 1.37], [0.12, 1.38], [0.2, 1.33]],
    tail: (add) => { for (const s of [-1, 1]) for (let k = 0; k < 3; k++) add(s * (0.32 + k * 0.22), 0.86, -2.43, 0.18, 0.16); },
    head: (add) => { for (const s of [-1, 1]) for (let k = 0; k < 2; k++) add(s * (0.55 + k * 0.26), 0.8, 2.42, 0.17, 0.17, 0.05, true); },
    extras: (g, paint) => {
      const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.12, 0.85), paint);
      scoop.position.set(0, 1.03, 1.35);
      g.add(scoop);
    },
  },
  kestrel: {
    L: 4.9, W: 1.92, wheelR: 0.34, wheelbase: 2.92, axleOffset: 0.0, track: 1.62, cabinW: 0.85,
    body: [[-2.42, 0.35], [-2.45, 0.9], [-2.3, 1.0], [-1.6, 1.02], [0.7, 1.0], [2.2, 0.86], [2.45, 0.7], [2.43, 0.35]],
    cabin: [[-1.95, 1.01], [-1.0, 1.4], [0.0, 1.42], [0.8, 1.0]],
    roof: [[-1.2, 1.36], [-1.0, 1.43], [0.0, 1.44], [0.15, 1.39]],
    tail: (add) => { add(0, 0.95, -2.44, 1.72, 0.05); add(0, 0.62, -2.45, 1.2, 0.03); },
    head: (add) => add(0, 0.82, 2.38, 1.5, 0.04),
  },
  northline: {
    L: 4.6, W: 1.82, wheelR: 0.33, wheelbase: 2.66, axleOffset: 0.0, track: 1.56, cabinW: 0.86,
    body: [[-2.28, 0.42], [-2.3, 1.0], [-2.2, 1.05], [0.65, 1.04], [2.15, 0.92], [2.3, 0.72], [2.28, 0.42]],
    cabin: [[-2.2, 1.05], [-2.12, 1.47], [0.15, 1.5], [0.72, 1.04]],
    roof: [[-2.16, 1.45], [-2.12, 1.51], [0.15, 1.53], [0.25, 1.48]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.8, 1.22, -2.21, 0.1, 0.42); },
    head: (add) => {
      for (const s of [-1, 1]) add(s * 0.62, 0.84, 2.24, 0.36, 0.12);
      for (let k = 0; k < 4; k++) add(-0.54 + k * 0.36, 0.6, 2.36, 0.15, 0.15, 0.06, true);
    },
    extras: (g, _paint, trim) => {
      for (const s of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 2.0), trim);
        rail.position.set(s * 0.62, 1.58, -0.95);
        g.add(rail);
      }
      for (const z of [-1.7, -0.3]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.04, 0.05), trim);
        bar.position.set(0, 1.62, z);
        g.add(bar);
      }
      const mud = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.18, 0.06), trim);
      mud.position.set(0, 0.45, -2.3);
      g.add(mud);
    },
  },
  meridian: {
    L: 4.5, W: 1.98, wheelR: 0.34, wheelbase: 2.6, axleOffset: -0.05, track: 1.64, cabinW: 0.78,
    body: [[-2.25, 0.28], [-2.27, 0.86], [-1.9, 0.94], [-0.75, 0.98], [0.65, 0.86], [2.0, 0.66], [2.25, 0.5], [2.22, 0.28]],
    cabin: [[-1.3, 0.97], [-0.55, 1.15], [0.1, 1.16], [0.95, 0.82]],
    roof: [[-0.6, 1.12], [-0.5, 1.17], [0.1, 1.18], [0.22, 1.13]],
    tail: (add) => {
      for (const s of [-1, 1]) for (const k of [0, 1]) add(s * (0.55 + k * 0.3), 0.74, -2.27, 0.16, 0.16, 0.05, true);
      add(0, 1.0, -1.95, 0.4, 0.04);
    },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.7, 0.62, 2.12, 0.4, 0.07); },
    extras: (g, paint, trim) => {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.05, 0.42), paint);
      wing.position.set(0, 1.14, -2.02);
      g.add(wing);
      for (const s of [-1, 1]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.2), trim);
        strut.position.set(s * 0.6, 1.02, -2.0);
        g.add(strut);
      }
    },
  },
  comet: {
    L: 4.6, W: 2.0, wheelR: 0.35, wheelbase: 2.75, axleOffset: -0.05, track: 1.7, cabinW: 0.74,
    body: [[-2.3, 0.26], [-2.32, 0.8], [-2.2, 0.88], [-1.2, 0.92], [0.2, 0.86], [1.6, 0.62], [2.3, 0.42], [2.28, 0.26]],
    cabin: [[-1.25, 0.9], [-0.45, 1.16], [0.15, 1.17], [0.95, 0.74]],
    roof: [[-0.5, 1.13], [-0.42, 1.18], [0.15, 1.19], [0.25, 1.14]],
    tail: (add) => add(0, 0.78, -2.32, 1.8, 0.05),
    head: (add) => { for (const s of [-1, 1]) add(s * 0.72, 0.5, 2.26, 0.5, 0.04); },
    extras: (g, paint, trim) => {
      box(g, trim, 1.7, 0.18, 0.3, 0, 0.32, -2.2);
      for (const s of [-1, 1]) box(g, paint, 0.06, 0.22, 1.1, s * 0.55, 0.98, -1.55);
    },
  },
  bandit: {
    L: 5.0, W: 1.95, wheelR: 0.36, wheelbase: 2.95, axleOffset: 0, track: 1.62, cabinW: 0.84, tireW: 0.3,
    body: [[-2.5, 0.36], [-2.52, 0.95], [-2.42, 1.0], [-1.0, 1.0], [0.6, 0.98], [2.45, 0.94], [2.52, 0.84], [2.5, 0.36]],
    cabin: [[-1.9, 0.99], [-0.85, 1.36], [0.05, 1.38], [0.6, 0.98]],
    roof: [[-0.9, 1.33], [-0.85, 1.39], [0.05, 1.41], [0.15, 1.35]],
    tail: (add) => add(0, 0.84, -2.52, 1.6, 0.12),
    head: (add) => { for (const s of [-1, 1]) for (let k = 0; k < 2; k++) add(s * (0.5 + k * 0.28), 0.78, 2.5, 0.2, 0.2, 0.05, true); },
    extras: (g, _paint, trim) => {
      box(g, trim, 0.7, 0.16, 0.9, 0, 1.05, 1.3);
      box(g, trim, 1.7, 0.05, 0.3, 0, 1.1, -2.35);
      for (const x of [-0.18, 0.18]) box(g, cream, 0.16, 0.012, 4.6, x, 1.405, 0);
    },
  },
  hauler: {
    L: 5.6, W: 2.05, wheelR: 0.42, wheelbase: 3.5, axleOffset: 0, track: 1.75, cabinW: 0.9, tireW: 0.3,
    body: [[-2.78, 0.55], [-2.8, 1.2], [-0.55, 1.2], [-0.5, 1.24], [0.95, 1.25], [2.55, 1.18], [2.8, 0.98], [2.78, 0.55]],
    cabin: [[-0.5, 1.24], [-0.4, 1.9], [0.45, 1.92], [1.05, 1.25]],
    roof: [[-0.45, 1.87], [-0.4, 1.94], [0.45, 1.96], [0.52, 1.9]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.92, 1.0, -2.8, 0.12, 0.36); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.72, 1.05, 2.78, 0.44, 0.18); },
    extras: (g, _paint, trim) => {
      box(g, trim, 1.8, 0.04, 2.05, 0, 1.215, -1.65);
      box(g, trim, 1.9, 0.08, 0.08, 0, 1.75, -0.65);
      for (const s of [-1, 1]) box(g, trim, 0.08, 0.5, 0.08, s * 0.9, 1.48, -0.65);
      box(g, amber, 0.9, 0.08, 0.16, 0, 2.0, 0.0);
      box(g, chrome, 1.6, 0.3, 0.1, 0, 0.75, 2.84);
    },
  },
  sprite: {
    L: 3.4, W: 1.48, wheelR: 0.27, wheelbase: 2.3, axleOffset: 0, track: 1.3, cabinW: 0.9,
    body: [[-1.7, 0.3], [-1.72, 1.0], [-1.65, 1.05], [1.2, 1.05], [1.62, 0.88], [1.72, 0.6], [1.7, 0.3]],
    cabin: [[-1.65, 1.05], [-1.6, 1.62], [0.7, 1.64], [1.28, 1.05]],
    roof: [[-1.62, 1.58], [-1.6, 1.65], [0.7, 1.67], [0.78, 1.6]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.6, 0.85, -1.72, 0.18, 0.3); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.5, 0.78, 1.7, 0.26, 0.26, 0.05, true); },
    extras: (g) => { box(g, cream, 1.3, 0.04, 2.2, 0, 1.685, -0.45); },
  },
  dune: {
    L: 3.9, W: 1.9, wheelR: 0.45, wheelbase: 2.5, axleOffset: 0, track: 1.75, cabinW: 0.7, tireW: 0.34,
    body: [[-1.9, 0.5], [-1.95, 0.95], [-1.2, 1.0], [0.6, 0.95], [1.7, 0.8], [1.95, 0.6], [1.9, 0.5]],
    cabin: [[0.42, 0.95], [0.52, 1.28], [0.6, 1.28], [0.7, 0.95]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.55, 0.85, -1.95, 0.14, 0.14); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.45, 0.85, 1.93, 0.18, 0.18, 0.05, true); },
    extras: (g, _paint, trim) => {
      for (const s of [-1, 1]) for (const z of [-0.95, 0.55]) box(g, trim, 0.07, 0.82, 0.07, s * 0.68, 1.36, z);
      for (const s of [-1, 1]) box(g, trim, 0.07, 0.07, 1.57, s * 0.68, 1.77, -0.2);
      for (const z of [-0.95, 0.55]) box(g, trim, 1.43, 0.07, 0.07, 0, 1.77, z);
      box(g, amber, 1.0, 0.1, 0.14, 0, 1.86, 0.55);
      box(g, trim, 0.9, 0.5, 0.4, 0, 1.15, -1.45);
    },
  },
  monarch: {
    L: 4.9, W: 1.96, wheelR: 0.36, wheelbase: 2.9, axleOffset: 0.05, track: 1.66, cabinW: 0.8,
    body: [[-2.45, 0.32], [-2.47, 0.88], [-2.35, 0.96], [-1.5, 0.97], [0.6, 0.94], [2.2, 0.78], [2.47, 0.58], [2.43, 0.32]],
    cabin: [[-1.6, 0.96], [-0.95, 1.3], [-0.3, 1.33], [0.25, 1.32], [0.72, 0.93]],
    roof: [[-1.0, 1.27], [-0.9, 1.34], [0.25, 1.35], [0.35, 1.29]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.75, 0.82, -2.46, 0.5, 0.06); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.72, 0.66, 2.38, 0.42, 0.07); },
    extras: (g) => { box(g, chrome, 0.7, 0.2, 0.06, 0, 0.55, 2.47); },
  },
  lancer: {
    L: 4.9, W: 2.0, wheelR: 0.36, wheelbase: 3.0, axleOffset: -0.1, track: 1.72, cabinW: 0.62, tireW: 0.32,
    body: [[-2.45, 0.22], [-2.47, 0.78], [-2.0, 0.85], [-0.9, 0.92], [0.3, 0.82], [1.6, 0.55], [2.45, 0.36], [2.43, 0.22]],
    cabin: [[-0.9, 0.9], [-0.35, 1.15], [0.2, 1.15], [0.7, 0.72]],
    roof: [[-0.4, 1.12], [-0.32, 1.17], [0.2, 1.17], [0.28, 1.12]],
    tail: (add) => add(0, 0.7, -2.47, 1.8, 0.05),
    head: (add) => { for (const s of [-1, 1]) add(s * 0.75, 0.48, 2.38, 0.3, 0.06); },
    extras: (g, paint, trim) => {
      box(g, paint, 1.95, 0.05, 0.5, 0, 1.18, -2.2);
      for (const s of [-1, 1]) box(g, trim, 0.05, 0.42, 0.55, s * 0.98, 0.97, -2.2);
      box(g, paint, 0.04, 0.32, 1.5, 0, 1.02, -1.45);
      box(g, trim, 1.9, 0.08, 0.5, 0, 0.27, 2.2);
    },
  },
  zenith: {
    // Land-speed hypercar: long nose, bubble canopy far back, a tail fin and a split wing.
    L: 5.2, W: 2.06, wheelR: 0.36, wheelbase: 3.15, axleOffset: -0.12, track: 1.76, cabinW: 0.58, tireW: 0.34,
    body: [[-2.6, 0.2], [-2.62, 0.74], [-2.2, 0.82], [-1.0, 0.9], [0.1, 0.84], [1.4, 0.56], [2.6, 0.3], [2.6, 0.2]],
    cabin: [[-1.25, 0.88], [-0.75, 1.08], [-0.15, 1.1], [0.45, 0.78]],
    roof: [[-0.8, 1.05], [-0.7, 1.11], [-0.15, 1.12], [-0.05, 1.07]],
    tail: (add) => { add(0, 0.66, -2.62, 1.9, 0.04); for (const s of [-1, 1]) add(s * 0.82, 0.52, -2.6, 0.24, 0.12); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.8, 0.38, 2.5, 0.36, 0.04); add(0, 0.3, 2.6, 1.2, 0.02); },
    extras: (g, paint, trim) => {
      box(g, paint, 0.05, 0.5, 1.9, 0, 1.08, -1.6); // dorsal fin
      for (const s of [-1, 1]) {
        box(g, paint, 0.92, 0.05, 0.48, s * 0.55, 1.1, -2.35); // split wing
        box(g, trim, 0.05, 0.3, 0.4, s * 1.0, 0.95, -2.35);
        box(g, trim, 0.18, 0.06, 1.4, s * 0.95, 0.3, 0.6); // side strakes
      }
      box(g, trim, 2.0, 0.06, 0.55, 0, 0.22, 2.35); // splitter
      box(g, trim, 1.7, 0.18, 0.3, 0, 0.32, -2.5); // diffuser
    },
  },
  mammoth: {
    L: 4.8, W: 2.6, wheelR: 0.85, wheelbase: 2.9, axleOffset: 0, track: 2.3, cabinW: 0.82, tireW: 0.62,
    body: [[-2.4, 1.15], [-2.42, 1.75], [-0.3, 1.78], [1.0, 1.78], [2.2, 1.65], [2.42, 1.45], [2.4, 1.15]],
    cabin: [[-0.3, 1.78], [-0.2, 2.4], [0.6, 2.42], [1.1, 1.78]],
    roof: [[-0.25, 2.36], [-0.2, 2.44], [0.6, 2.46], [0.68, 2.4]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.95, 1.6, -2.42, 0.16, 0.3); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.78, 1.55, 2.4, 0.4, 0.18); },
    extras: (g, _paint, trim) => {
      for (const z of [-1.45, 1.45]) box(g, trim, 2.1, 0.18, 0.18, 0, 0.85, z);
      for (const s of [-1, 1]) for (const z of [-1.45, 1.45]) box(g, chrome, 0.12, 0.5, 0.12, s * 0.7, 1.05, z);
      box(g, amber, 1.3, 0.1, 0.16, 0, 2.52, 0.4);
      box(g, trim, 2.3, 0.05, 1.9, 0, 1.79, -1.3);
    },
  },
  wraith: {
    L: 4.6, W: 1.95, wheelR: 0.34, wheelbase: 2.75, axleOffset: 0, track: 1.65, cabinW: 0.8,
    body: [[-2.3, 0.3], [-2.32, 0.86], [-2.1, 0.94], [-1.3, 0.96], [0.5, 0.9], [2.05, 0.66], [2.32, 0.46], [2.28, 0.3]],
    cabin: [[-1.5, 0.95], [-0.8, 1.24], [0.0, 1.26], [0.6, 0.9]],
    roof: [[-0.85, 1.21], [-0.78, 1.27], [0.0, 1.28], [0.1, 1.22]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.65, 0.8, -2.32, 0.6, 0.03); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.7, 0.55, 2.28, 0.36, 0.03); },
    extras: (g, paint) => { box(g, paint, 1.5, 0.04, 0.3, 0, 1.0, -2.15, -0.15); },
  },
  swallow: {
    L: 4.0, W: 1.78, wheelR: 0.32, wheelbase: 2.35, axleOffset: -0.05, track: 1.52, cabinW: 0.84,
    body: [[-2.0, 0.3], [-2.02, 0.86], [-1.9, 0.9], [-0.6, 0.9], [0.3, 0.88], [1.7, 0.7], [2.02, 0.52], [1.98, 0.3]],
    cabin: [[0.25, 0.88], [-0.05, 1.22], [0.05, 1.23], [0.4, 0.88]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.6, 0.75, -2.02, 0.2, 0.2, 0.05, true); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.6, 0.66, 1.95, 0.36, 0.1); },
    extras: (g, _paint, trim) => {
      for (const s of [-1, 1]) {
        box(g, trim, 0.48, 0.45, 0.12, s * 0.38, 1.12, -0.62);
        box(g, chrome, 0.05, 0.35, 0.05, s * 0.38, 1.2, -0.8);
      }
      box(g, trim, 1.3, 0.04, 0.9, 0, 0.905, -0.25);
    },
  },
  harbor: {
    L: 5.0, W: 2.0, wheelR: 0.36, wheelbase: 3.0, axleOffset: 0.1, track: 1.7, cabinW: 0.9,
    body: [[-2.5, 0.42], [-2.52, 2.05], [-2.42, 2.12], [1.9, 2.12], [2.35, 1.6], [2.5, 1.0], [2.52, 0.42]],
    cabin: [[1.8, 2.0], [2.3, 1.55], [2.4, 1.42], [1.85, 1.42]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.85, 1.0, -2.52, 0.16, 0.3); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.62, 1.05, 2.5, 0.3, 0.3, 0.05, true); },
    extras: (g) => {
      box(g, cream, 2.0, 0.62, 4.4, 0, 1.82, -0.25);
      for (const s of [-1, 1]) box(g, darkGlass, 0.02, 0.42, 3.4, s * 1.005, 1.72, -0.45);
      box(g, cream, 1.7, 0.3, 3.0, 0, 2.3, -0.6);
      box(g, cream, 0.9, 0.05, 0.05, 0, 1.2, 2.53);
    },
  },
  vandal: {
    L: 4.2, W: 1.85, wheelR: 0.33, wheelbase: 2.55, axleOffset: 0.03, track: 1.6, cabinW: 0.86,
    body: [[-2.08, 0.36], [-2.1, 0.98], [-2.0, 1.02], [0.75, 1.0], [1.9, 0.84], [2.1, 0.64], [2.06, 0.36]],
    cabin: [[-1.98, 1.01], [-1.82, 1.44], [-1.55, 1.48], [0.2, 1.49], [0.82, 1.0]],
    roof: [[-1.66, 1.45], [-1.55, 1.5], [0.2, 1.51], [0.32, 1.45]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.74, 0.88, -2.1, 0.24, 0.28); },
    head: (add) => {
      for (const s of [-1, 1]) add(s * 0.62, 0.78, 2.08, 0.42, 0.13);
      for (let k = 0; k < 4; k++) add(-0.54 + k * 0.36, 0.58, 2.12, 0.15, 0.15, 0.06, true);
    },
    extras: (g, paint, trim) => {
      box(g, paint, 1.6, 0.05, 0.4, 0, 1.62, -1.85);
      for (const s of [-1, 1]) box(g, trim, 0.05, 0.16, 0.2, s * 0.6, 1.53, -1.85);
      box(g, trim, 0.4, 0.1, 0.5, 0, 1.55, -0.2);
      box(g, trim, 1.8, 0.2, 0.05, 0, 0.45, -2.1);
    },
  },
  volt: {
    L: 3.6, W: 1.7, wheelR: 0.3, wheelbase: 2.4, axleOffset: 0, track: 1.48, cabinW: 0.88,
    body: [[-1.8, 0.32], [-1.82, 0.95], [-1.7, 1.05], [0.9, 1.05], [1.65, 0.85], [1.82, 0.6], [1.8, 0.32]],
    cabin: [[-1.72, 1.04], [-1.5, 1.5], [-1.0, 1.6], [0.3, 1.6], [1.0, 1.04]],
    roof: [[-1.1, 1.56], [-1.0, 1.62], [0.3, 1.62], [0.42, 1.56]],
    tail: (add) => add(0, 0.9, -1.82, 1.3, 0.06),
    head: (add) => add(0, 0.75, 1.81, 1.2, 0.05),
  },
  havoc: {
    L: 5.1, W: 2.1, wheelR: 0.42, wheelbase: 3.05, axleOffset: 0, track: 1.8, cabinW: 0.86, tireW: 0.32,
    body: [[-2.55, 0.5], [-2.57, 1.25], [-2.45, 1.32], [0.75, 1.32], [2.3, 1.2], [2.57, 0.98], [2.55, 0.5]],
    cabin: [[-2.4, 1.32], [-2.3, 1.85], [0.2, 1.9], [0.85, 1.32]],
    roof: [[-2.35, 1.8], [-2.3, 1.92], [0.2, 1.95], [0.3, 1.86]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.9, 1.35, -2.5, 0.14, 0.36); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.72, 1.08, 2.55, 0.42, 0.14); },
    extras: (g, _paint, trim) => {
      box(g, trim, 1.7, 0.6, 0.12, 0, 0.95, 2.66);
      box(g, trim, 1.6, 0.06, 1.8, 0, 2.0, -1.0);
      box(g, trim, 0.5, 0.3, 1.0, 0.45, 2.18, -1.0);
      for (const s of [-1, 1]) box(g, trim, 0.06, 0.5, 4.2, s * 1.06, 0.95, 0);
    },
  },
  ambler: {
    L: 5.0, W: 1.9, wheelR: 0.34, wheelbase: 2.95, axleOffset: 0, track: 1.6, cabinW: 0.86,
    body: [[-2.5, 0.36], [-2.52, 1.0], [-2.42, 1.04], [0.8, 1.04], [2.3, 0.94], [2.52, 0.76], [2.5, 0.36]],
    cabin: [[-2.42, 1.04], [-2.35, 1.5], [0.2, 1.52], [0.9, 1.04]],
    roof: [[-2.4, 1.46], [-2.35, 1.53], [0.2, 1.55], [0.3, 1.48]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.82, 0.95, -2.52, 0.12, 0.3); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.66, 0.82, 2.5, 0.24, 0.24, 0.05, true); },
    extras: (g, _paint, trim) => {
      for (const s of [-1, 1]) box(g, wood, 0.02, 0.36, 3.7, s * 0.95, 0.74, -0.5);
      for (const s of [-1, 1]) box(g, trim, 0.05, 0.06, 2.4, s * 0.62, 1.6, -1.0);
      box(g, chrome, 1.8, 0.12, 0.08, 0, 0.45, 2.53);
    },
  },
  rattler: {
    L: 4.2, W: 1.8, wheelR: 0.36, wheelbase: 2.7, axleOffset: -0.1, track: 1.58, cabinW: 0.82, tireW: 0.34,
    body: [[-2.1, 0.4], [-2.12, 1.0], [-1.95, 1.06], [-0.3, 1.06], [0.4, 0.9], [2.0, 0.86], [2.12, 0.7], [2.1, 0.4]],
    cabin: [[-1.6, 1.05], [-1.45, 1.4], [-0.4, 1.42], [-0.25, 1.05]],
    roof: [[-1.5, 1.38], [-1.45, 1.43], [-0.4, 1.45], [-0.32, 1.39]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.62, 0.86, -2.12, 0.16, 0.16, 0.05, true); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.62, 1.0, 2.12, 0.3, 0.3, 0.05, true); },
    extras: (g, _paint, trim) => {
      box(g, chrome, 0.7, 0.38, 1.0, 0, 1.08, 1.1);
      box(g, chrome, 0.5, 0.3, 0.4, 0, 1.4, 1.0);
      box(g, trim, 0.4, 0.06, 0.3, 0, 1.6, 1.0);
      for (const s of [-1, 1]) box(g, chrome, 0.1, 0.1, 2.6, s * 0.95, 0.45, -0.4);
    },
  },
  cruiser: {
    L: 5.0, W: 1.92, wheelR: 0.34, wheelbase: 2.9, axleOffset: 0.0, track: 1.6, cabinW: 0.86,
    body: [[-2.48, 0.36], [-2.5, 0.98], [-2.4, 1.03], [-1.5, 1.04], [0.75, 1.02], [2.3, 0.92], [2.5, 0.78], [2.48, 0.36]],
    cabin: [[-1.6, 1.03], [-1.05, 1.47], [0.2, 1.49], [0.85, 1.02]],
    roof: [[-1.1, 1.44], [-1.05, 1.5], [0.2, 1.52], [0.3, 1.46]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.68, 0.9, -2.5, 0.44, 0.16); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.64, 0.84, 2.46, 0.42, 0.12); },
    extras: (g, _paint, trim) => {
      const push = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.08), trim);
      push.position.set(0, 0.62, 2.56);
      g.add(push);
    },
  },
  interceptor: {
    L: 4.8, W: 1.95, wheelR: 0.34, wheelbase: 2.8, axleOffset: 0.05, track: 1.62, cabinW: 0.82,
    body: [[-2.38, 0.32], [-2.4, 0.86], [-2.3, 0.95], [-1.7, 0.96], [0.45, 0.94], [2.15, 0.76], [2.4, 0.6], [2.36, 0.32]],
    cabin: [[-1.85, 0.95], [-1.0, 1.3], [-0.55, 1.32], [0.05, 1.32], [0.52, 0.94]],
    roof: [[-1.0, 1.27], [-0.55, 1.33], [0.05, 1.34], [0.15, 1.28]],
    tail: (add) => add(0, 0.86, -2.39, 1.5, 0.06),
    head: (add) => { for (const s of [-1, 1]) add(s * 0.66, 0.7, 2.3, 0.5, 0.07); },
  },
  warden: {
    // The Wardens' interceptor: low, wide, matte black, with a push bar and a red-white bar.
    L: 4.9, W: 2.02, wheelR: 0.35, wheelbase: 2.9, axleOffset: 0.0, track: 1.7, cabinW: 0.76, tireW: 0.3,
    body: [[-2.42, 0.3], [-2.45, 0.84], [-2.3, 0.93], [-1.6, 0.95], [0.4, 0.92], [2.1, 0.72], [2.45, 0.54], [2.42, 0.3]],
    cabin: [[-1.7, 0.93], [-0.9, 1.24], [-0.4, 1.26], [0.1, 1.26], [0.6, 0.9]],
    roof: [[-0.95, 1.21], [-0.45, 1.27], [0.1, 1.28], [0.2, 1.22]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.72, 0.82, -2.44, 0.42, 0.08); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.7, 0.62, 2.38, 0.42, 0.05); add(0, 0.42, 2.46, 1.0, 0.03); },
    extras: (g, _paint, trim) => {
      box(g, trim, 1.7, 0.42, 0.12, 0, 0.55, 2.55); // push bar
      for (const s of [-1, 1]) box(g, trim, 0.1, 0.5, 0.35, s * 0.6, 0.55, 2.42);
      box(g, trim, 1.8, 0.05, 0.36, 0, 1.0, -2.25); // spoiler
    },
  },
  tank: {
    L: 6.4, W: 2.55, wheelR: 0.58, wheelbase: 3.6, axleOffset: 0, track: 2.1, cabinW: 0.84,
    body: [[-3.15, 0.55], [-3.2, 2.05], [-3.0, 2.25], [1.2, 2.25], [2.2, 1.6], [3.15, 1.35], [3.2, 0.55]],
    cabin: [[1.1, 2.2], [2.05, 1.62], [2.25, 1.55], [1.3, 1.55]],
    roof: [[-2.9, 2.22], [-2.85, 2.32], [1.0, 2.32], [1.1, 2.22]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 1.0, 1.4, -3.2, 0.2, 0.3); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.95, 1.2, 3.18, 0.36, 0.16); },
    extras: (g, _paint, trim) => {
      // Ram plate and wheel-well armour.
      const ram = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.7, 0.18), trim);
      ram.position.set(0, 0.9, 3.28);
      g.add(ram);
      for (const s of [-1, 1]) {
        const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 5.6), trim);
        skirt.position.set(s * 1.3, 0.8, 0);
        g.add(skirt);
      }
    },
  },
  compact: {
    L: 4.0, W: 1.74, wheelR: 0.3, wheelbase: 2.5, axleOffset: 0, track: 1.48, cabinW: 0.88,
    body: [[-1.98, 0.34], [-2.0, 0.95], [-1.9, 1.0], [0.75, 0.98], [1.85, 0.84], [2.0, 0.64], [1.96, 0.34]],
    cabin: [[-1.9, 0.99], [-1.75, 1.42], [0.2, 1.45], [0.8, 0.98]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.7, 0.88, -2.0, 0.2, 0.22); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.6, 0.78, 1.98, 0.36, 0.12); },
  },
  sedan: {
    L: 4.7, W: 1.82, wheelR: 0.32, wheelbase: 2.75, axleOffset: 0, track: 1.55, cabinW: 0.86,
    body: [[-2.33, 0.34], [-2.35, 0.92], [-2.25, 0.98], [-1.4, 0.99], [0.7, 0.97], [2.15, 0.84], [2.35, 0.66], [2.32, 0.34]],
    cabin: [[-1.5, 0.98], [-0.95, 1.42], [0.2, 1.44], [0.8, 0.97]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.66, 0.86, -2.35, 0.42, 0.14); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.62, 0.78, 2.32, 0.4, 0.12); },
  },
  suv: {
    L: 4.75, W: 1.9, wheelR: 0.37, wheelbase: 2.8, axleOffset: 0, track: 1.62, cabinW: 0.88,
    body: [[-2.35, 0.45], [-2.37, 1.1], [-2.28, 1.16], [0.7, 1.15], [2.2, 1.04], [2.37, 0.84], [2.35, 0.45]],
    cabin: [[-2.28, 1.16], [-2.18, 1.72], [0.1, 1.76], [0.78, 1.15]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.82, 1.3, -2.3, 0.14, 0.36); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.66, 0.98, 2.34, 0.42, 0.14); },
  },
  van: {
    L: 5.1, W: 1.95, wheelR: 0.35, wheelbase: 3.1, axleOffset: 0.1, track: 1.66, cabinW: 0.9,
    body: [[-2.53, 0.42], [-2.55, 1.9], [-2.45, 2.0], [1.2, 2.0], [1.6, 1.3], [2.5, 1.0], [2.55, 0.42]],
    cabin: [[1.15, 1.95], [1.55, 1.35], [1.7, 1.3], [1.2, 1.3]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.88, 1.1, -2.55, 0.14, 0.4); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.7, 0.95, 2.53, 0.4, 0.14); },
  },
  pickup: {
    L: 5.3, W: 1.98, wheelR: 0.38, wheelbase: 3.3, axleOffset: 0, track: 1.68, cabinW: 0.9,
    body: [[-2.63, 0.5], [-2.65, 1.12], [-0.6, 1.12], [-0.55, 1.15], [0.85, 1.16], [2.4, 1.08], [2.65, 0.9], [2.63, 0.5]],
    cabin: [[-0.55, 1.15], [-0.45, 1.8], [0.4, 1.82], [0.95, 1.16]],
    tail: (add) => { for (const s of [-1, 1]) add(s * 0.9, 1.0, -2.65, 0.12, 0.34); },
    head: (add) => { for (const s of [-1, 1]) add(s * 0.7, 1.0, 2.63, 0.42, 0.16); },
  },
};

export const MODEL_DIMS = (id: ModelId) => ({ length: S[id].L, width: S[id].W });

const geoCache = new Map<string, THREE.BufferGeometry>();
/** Extruded silhouettes are shared between every car of the same model. */
function cachedProfile(key: string, points: P[], width: number) {
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = extrudeProfile(points, width)));
  return g;
}

function extrudeProfile(points: P[], width: number) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.035, bevelSegments: 1, steps: 1,
  });
  geo.translate(0, 0, -width / 2);
  geo.rotateY(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

const shared = {
  glass: new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 0.06, metalness: 0.9, envMapIntensity: 1.4 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.5, metalness: 0.4 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.95 }),
  rim: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.25, metalness: 0.9 }),
  head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1d6, emissiveIntensity: 2.0 }),
};
const tireGeo = new THREE.CylinderGeometry(1, 1, 1, 16);
tireGeo.rotateZ(Math.PI / 2);
const rimGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.04, 8);
rimGeo.rotateZ(Math.PI / 2);

export class CarModel {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly paint: THREE.MeshStandardMaterial;
  readonly tail: THREE.MeshStandardMaterial;
  readonly reverse: THREE.MeshStandardMaterial;
  readonly wheels: { pivot: THREE.Group; spin: THREE.Group; front: boolean }[] = [];
  readonly sil: Silhouette;
  private lightbar: THREE.MeshStandardMaterial[] = [];
  private beam: THREE.Mesh | null = null;
  ghost = false;

  constructor(readonly id: ModelId, color: string, opts: { beamTex?: THREE.Texture; ghost?: boolean } = {}) {
    const sil = (this.sil = S[id]);
    this.paint = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.55, envMapIntensity: 1.2 });
    this.tail = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1a12, emissiveIntensity: 1.6 });
    this.reverse = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffffff, emissiveIntensity: 0 });
    const body = new THREE.Mesh(cachedProfile(`${id}:body`, sil.body, sil.W - 0.08), this.paint);
    const cabin = new THREE.Mesh(cachedProfile(`${id}:cabin`, sil.cabin, sil.W * sil.cabinW), shared.glass);
    body.castShadow = true;
    this.body.add(body, cabin);
    if (sil.roof) this.body.add(new THREE.Mesh(cachedProfile(`${id}:roof`, sil.roof, sil.W * sil.cabinW + 0.02), this.paint));
    // Lower trim / bumpers in black.
    const sill = new THREE.Mesh(new THREE.BoxGeometry(sil.W - 0.02, 0.14, sil.L * 0.96), shared.trim);
    sill.position.y = sil.body[0][1] + 0.05;
    this.body.add(sill);

    const addLight = (mat: THREE.Material) => (x: number, y: number, z: number, w: number, h: number, d = 0.05, round = false) => {
      const geo = round ? new THREE.CylinderGeometry(w / 2, w / 2, d, 12).rotateX(Math.PI / 2) : new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z + (z < 0 ? -0.02 : 0.02));
      this.body.add(m);
    };
    sil.tail(addLight(this.tail));
    sil.head(addLight(shared.head));
    // Small reverse lamps beside the plate.
    for (const s of [-1, 1]) addLight(this.reverse)(s * 0.3, sil.body[0][1] + 0.22, sil.body[0][0] - 0.02, 0.14, 0.06);
    sil.extras?.(this.body, this.paint, shared.trim);

    if (id === 'cruiser' || id === 'interceptor' || id === 'tank' || id === 'warden') this.addPoliceKit(id);
    if (id === 'tank') this.addTurret();

    // Wheels with steering pivots.
    const r = sil.wheelR;
    for (const [front, side] of [[true, -1], [true, 1], [false, -1], [false, 1]] as const) {
      const pivot = new THREE.Group();
      const spin = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, shared.tire);
      tire.scale.set(0.24, r, r);
      const rim = new THREE.Mesh(rimGeo, shared.rim);
      rim.scale.set(0.24, r, r);
      const tw = sil.tireW ?? 0.24;
      tire.scale.x = tw;
      rim.scale.x = tw;
      spin.add(tire, rim);
      pivot.add(spin);
      pivot.position.set((side * sil.track) / 2, r, sil.axleOffset + (front ? sil.wheelbase / 2 : -sil.wheelbase / 2));
      this.root.add(pivot);
      this.wheels.push({ pivot, spin, front });
    }
    this.root.add(this.body);
    if (opts.beamTex) {
      // Headlight spill on the road ahead (additive decal).
      const g = new THREE.PlaneGeometry(1, 1);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.MeshBasicMaterial({ map: opts.beamTex, color: 0xfff0d0, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
      m.polygonOffset = true;
      m.polygonOffsetFactor = -8;
      this.beam = new THREE.Mesh(g, m);
      this.beam.scale.set(7, 1, 16);
      this.beam.position.set(0, 0.06, sil.L / 2 + 7);
      this.beam.renderOrder = 2;
      this.root.add(this.beam);
    }
    if (opts.ghost) this.makeGhost();
  }

  private addPoliceKit(id: CarId | TrafficType) {
    const sil = this.sil;
    const top = sil.roof ? Math.max(...sil.roof.map((p) => p[1])) : 1.45;
    const roofMid = sil.roof ? (sil.roof[1][0] + sil.roof[2][0]) / 2 : 0;
    const red = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2030, emissiveIntensity: 0 });
    // Wardens run red and white; everyone else red and blue.
    const blue = id === 'warden'
      ? new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffffff, emissiveIntensity: 0 })
      : new THREE.MeshStandardMaterial({ color: 0x000033, emissive: 0x2060ff, emissiveIntensity: 0 });
    this.lightbar = [red, blue];
    const barW = id === 'interceptor' || id === 'warden' ? 1.1 : 1.35;
    const h = id === 'interceptor' || id === 'warden' ? 0.07 : 0.12;
    for (const [mat, s] of [[red, -1], [blue, 1]] as const) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(barW / 2 - 0.04, h, 0.26), mat);
      seg.position.set((s * barW) / 4, top + h / 2 + 0.02, roofMid);
      this.body.add(seg);
    }
    // Two-tone livery panel and a fictional unit badge on the doors.
    const panelMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.4, metalness: 0.2 });
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = id === 'warden' ? '#141416' : '#e8e8e4';
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = id === 'warden' ? '#ff3b2f' : '#16243a';
    g.font = 'bold 34px sans-serif';
    g.textAlign = 'center';
    g.fillText(id === 'interceptor' ? 'PURSUIT' : id === 'tank' ? 'ARMOR' : id === 'warden' ? 'WARDEN' : 'PATROL', 128, 44);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const badge = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 });
    for (const s of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.42, 1.9), id === 'interceptor' || id === 'warden' ? shared.trim : panelMat);
      panel.position.set((s * (sil.W - 0.02)) / 2, 0.72, -0.1);
      this.body.add(panel);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.32), badge);
      label.position.set((s * sil.W) / 2 + s * 0.02, 0.72, -0.1);
      label.rotation.y = (s * Math.PI) / 2;
      this.body.add(label);
    }
  }

  /** Armored unit: a roof turret with a rocket tube. `turret.rotation.y` aims it (body-relative). */
  turret: THREE.Group | null = null;
  /** Muzzle position in turret space (rockets leave from here). */
  readonly muzzle = new THREE.Vector3(0, 0.25, 1.9);
  private addTurret() {
    const t = new THREE.Group();
    t.position.set(0, 2.32, -0.6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1d2530, roughness: 0.6, metalness: 0.4 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 0.45, 10), mat);
    base.position.y = 0.22;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 2.2, 10).rotateX(Math.PI / 2), shared.trim);
    tube.position.set(0, 0.62, 0.85);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.3), new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2020, emissiveIntensity: 2 }));
    sight.position.set(0.32, 0.62, 1.6);
    t.add(base, tube, sight);
    t.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
    this.body.add(t);
    this.turret = t;
    this.muzzle.set(0, 0.62, 1.95);
  }

  private makeGhost() {
    this.ghost = true;
    const mat = new THREE.MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.28, depthWrite: false });
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = mat;
    });
  }

  setPaint(color: string) {
    this.paint.color.set(color);
  }

  setLights(braking: boolean, reversing: boolean) {
    this.tail.emissiveIntensity = braking ? 6.5 : 1.6;
    this.reverse.emissiveIntensity = reversing ? 3 : 0;
  }

  /** Police light bar: alternating flash; reduced mode pulses slowly and dimmer. */
  setSiren(on: boolean, t: number, reduced: boolean) {
    if (!this.lightbar.length) return;
    const [red, blue] = this.lightbar;
    if (!on) {
      red.emissiveIntensity = blue.emissiveIntensity = 0;
      return;
    }
    if (reduced) {
      const p = 0.5 + 0.5 * Math.sin(t * 2.4);
      red.emissiveIntensity = 1.5 + 2 * p;
      blue.emissiveIntensity = 1.5 + 2 * (1 - p);
    } else {
      const phase = Math.floor(t * 7) % 4;
      red.emissiveIntensity = phase < 2 ? 9 : 0.4;
      blue.emissiveIntensity = phase >= 2 ? 9 : 0.4;
    }
  }

  /** Apply a pose; pitch/roll go to the body only so the wheels stay planted. */
  pose(x: number, y: number, z: number, h: number, pitch: number, roll: number, steer: number, wheelRot: number, bump = 0) {
    this.root.position.set(x, y, z);
    this.root.rotation.set(0, h, 0);
    this.body.rotation.set(pitch, 0, -roll);
    this.body.position.y = bump * 0.6;
    for (const w of this.wheels) {
      w.pivot.rotation.y = w.front ? -steer : 0;
      w.spin.rotation.x = wheelRot;
    }
  }

  /** Shared silhouettes and wheels stay cached; only per-car parts are released. */
  dispose() {
    const keep = new Set<THREE.BufferGeometry>([...geoCache.values(), tireGeo, rimGeo]);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !keep.has(m.geometry)) m.geometry.dispose();
    });
  }
}
