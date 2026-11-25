// Instanced roadside scenery: fall trees, street lamps with light pools and
// broken wet-road reflections, porches with lights, parked cars, boundary beacons.
import * as THREE from 'three';
import { MAP } from '../map/maps';
import { Rng } from '../core/rng';
import { ROAD_RANK } from '../map/District';
import { worldUniforms, type World } from './World';
import { glowTexture, streakTexture } from './materials';

export interface Lamp {
  x: number;
  z: number;
  y: number;
  hx: number; // head position (overhangs the road)
  hz: number;
  hy: number;
  /** Surface the light falls on (default: terrain under the head). */
  gy?: number;
  /** false: no post (lights hung on wires or set in a tunnel roof). */
  pole?: boolean;
}

const CAR_COLS = ['#3a3f45', '#6d7178', '#a7a9ab', '#1b1e23', '#5a1d20', '#203a5c', '#c9c6bd', '#2e4a35', '#7a6a55', '#8a8f94'];

export class Scenery {
  readonly group = new THREE.Group();
  readonly lamps: Lamp[] = [];
  private nightOnly: THREE.Object3D[] = [];
  private night = true;
  readonly porchLights: { x: number; y: number; z: number }[] = [];
  readonly parked: { x: number; z: number; h: number; y: number }[] = [];
  private streakMat!: THREE.ShaderMaterial;

  constructor(private world: World, lowEffects: boolean) {
    const d = world.d;
    const T = d.terrain;
    const rng = new Rng(1234);
    const glowTex = glowTexture();

    // ---------------------------------------------------------- placement
    if (MAP.city) this.cityLights();
    this.tubeLights();
    for (const strip of MAP.city ? [] : world.asphalt.strips) {
      const e = d.edges[strip.edge];
      if (e.bridge) continue;
      const len = strip.s1 - strip.s0;
      if (len < 12) continue;
      const mid = e.path.pointAt(e.length / 2);
      const downtown = world.isDowntown(mid.x, mid.z);
      const hw = e.width / 2;
      const rank = ROAD_RANK[e.cls] ?? 1;
      const pointAt = (s: number, off: number) => {
        const p = e.path.pointAt(s);
        const h = e.path.headingAt(s);
        return { x: p.x - Math.cos(h) * off, z: p.z + Math.sin(h) * off, h };
      };
      const clearSpot = (x: number, z: number, pad: number) =>
        !world.onRoad(x, z) && !world.insideBuilding(x, z) && world.waterIndex.query(x, z) < 0 && !world.isReserved(x, z, pad)
        && world.buildingIndex.query(x + pad, z) < 0 && world.buildingIndex.query(x - pad, z) < 0
        && world.buildingIndex.query(x, z + pad) < 0 && world.buildingIndex.query(x, z - pad) < 0;

      // Street lamps only along town streets (rural roads stay dark), plus freeway interchanges.
      const town = world.town.has(e.index);
      if (!town && !e.cls.endsWith('_link')) continue;
      const spacing = downtown ? 24 : rank >= 3 ? 36 : 46;
      let side = rng.chance(0.5) ? 1 : -1;
      for (let s = strip.s0 + 6; s < strip.s1 - 4; s += spacing) {
        const sides = downtown ? [-1, 1] : [side];
        for (const sd of sides) {
          const p = pointAt(s, sd * (hw + 0.7));
          if (!clearSpot(p.x, p.z, 0.4)) continue;
          const arm = downtown ? 0 : 1.6;
          const hp = pointAt(s, sd * (hw + 0.7 - arm));
          const gy = T.height(p.x, p.z);
          this.lamps.push({ x: p.x, z: p.z, y: gy, hx: hp.x, hz: hp.z, hy: gy + (downtown ? 4.6 : 7.6) });
          world.statics.addCircle(p.x, p.z, 0.16, 'post', gy - 1, gy + 8);
        }
        side = -side;
      }
      // Parked cars along residential curbs.
      if (e.cls === 'residential' && town && !downtown && len > 30) {
        for (const sd of [-1, 1]) {
          for (let s = strip.s0 + 9; s < strip.s1 - 9; s += 6.6) {
            if (!rng.chance(0.14)) continue;
            const p = pointAt(s, sd * (hw - 1.15));
            if (world.isReserved(p.x, p.z, 4)) continue;
            const h = p.h + (sd > 0 ? 0 : Math.PI) + rng.range(-0.03, 0.03);
            this.parked.push({ x: p.x, z: p.z, h, y: T.height(p.x, p.z) });
          }
        }
      }
    }
    void lowEffects;
    this.buildLamps(glowTex, lowEffects);
    this.buildPorches(glowTex);
    this.buildParked();
    this.buildBeacons(glowTex);
  }

