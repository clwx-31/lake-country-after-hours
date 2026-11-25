// Event set dressing: start beacons, checkpoint gates, drift-zone edges,
// marked hop obstacles, arches, roadblocks, and floating text labels.
import * as THREE from 'three';
import type { Path } from '../core/math';

export function textSprite(text: string, opts: { color?: string; bg?: string; size?: number; width?: number; sub?: string } = {}) {
  const c = document.createElement('canvas');
  const w = opts.width ?? 512, h = opts.sub ? 160 : 112;
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  if (opts.bg) {
    g.fillStyle = opts.bg;
    g.fillRect(0, 0, w, h);
  }
  g.fillStyle = opts.color ?? '#ffb347';
  let size = opts.size ?? 64;
  g.font = `800 ${size}px "Barlow Condensed", sans-serif`;
  while (g.measureText(text).width > w - 16 && size > 20) {
    size -= 4;
    g.font = `800 ${size}px "Barlow Condensed", sans-serif`;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, opts.sub ? 58 : h / 2);
  if (opts.sub) {
    g.font = `600 34px "Barlow Condensed", sans-serif`;
    g.fillStyle = '#f2ede4';
    g.fillText(opts.sub, w / 2, 122);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const s = new THREE.Sprite(mat);
  s.scale.set((w / h) * 1.4, 1.4, 1);
  s.renderOrder = 5;
  return s;
}

const beamGeo = new THREE.CylinderGeometry(1.2, 1.8, 60, 16, 1, true);
beamGeo.translate(0, 30, 0);

export function beacon(color: number, label: string, sub?: string) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.11, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(beamGeo, mat);
  const ringGeo = new THREE.RingGeometry(5.5, 6.4, 40);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
  ring.position.y = 0.08;
  const t = textSprite(label, { sub, color: '#' + new THREE.Color(color).getHexString() });
  t.position.y = 7;
  t.scale.multiplyScalar(2.4);
  g.add(beam, ring, t);
  return g;
}

/** Gate spanning the road: two posts and a glowing banner. */
export function gate(width: number, color: number, label = '', height = 4.6) {
  const g = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: 0x1b1d22, emissive: color, emissiveIntensity: 0.6 });
  const postGeo = new THREE.BoxGeometry(0.35, height, 0.35);
  postGeo.translate(0, height / 2, 0);
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(postGeo, postMat);
    p.position.x = (s * width) / 2;
    g.add(p);
  }
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(width, 0.8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  banner.position.y = height - 0.4;
  g.add(banner);
  const sheet = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height - 0.8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  sheet.position.y = (height - 0.8) / 2;
  g.add(sheet);
  if (label) {
    const t = textSprite(label, { color: '#ffffff' });
    t.position.y = height + 1.0;
    t.scale.multiplyScalar(1.4);
    g.add(t);
  }
  g.userData.sheet = sheet;
  g.userData.banner = banner;
  return g;
}

export function setGateColor(g: THREE.Group, color: number, opacity = 0.85) {
  const banner = g.userData.banner as THREE.Mesh;
  const sheet = g.userData.sheet as THREE.Mesh;
  (banner.material as THREE.MeshBasicMaterial).color.set(color);
  (banner.material as THREE.MeshBasicMaterial).opacity = opacity;
  (sheet.material as THREE.MeshBasicMaterial).color.set(color);
}

/** Box marking a stop zone on the road surface. */
export function floorBox(width: number, length: number, color: number) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -6;
  const bar = (w: number, l: number, x: number, z: number) => {
    const geo = new THREE.PlaneGeometry(w, l);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, 0.07, z);
    g.add(m);
  };
  bar(width, 0.35, 0, 0);
  bar(width, 0.35, 0, length);
  bar(0.35, length, -width / 2, length / 2);
  bar(0.35, length, width / 2, length / 2);
  const fill = new THREE.PlaneGeometry(width, length);
  fill.rotateX(-Math.PI / 2);
  const f = new THREE.Mesh(fill, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending }));
  f.position.set(0, 0.06, length / 2);
  g.add(f);
  return g;
}

/** Glowing strips along both road edges between s0 and s1 of a route. */
export function zoneStrips(path: Path, s0: number, s1: number, halfWidth: number, color: number) {
  const pts: number[] = [];
  const idx: number[] = [];
  let n = 0;
  for (const side of [-1, 1]) {
    const base = n;
    for (let s = s0; s <= s1; s += 2) {
      const p = path.pointAt(s);
      const h = path.headingAt(s);
      const rx = -Math.cos(h), rz = Math.sin(h);
      const o = side * halfWidth;
      const ox = p.x + rx * o, oz = p.z + rz * o;
      pts.push(ox, 0.08, oz, ox, 0.9, oz);
      if (n > base) idx.push(n * 2 - 2, n * 2 - 1, n * 2, n * 2 - 1, n * 2 + 1, n * 2);
      n++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const uv: number[] = [];
  for (let i = 0; i < pts.length / 6; i++) uv.push(0, 0, 0, 1);
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uColor; varying vec2 vUv; void main(){ gl_FragColor = vec4(uColor*(1.0-vUv.y)*0.9, 1.0); }',
  });
  return new THREE.Mesh(geo, mat);
}

