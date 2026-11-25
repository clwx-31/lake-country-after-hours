// Pooled visual effects for damage and police weapons: smoke, fire, sparks,
// muzzle flashes (GPU points, two draw calls), tracer and laser lines, and
// expanding fireballs with one shared flash light. Nothing allocates per frame.
import * as THREE from 'three';

const MAX = 1600;

interface Pool {
  points: THREE.Points;
  pos: Float32Array;
  vel: Float32Array;
  col: Float32Array; // r, g, b, alpha
  size: Float32Array;
  life: Float32Array;
  max: Float32Array;
  grow: Float32Array;
  drag: Float32Array;
  rise: Float32Array;
  next: number;
}

function makePool(additive: boolean): Pool {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAX * 3), col = new Float32Array(MAX * 4), size = new Float32Array(MAX);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uScale: { value: 600 } },
    vertexShader: /* glsl */ `
      attribute vec4 color; attribute float size; uniform float uScale; varying vec4 vC;
      void main(){
        vC = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uScale / max(1.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vC;
      void main(){
        vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0;
        if (r > 1.0) discard;
        float a = vC.a * smoothstep(1.0, 0.35, r);
        gl_FragColor = vec4(vC.rgb, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = additive ? 6 : 5;
  return {
    points, pos, vel: new Float32Array(MAX * 3), col, size, life: new Float32Array(MAX), max: new Float32Array(MAX),
    grow: new Float32Array(MAX), drag: new Float32Array(MAX), rise: new Float32Array(MAX), next: 0,
  };
}

export class Effects {
  readonly group = new THREE.Group();
  private smoke = makePool(false);
  private glow = makePool(true);
  private lines: THREE.LineSegments;
  private linePos = new Float32Array(64 * 6);
  private lineCol = new Float32Array(64 * 6);
  private lineLife = new Float32Array(64);
  private lineNext = 0;
  private balls: { mesh: THREE.Mesh; t: number; dur: number; r: number }[] = [];
  private flash = new THREE.PointLight(0xffa040, 0, 60, 1.6);
  private flashT = 0;

  constructor() {
    this.group.add(this.smoke.points, this.glow.points);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 7;
    this.group.add(this.lines);
    const fireMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), fireMat.clone());
      mesh.visible = false;
      this.group.add(mesh);
      this.balls.push({ mesh, t: 0, dur: 0, r: 0 });
    }
    this.group.add(this.flash);
  }

  /** Point size scale follows the viewport height so sizes are in metres. */
  resize(heightPx: number, fovDeg: number) {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    (this.smoke.points.material as THREE.ShaderMaterial).uniforms.uScale.value = s;
    (this.glow.points.material as THREE.ShaderMaterial).uniforms.uScale.value = s;
  }

  private emit(p: Pool, x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, a: number, size: number, life: number, grow: number, drag: number, rise: number) {
    const i = p.next;
    p.next = (p.next + 1) % MAX;
    p.pos.set([x, y, z], i * 3);
    p.vel.set([vx, vy, vz], i * 3);
    p.col.set([r, g, b, a], i * 4);
    p.size[i] = size;
    p.life[i] = life;
    p.max[i] = life;
    p.grow[i] = grow;
    p.drag[i] = drag;
    p.rise[i] = rise;
  }

  /** Engine smoke: grey when hurt, thick black when nearly gone. */
  smokePuff(x: number, y: number, z: number, dark: number, wind = 0) {
    const g = 0.22 - dark * 0.16;
    this.emit(this.smoke, x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4, wind + (Math.random() - 0.5) * 0.6, 1.4 + Math.random(), (Math.random() - 0.5) * 0.6, g, g, g * 1.05, 0.28 + dark * 0.3, 0.7 + dark * 0.5, 2.2 + dark, 1.4, 0.4, 0.6);
  }

  fire(x: number, y: number, z: number) {
    this.emit(this.glow, x + (Math.random() - 0.5) * 0.8, y, z + (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, 2 + Math.random() * 1.5, (Math.random() - 0.5) * 0.8, 1, 0.45 + Math.random() * 0.25, 0.08, 0.9, 1.1 + Math.random() * 0.6, 0.6 + Math.random() * 0.3, -0.8, 0.5, 1.5);
  }

  sparks(x: number, y: number, z: number, count: number, dirX = 0, dirZ = 0, speed = 6) {
    for (let k = 0; k < count; k++) {
      this.emit(this.glow, x, y, z, dirX * speed + (Math.random() - 0.5) * speed, 1 + Math.random() * 3, dirZ * speed + (Math.random() - 0.5) * speed, 1, 0.75, 0.3, 1, 0.12 + Math.random() * 0.1, 0.25 + Math.random() * 0.35, 0, 0.6, -9);
    }
  }

  muzzle(x: number, y: number, z: number) {
    this.emit(this.glow, x, y, z, 0, 0, 0, 1, 0.85, 0.5, 1, 0.9, 0.07, 3, 0, 0);
  }

  /** A short bright streak from a to b (gunfire). */
  tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    this.line(ax, ay, az, bx, by, bz, 1, 0.85, 0.45, 0.08);
  }

  /** Laser sight for this frame only (call every frame while aiming). */
  laser(ax: number, ay: number, az: number, bx: number, by: number, bz: number, strength = 1) {
    this.line(ax, ay, az, bx, by, bz, strength, 0.08 * strength, 0.08 * strength, 0.0001);
  }

  private line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, g: number, b: number, life: number) {
    const i = this.lineNext;
    this.lineNext = (this.lineNext + 1) % this.lineLife.length;
    this.linePos.set([ax, ay, az, bx, by, bz], i * 6);
    this.lineCol.set([r, g, b, r, g, b], i * 6);
    this.lineLife[i] = life;
  }

  /** Rocket exhaust trail. */
  trail(x: number, y: number, z: number) {
    this.emit(this.smoke, x, y, z, (Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4, 0.72, 0.72, 0.72, 0.5, 0.5, 1.4, 1.2, 0.5, 0.2);
    this.emit(this.glow, x, y, z, 0, 0, 0, 1, 0.6, 0.2, 1, 0.45, 0.06, 0, 0, 0);
  }

  explosion(x: number, y: number, z: number, radius = 8) {
    const b = this.balls.find((q) => q.t >= q.dur) ?? this.balls[0];
    b.t = 0;
    b.dur = 0.55;
    b.r = radius * 0.8;
    b.mesh.position.set(x, y + 1, z);
    b.mesh.visible = true;
    this.flash.position.set(x, y + 3, z);
    this.flash.intensity = 400;
    this.flashT = 0.35;
    for (let k = 0; k < 26; k++) this.emit(this.smoke, x + (Math.random() - 0.5) * 3, y + 0.5 + Math.random() * 2, z + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6, 0.18, 0.16, 0.15, 0.85, 2.5 + Math.random() * 2, 2.5 + Math.random() * 1.5, 1.3, 1.2, 0.8);
    for (let k = 0; k < 18; k++) this.emit(this.glow, x, y + 1, z, (Math.random() - 0.5) * 14, 3 + Math.random() * 8, (Math.random() - 0.5) * 14, 1, 0.55, 0.15, 1, 1.2 + Math.random(), 0.4 + Math.random() * 0.4, -1, 0.8, -4);
    this.sparks(x, y + 0.5, z, 30, 0, 0, 14);
  }

  update(dt: number) {
    for (const p of [this.smoke, this.glow]) {
      for (let i = 0; i < MAX; i++) {
        if (p.life[i] <= 0) { p.col[i * 4 + 3] = 0; continue; }
        p.life[i] -= dt;
        const k = Math.max(0, p.life[i] / p.max[i]);
        const d = Math.exp(-p.drag[i] * dt);
        p.vel[i * 3] *= d; p.vel[i * 3 + 2] *= d;
        p.vel[i * 3 + 1] = p.vel[i * 3 + 1] * d + p.rise[i] * dt;
        p.pos[i * 3] += p.vel[i * 3] * dt;
        p.pos[i * 3 + 1] += p.vel[i * 3 + 1] * dt;
        p.pos[i * 3 + 2] += p.vel[i * 3 + 2] * dt;
        p.size[i] = Math.max(0.02, p.size[i] + p.grow[i] * dt);
        // Fade in fast, out slowly.
        const a0 = p.col[i * 4 + 3];
        p.col[i * 4 + 3] = p.life[i] <= 0 ? 0 : Math.min(a0, k * 1.2 + 0.05) * (k < 0.98 ? 1 : 1);
      }
      const g = p.points.geometry;
      (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      (g.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    }
    for (let i = 0; i < this.lineLife.length; i++) {
      if (this.lineLife[i] > 0) this.lineLife[i] -= dt;
      else if (this.lineLife[i] > -1) {
        this.linePos.fill(0, i * 6, i * 6 + 6);
        this.lineLife[i] = -2;
      }
    }
    (this.lines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.lines.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    for (const b of this.balls) {
      if (!b.mesh.visible) continue;
      b.t += dt;
      const k = b.t / b.dur;
      if (k >= 1) { b.mesh.visible = false; continue; }
      b.mesh.scale.setScalar(b.r * (0.35 + k * 0.9));
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
      (b.mesh.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.65 - k * 0.4, 0.25 - k * 0.2);
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flash.intensity = Math.max(0, this.flashT / 0.35) * 400;
    }
  }
}