  /**
   * Generated city: no lamp posts to hit. Street lights hang on span wires over the
   * middle of the road, tunnels have lights in the roof, and viaduct lights stand on
   * the parapet (which you would hit first anyway).
   */
  private cityLights() {
    const w = this.world, d = w.d, G = w.ground;
    const wires: { x: number; z: number; h: number; half: number; y: number }[] = [];
    for (const e of d.edges) {
      const at = (s: number) => ({ p: e.path.pointAt(s), h: e.path.headingAt(s), y: d.heightOnEdge(e.index, s) });
      if (e.level === 0) {
        for (let s = 22; s < e.length - 15; s += 45) {
          const { p, h, y } = at(s);
          if (G.ceiling(p.x, p.z, y) < y + 11) continue; // under a viaduct: its own lights do
          this.lamps.push({ x: p.x, z: p.z, y: y + 7.6, hx: p.x, hz: p.z, hy: y + 7.4, gy: y + 0.12, pole: false });
          wires.push({ x: p.x, z: p.z, h, half: e.width / 2 + 5, y: y + 7.75 });
        }
      } else if (e.level < 0) {
        for (let s = 8; s < e.length - 4; s += 14) {
          const { p, h, y } = at(s);
          const roof = G.ceiling(p.x, p.z, y);
          if (roof > y + 14) continue; // open to the sky
          for (const off of [-4.5, 4.5]) {
            const hx = p.x - Math.cos(h) * off, hz = p.z + Math.sin(h) * off;
            this.lamps.push({ x: hx, z: hz, y: roof - 0.05, hx, hz, hy: roof - 0.1, gy: y + 0.12, pole: false });
          }
        }
      } else if (e.bridge) {
        let side = 1;
        for (let s = 15; s < e.length - 10; s += 42) {
          const { p, h, y } = at(s);
          side = -side;
          if (y - d.terrain.height(p.x, p.z) < 4) continue;
          const rx = -Math.cos(h), rz = Math.sin(h);
          const off = side * (e.width / 2 + 1.05);
          const bx = p.x + rx * off, bz = p.z + rz * off;
          if (G.otherDeckAt(bx, bz, y, { self: e.index })) continue; // a merge: no parapet here
          const hOff = off - side * 2.6;
          this.lamps.push({ x: bx, z: bz, y: y + 1.0, hx: p.x + rx * hOff, hz: p.z + rz * hOff, hy: y + 9, gy: y + 0.12 });
        }
      }
    }
    if (!wires.length) return;
    const geo = new THREE.BoxGeometry(1, 0.035, 0.035);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.6 }), wires.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    wires.forEach((wi, i) => {
      // Across the road: perpendicular to travel.
      q.setFromAxisAngle(up, wi.h);
      m.compose(pos.set(wi.x, wi.y, wi.z), q, sc.set(wi.half * 2, 1, 1));
      mesh.setMatrixAt(i, m);
    });
    this.group.add(mesh);
  }

  /** Caves and speed tubes: two rows of lights in the roof. */
  private tubeLights() {
    const d = this.world.d;
    for (const t of d.data.tubes ?? []) {
      const e = d.edges[t.edge];
      for (let s = 7; s < e.length - 3; s += t.cave ? 16 : 12) {
        const p = e.path.pointAt(s), h = e.path.headingAt(s), y = d.heightOnEdge(t.edge, s);
        for (const f of [-0.45, 0.45]) {
          const hx = p.x - Math.cos(h) * t.hw * f, hz = p.z + Math.sin(h) * t.hw * f;
          this.lamps.push({ x: hx, z: hz, y: y + t.h - 0.05, hx, hz, hy: y + t.h - 0.1, gy: y + 0.12, pole: false });
        }
      }
    }
  }

  private buildLamps(glowTex: THREE.Texture, lowEffects: boolean) {
    const d = this.world.d;
    const n = this.lamps.length;
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.12, 1, 6);
    poleGeo.translate(0, 0.5, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2c2f, roughness: 0.6, metalness: 0.5 });
    const headGeo = new THREE.BoxGeometry(0.7, 0.18, 0.35);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffa040, emissiveIntensity: 3.2 });
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, n);
    const arms = new THREE.InstancedMesh(poleGeo, poleMat, n);
    const heads = new THREE.InstancedMesh(headGeo, headMat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    this.lamps.forEach((l, i) => {
      m.compose(p.set(l.x, l.y - 0.2, l.z), q.identity(), l.pole === false ? s.set(0.001, 0.001, 0.001) : s.set(1, l.hy - l.y + 0.3, 1));
      poles.setMatrixAt(i, m);
      const dx = l.hx - l.x, dz = l.hz - l.z;
      const armLen = Math.hypot(dx, dz);
      if (armLen > 0.1 && l.pole !== false) {
        const dir = new THREE.Vector3(dx, 0, dz).normalize();
        q.setFromUnitVectors(up, dir);
        m.compose(p.set(l.x, l.hy, l.z), q, s.set(0.7, armLen, 0.7));
      } else m.compose(p.set(l.x, l.hy, l.z), q.identity(), s.set(0.001, 0.001, 0.001));
      arms.setMatrixAt(i, m);
      q.setFromAxisAngle(up, Math.atan2(dx, dz) + Math.PI / 2);
      m.compose(p.set(l.hx, l.hy - 0.05, l.hz), q, s.set(1, 1, 1));
      heads.setMatrixAt(i, m);
    });
    this.group.add(poles, arms, heads);

    // Ground light pools (additive decals).
    const poolGeo = new THREE.PlaneGeometry(1, 1);
    poolGeo.rotateX(-Math.PI / 2);
    const poolMat = new THREE.MeshBasicMaterial({
      map: glowTex, color: 0xff9a3c, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    poolMat.polygonOffset = true;
    poolMat.polygonOffsetFactor = -6;
    poolMat.polygonOffsetUnits = -6;
    const pools = new THREE.InstancedMesh(poolGeo, poolMat, n);
    this.lamps.forEach((l, i) => {
      const ground = l.gy ?? d.terrain.height(l.hx, l.hz) + 0.12;
      const r2 = (l.hy - ground) * 2.1;
      m.compose(p.set(l.hx, ground, l.hz), q.identity(), s.set(r2, 1, r2));
      pools.setMatrixAt(i, m);
    });
    pools.renderOrder = 2;
    this.group.add(pools);
    this.nightOnly.push(pools);

    // Halo sprites around the lamp heads.
    const halos = glowPoints(this.lamps.map((l) => [l.hx, l.hy - 0.15, l.hz]), glowTex, 0xffb060, 3.2, 0.6);
    this.group.add(halos);
    this.nightOnly.push(halos);

    if (lowEffects) return;
    // Wet-road reflections: a broken amber streak running from below each lamp toward the viewer.
    const streakGeo = new THREE.PlaneGeometry(1, 1);
    const lampAttr = new Float32Array(n * 4);
    this.lamps.forEach((l, i) => lampAttr.set([l.hx, l.hy, l.hz, (i * 0.618) % 1], i * 4));
    const groundAttr = new Float32Array(n);
    this.lamps.forEach((l, i) => (groundAttr[i] = (l.gy ?? d.terrain.height(l.hx, l.hz) + 0.12) - 0.02));
    streakGeo.setAttribute('aGround', new THREE.InstancedBufferAttribute(groundAttr, 1));
    streakGeo.setAttribute('aLamp', new THREE.InstancedBufferAttribute(lampAttr, 4));
    this.streakMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uCam: { value: new THREE.Vector3() }, uMap: { value: streakTexture() }, uColor: { value: new THREE.Color(0xff9a40) }, uWet: worldUniforms.wetness },
      vertexShader: /* glsl */ `
        attribute vec4 aLamp; attribute float aGround; uniform vec3 uCam; uniform float uWet; varying vec2 vUv; varying float vFade;
        void main(){
          vec2 toCam = uCam.xz - aLamp.xz;
          float dist = length(toCam);
          vec2 dir = toCam / max(dist, 0.001);
          vec2 side = vec2(-dir.y, dir.x);
          float len = min(dist*0.75, (aLamp.y - aGround)*3.2);
          float wid = 0.9 + aLamp.w*0.6;
          vec2 base = aLamp.xz + dir*0.6;
          vec2 p = base + dir*(uv.y*len) + side*(position.x*wid);
          vUv = vec2(uv.x, 1.0-uv.y);
          vFade = smoothstep(220.0, 60.0, dist) * smoothstep(1.5, 8.0, dist) * uWet;
          gl_Position = projectionMatrix * viewMatrix * vec4(p.x, aGround, p.y, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; uniform vec3 uColor; varying vec2 vUv; varying float vFade;
        void main(){ vec4 t = texture2D(uMap, vUv); gl_FragColor = vec4(uColor * t.a * 0.85 * vFade, 1.0); }`,
    });
    const streaks = new THREE.InstancedMesh(streakGeo, this.streakMat, n);
    streaks.frustumCulled = false;
    streaks.renderOrder = 2;
    this.streaks = streaks;
    this.group.add(streaks);
  }

  private buildPorches(glowTex: THREE.Texture) {
    const d = this.world.d;
    const porches: { x: number; z: number; h: number; w: number; y: number; g: number }[] = [];
    for (const house of this.world.houses) {
      const hit = d.nearestEdge(house.cx, house.cz, 45);
      if (!hit) continue;
      house.street = { x: hit.x, z: hit.z };
      const tx = hit.x - house.cx, tz = hit.z - house.cz;
      // Pick the rectangle side that faces the street.
      const bx = -house.az, bz = house.ax;
      const da = tx * house.ax + tz * house.az, db = tx * bx + tz * bz;
      let nx: number, nz: number, half: number, along: number;
      if (Math.abs(da) > Math.abs(db)) { nx = Math.sign(da) * house.ax; nz = Math.sign(da) * house.az; half = house.halfL; along = house.halfW; }
      else { nx = Math.sign(db) * bx; nz = Math.sign(db) * bz; half = house.halfW; along = house.halfL; }
      const depth = 2.1;
      const px = house.cx + nx * (half + depth / 2), pz = house.cz + nz * (half + depth / 2);
      if (this.world.onRoad(px, pz) || this.world.walkIndex.query(px, pz) >= 0) continue;
      const gy = this.world.d.terrain.height(px, pz);
      porches.push({ x: px, z: pz, h: Math.atan2(nx, nz), w: Math.min(along * 1.5, 6), y: Math.min(house.wallH, 3.2), g: gy });
    }
    const n = porches.length;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3c, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3a3532, roughness: 0.9 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.8 });
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffc070, emissiveIntensity: 4 });
    const deck = new THREE.InstancedMesh(box, deckMat, n);
    const roof = new THREE.InstancedMesh(box, roofMat, n);
    const posts = new THREE.InstancedMesh(box, postMat, n * 2);
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 6, 4), bulbMat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    porches.forEach((pc, i) => {
      q.setFromAxisAngle(up, pc.h);
      const fx = Math.sin(pc.h), fz = Math.cos(pc.h), rx = -fz, rz = fx;
      m.compose(p.set(pc.x, pc.g + 0.25, pc.z), q, s.set(pc.w, 0.9, 2.1));
      deck.setMatrixAt(i, m);
      m.compose(p.set(pc.x, pc.g + pc.y, pc.z), q, s.set(pc.w + 0.3, 0.18, 2.4));
      roof.setMatrixAt(i, m);
      for (let k = 0; k < 2; k++) {
        const sx = (k === 0 ? 1 : -1) * (pc.w / 2 - 0.2);
        m.compose(p.set(pc.x + rx * sx + fx * 0.85, pc.g + pc.y / 2 + 0.25, pc.z + rz * sx + fz * 0.85), q, s.set(0.16, pc.y - 0.5, 0.16));
        posts.setMatrixAt(i * 2 + k, m);
      }
      const lx = pc.x - fx * 0.85 + rx * (pc.w * 0.3), lz = pc.z - fz * 0.85 + rz * (pc.w * 0.3);
      m.compose(p.set(lx, pc.g + pc.y - 0.5, lz), q, s.set(1, 1, 1));
      bulbs.setMatrixAt(i, m);
      this.porchLights.push({ x: lx, y: pc.g + pc.y - 0.5, z: lz });
    });
    this.group.add(deck, roof, posts, bulbs);
    this.group.add(glowPoints(this.porchLights.map((l) => [l.x, l.y, l.z]), glowTex, 0xffb060, 2.0, 0.5));
  }

  private buildParked() {
    const n = this.parked.length;
    const body = new THREE.BoxGeometry(1.8, 0.75, 4.4);
    body.translate(0, 0.62, 0);
    const cabin = new THREE.BoxGeometry(1.6, 0.6, 2.3);
    cabin.translate(0, 1.27, -0.2);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.4 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 0.1, metalness: 0.6 });
    const wheel = new THREE.CylinderGeometry(0.33, 0.33, 1.84, 10);
    wheel.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    const bodies = new THREE.InstancedMesh(body, bodyMat, n);
    const cabins = new THREE.InstancedMesh(cabin, glassMat, n);
    const wheels = new THREE.InstancedMesh(wheel, wheelMat, n * 2);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    const rng = new Rng(99);
    const col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    this.parked.forEach((c, i) => {
      q.setFromAxisAngle(up, c.h);
      m.compose(p.set(c.x, c.y, c.z), q, s);
      bodies.setMatrixAt(i, m);
      cabins.setMatrixAt(i, m);
      bodies.setColorAt(i, col.set(rng.pick(CAR_COLS)));
      const fx = Math.sin(c.h), fz = Math.cos(c.h);
      for (let k = 0; k < 2; k++) {
        const o = k === 0 ? 1.4 : -1.4;
        m.compose(p.set(c.x + fx * o, c.y + 0.33, c.z + fz * o), q, s);
        wheels.setMatrixAt(i * 2 + k, m);
      }
      // Collision box.
      const rx = -fz, rz = fx;
      const hl = 2.2, hw = 0.9;
      const corners: number[] = [];
      for (const [a, b] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) corners.push(c.x + fx * hl * a + rx * hw * b, c.z + fz * hl * a + rz * hw * b);
      this.world.statics.addPolyline(corners, 'parked', true, c.y - 1, c.y + 1.6);
    });
    this.group.add(bodies, cabins, wheels);
  }

  private buildBeacons(glowTex: THREE.Texture) {
    const b = this.world.d.bounds;
    const pts: { x: number; z: number }[] = [];
    const step = 22;
    for (let x = b.minX; x <= b.maxX; x += step) pts.push({ x, z: b.minZ }, { x, z: b.maxZ });
    for (let z = b.minZ + step; z < b.maxZ; z += step) pts.push({ x: b.minX, z }, { x: b.maxX, z });
    const post = new THREE.CylinderGeometry(0.1, 0.1, 1.4, 6);
    post.translate(0, 0.7, 0);
    const posts = new THREE.InstancedMesh(post, new THREE.MeshStandardMaterial({ color: 0x333333 }), pts.length);
    const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 6, 4), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffa020, emissiveIntensity: 5 }), pts.length);
    const m = new THREE.Matrix4();
    const T = this.world.d.terrain;
    pts.forEach((p, i) => {
      const y = T.height(p.x, p.z);
      m.makeTranslation(p.x, y, p.z);
      posts.setMatrixAt(i, m);
      m.makeTranslation(p.x, y + 1.5, p.z);
      lights.setMatrixAt(i, m);
    });
    this.group.add(posts, lights, glowPoints(pts.map((p) => [p.x, T.height(p.x, p.z) + 1.5, p.z]), glowTex, 0xff9020, 2.2, 0.7));
  }

  private streaks: THREE.InstancedMesh | null = null;

  private low = false;

  /** Lamp pools, halos and wet streaks only show after dark. */
  setNight(on: boolean) {
    this.night = on;
    for (const o of this.nightOnly) o.visible = on;
    if (this.streaks) this.streaks.visible = on && !this.low;
  }

  /** Low-effects preset: drop the wet-road streaks. */
  setLowEffects(low: boolean) {
    this.low = low;
    if (this.streaks) this.streaks.visible = this.night && !low;
  }

  update(camera: THREE.Camera) {
    if (this.streakMat) this.streakMat.uniforms.uCam.value.copy(camera.position);
  }
}

/** Additive camera-facing glow sprites. */
export function glowPoints(positions: number[][], tex: THREE.Texture, color: number, size: number, opacity: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions.flat(), 3));
  const mat = new THREE.PointsMaterial({
    map: tex, color, size, sizeAttenuation: true, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const pts = new THREE.Points(g, mat);
  pts.renderOrder = 3;
  return pts;
}