/** Low timber obstacle with chevrons: Rally Hop clears it, other cars go around. */
export function obstacle(length: number) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4b2a, roughness: 0.9 });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(length, 0.32, 0.5), wood);
  beam.position.y = 0.22;
  g.add(beam);
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 32;
  const cg = c.getContext('2d')!;
  for (let i = 0; i < 16; i++) {
    cg.fillStyle = i % 2 ? '#111' : '#ffb000';
    cg.beginPath();
    cg.moveTo(i * 16, 32); cg.lineTo(i * 16 + 16, 0); cg.lineTo(i * 16 + 32, 0); cg.lineTo(i * 16 + 16, 32);
    cg.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(length / 2, 1);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(length, 0.3), new THREE.MeshStandardMaterial({ map: tex, emissive: 0x332200, emissiveMap: tex }));
  for (const s of [-1, 1]) {
    const f = face.clone();
    f.position.set(0, 0.22, s * 0.26);
    f.rotation.y = s > 0 ? 0 : Math.PI;
    g.add(f);
  }
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x220, emissive: 0xffa000, emissiveIntensity: 4 });
  for (const x of [-length / 2 + 0.2, length / 2 - 0.2]) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), lampMat);
    l.position.set(x, 0.5, 0);
    g.add(l);
  }
  return g;
}

/** Barrier boards for a roadblock, with flashing amber lamps. */
export function barrier(length: number) {
  const g = new THREE.Group();
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const cg = c.getContext('2d')!;
  for (let i = 0; i < 12; i++) {
    cg.fillStyle = i % 2 ? '#e8e8e8' : '#d0261c';
    cg.beginPath();
    cg.moveTo(i * 28 - 20, 64); cg.lineTo(i * 28 + 8, 0); cg.lineTo(i * 28 + 36, 0); cg.lineTo(i * 28 + 8, 64);
    cg.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(length / 3, 1);
  const board = new THREE.Mesh(new THREE.BoxGeometry(length, 0.5, 0.12), new THREE.MeshStandardMaterial({ map: tex, emissive: 0x401010, emissiveMap: tex }));
  board.position.y = 0.95;
  g.add(board);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  for (let x = -length / 2 + 0.3; x <= length / 2 - 0.3; x += Math.max(1.2, (length - 0.6) / 3)) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 0.6), legMat);
    leg.position.set(x, 0.6, 0);
    g.add(leg);
  }
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x221100, emissive: 0xffa020, emissiveIntensity: 5 });
  const lamps: THREE.Mesh[] = [];
  for (let x = -length / 2 + 0.3; x <= length / 2; x += 1.6) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), lampMat);
    l.position.set(x, 1.35, 0);
    lamps.push(l);
    g.add(l);
  }
  g.userData.lampMat = lampMat;
  return g;
}

/** Arrow chevrons on the road pointing through an open lane. */
export function laneArrows(color: number) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, 1.2); shape.lineTo(0.9, -0.2); shape.lineTo(0.35, -0.2); shape.lineTo(0, 0.45); shape.lineTo(-0.35, -0.2); shape.lineTo(-0.9, -0.2);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -6;
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.y = Math.PI;
    m.position.set(0, 0.08, -4 - i * 2.2);
    g.add(m);
  }
  return g;
}

/** Kart-style boost pad: glowing chevrons flat on the road, pointing forward (+Z). */
export function boostPad(width = 4, length = 5) {
  const g = new THREE.Group();
  const base = new THREE.PlaneGeometry(width, length);
  base.rotateX(-Math.PI / 2);
  const baseMat = new THREE.MeshBasicMaterial({ color: 0x0a2a3a, transparent: true, opacity: 0.75, depthWrite: false });
  baseMat.polygonOffset = true;
  baseMat.polygonOffsetFactor = -6;
  const b = new THREE.Mesh(base, baseMat);
  b.position.y = 0.1;
  g.add(b);
  const mat = new THREE.MeshBasicMaterial({ color: 0x45e0ff, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -8;
  const shape = new THREE.Shape();
  const hw = width * 0.4, t = 0.55;
  shape.moveTo(-hw, 0);
  shape.lineTo(0, hw * 0.75);
  shape.lineTo(hw, 0);
  shape.lineTo(hw, -t);
  shape.lineTo(0, hw * 0.75 - t);
  shape.lineTo(-hw, -t);
  shape.closePath();
  const chev = new THREE.ShapeGeometry(shape);
  chev.rotateX(-Math.PI / 2);
  // ShapeGeometry is in XY; after rotateX(-90deg) +Y maps to -Z, so flip to point forward.
  chev.rotateY(Math.PI);
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(chev, mat);
    m.position.set(0, 0.12, -length / 2 + 0.9 + i * 1.5);
    g.add(m);
  }
  return g;
}
