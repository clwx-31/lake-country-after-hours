// Fictional venues placed on the real street network, plus village welcome
// signs where main roads enter Hartland and Chenequa.
import * as THREE from 'three';
import { pointInPolygon } from '../core/math';
import type { District } from '../map/District';
import { GARAGE, REHEARSAL, VENUE, resolveAnchor, venueFrame } from '../map/places';
import { MAP } from '../map/maps';
import type { StaticWorld } from '../sim/Physics';

function signTexture(lines: { text: string; font: string; color: string }[], w: number, h: number, bg: string, border?: string) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  if (border) {
    g.strokeStyle = border;
    g.lineWidth = 8;
    g.strokeRect(6, 6, w - 12, h - 12);
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const step = h / (lines.length + 1);
  lines.forEach((l, i) => {
    g.font = l.font;
    g.fillStyle = l.color;
    g.fillText(l.text, w / 2, step * (i + 1));
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export interface GarageRig {
  root: THREE.Group;
  door: THREE.Mesh;
  doorOpen: number; // 0 closed .. 1 open
  doorTarget: number;
  lamp: THREE.SpotLight;
  inside: THREE.PointLight;
  radioPos: THREE.Vector3;
  showcase: { x: number; z: number; y: number; h: number };
  curb: { x: number; z: number; h: number };
  y: number;
  face: number;
  center: { x: number; z: number };
}

export class Venues {
  readonly group = new THREE.Group();
  readonly garage: GarageRig;

  private foundation = new THREE.MeshStandardMaterial({ color: 0x6e6a62, roughness: 0.95 });

  constructor(private d: District, statics: StaticWorld, private ground: (x: number, z: number) => number) {
    this.garage = this.buildGarage(statics);
    this.buildRehearsal(statics);
    this.buildCopperEar(statics);
    this.buildWelcomeSigns();
  }

  /** Ground height for a venue: its street frontage, with a plinth hiding any gap downhill. */
  private seat(root: THREE.Group, f: ReturnType<typeof venueFrame>, w: number, dpt: number) {
    const y = this.ground(f.front.x, f.front.z);
    root.position.set(f.center.x, y, f.center.z);
    root.rotation.y = f.face;
    this.box(w + 0.3, 6, dpt + 0.3, this.foundation, 0, -3 + 0.02, 0, root);
    return y;
  }

  private box(w: number, h: number, dpt: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dpt), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  /** Footprint colliders for a rectangular building in local frame (front at z = +depth/2). */
  private rectCollider(statics: StaticWorld, root: THREE.Object3D, w: number, dpt: number, gapFront = 0) {
    root.updateMatrixWorld(true);
    const P = (x: number, z: number) => new THREE.Vector3(x, 0, z).applyMatrix4(root.matrixWorld);
    const c = [P(-w / 2, -dpt / 2), P(w / 2, -dpt / 2), P(w / 2, dpt / 2), P(-w / 2, dpt / 2)];
    statics.addSegment(c[0].x, c[0].z, c[1].x, c[1].z, 'building');
    statics.addSegment(c[1].x, c[1].z, c[2].x, c[2].z, 'building');
    statics.addSegment(c[3].x, c[3].z, c[0].x, c[0].z, 'building');
    if (gapFront <= 0) statics.addSegment(c[2].x, c[2].z, c[3].x, c[3].z, 'building');
    else {
      // Front wall with the open bay left clear (bay on local +x side).
      const a = P(-w / 2, dpt / 2), b = P(w / 2 - gapFront - 0.6, dpt / 2), e = P(w / 2 - 0.6, dpt / 2), f = P(w / 2, dpt / 2);
      statics.addSegment(a.x, a.z, b.x, b.z, 'building');
      statics.addSegment(e.x, e.z, f.x, f.z, 'building');
    }
  }

  private buildGarage(statics: StaticWorld): GarageRig {
    const f = venueFrame(this.d, GARAGE);
    const root = new THREE.Group();
    const W = GARAGE.width, D = GARAGE.depth, H = 5.2;
    const gy = this.seat(root, f, W, D); // local +z faces the street
    const wall = new THREE.MeshStandardMaterial({ color: 0x4b5a52, roughness: 0.85 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.6 });
    const floor = new THREE.MeshStandardMaterial({ color: 0x5a5852, roughness: 0.7 });
    // Shell: back, sides, roof, front piers and header.
    this.box(W, H, 0.3, wall, 0, H / 2, -D / 2, root);
    this.box(0.3, H, D, wall, -W / 2, H / 2, 0, root);
    this.box(0.3, H, D, wall, W / 2, H / 2, 0, root);
    this.box(W + 0.4, 0.4, D + 0.4, trim, 0, H + 0.2, 0, root);
    this.box(W, 0.06, D, floor, 0, 0.03, 0, root);
    const bayW = 4.2;
    // Front: pier, closed bay, pier, open bay, pier. Bay 2 (local +x) is open.
    this.box(0.9, H, 0.3, wall, -W / 2 + 0.45, H / 2, D / 2, root);
    this.box(1.4, H, 0.3, wall, 0, H / 2, D / 2, root);
    this.box(0.9, H, 0.3, wall, W / 2 - 0.45, H / 2, D / 2, root);
    this.box(W, H - 3.6, 0.3, wall, 0, 3.6 + (H - 3.6) / 2, D / 2, root);
    // Corrugated door texture.
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 256;
    const g = c.getContext('2d')!;
    for (let y = 0; y < 256; y += 16) {
      g.fillStyle = '#8f9396';
      g.fillRect(0, y, 64, 12);
      g.fillStyle = '#5d6164';
      g.fillRect(0, y + 12, 64, 4);
    }
    const doorTex = new THREE.CanvasTexture(c);
    doorTex.colorSpace = THREE.SRGBColorSpace;
    const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.5, metalness: 0.4 });
    const closedX = -(0.7 + bayW / 2);
    this.box(bayW, 3.6, 0.12, doorMat, closedX, 1.8, D / 2 - 0.05, root);
    const openX = 0.7 + bayW / 2;
    const door = this.box(bayW, 3.6, 0.12, doorMat, openX, 1.8, D / 2 - 0.05, root);
    door.geometry.translate(0, 1.8, 0);
    door.position.y = 0;
    // Sign board (fictional business).
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(W - 1, 1.1),
      new THREE.MeshStandardMaterial({
        map: signTexture([{ text: GARAGE.sign[0], font: '800 74px "Barlow Condensed", sans-serif', color: '#f3d29b' }], 1024, 128, '#1f2a26', '#b98b4a'),
        emissive: 0xffffff, emissiveIntensity: 0.35, emissiveMap: null,
      }),
    );
    (sign.material as THREE.MeshStandardMaterial).emissiveMap = (sign.material as THREE.MeshStandardMaterial).map;
    sign.position.set(0, 4.4, D / 2 + 0.17);
    root.add(sign);
    // Interior: workbench, tool board, drum kit under a dust cover, radio.
    const bench = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.8 });
    this.box(3.2, 0.9, 0.8, bench, openX, 0.45, -D / 2 + 0.7, root);
    const pegs = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.4), new THREE.MeshStandardMaterial({ color: 0x8c7a5c }));
    pegs.position.set(openX, 1.9, -D / 2 + 0.17);
    root.add(pegs);
    for (let i = 0; i < 9; i++) {
      const tool = this.box(0.08, 0.3 + (i % 3) * 0.12, 0.04, trim, openX - 1.4 + i * 0.35, 1.9, -D / 2 + 0.2, root);
      tool.rotation.z = (i % 2 ? 0.2 : -0.15);
    }
    // Drum kit under a dust cover: a soft draped blob with a cymbal poking out.
    const kit = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({ color: 0x6e6a5e, roughness: 1, flatShading: true });
    const drapeGeo = new THREE.SphereGeometry(1, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const pos = drapeGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      pos.setX(i, pos.getX(i) * (1 + 0.08 * Math.sin(i * 1.7)));
      pos.setZ(i, pos.getZ(i) * (1 + 0.08 * Math.cos(i * 2.3)));
      pos.setY(i, y * (0.85 + 0.1 * Math.sin(i * 0.9)));
    }
    drapeGeo.computeVertexNormals();
    const drape = new THREE.Mesh(drapeGeo, cloth);
    drape.scale.set(1.15, 1.05, 0.95);
    kit.add(drape);
    const tomBulge = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), cloth);
    tomBulge.position.set(0.3, 1.0, 0.1);
    kit.add(tomBulge);
    const stand = this.box(0.03, 1.5, 0.03, trim, -0.95, 0.75, -0.2, kit);
    stand.rotation.z = 0.1;
    const cymbal = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.015, 24), new THREE.MeshStandardMaterial({ color: 0xc8a24a, metalness: 0.9, roughness: 0.25 }));
    cymbal.position.set(-1.0, 1.52, -0.2);
    cymbal.rotation.z = 0.15;
    kit.add(cymbal);
    const kickHead = new THREE.Mesh(new THREE.CircleGeometry(0.32, 20), new THREE.MeshStandardMaterial({ color: 0x1d1d1d }));
    kickHead.position.set(0, 0.36, 0.93);
    kit.add(kickHead);
    kit.position.set(closedX + 0.6, 0, -1.2);
    root.add(kit);
    // Portable radio on the bench, dial glowing.
    const radio = new THREE.Group();
    this.box(0.5, 0.3, 0.18, new THREE.MeshStandardMaterial({ color: 0x7a2a22, roughness: 0.6 }), 0, 0.15, 0, radio);
    this.box(0.2, 0.08, 0.02, new THREE.MeshStandardMaterial({ color: 0x221100, emissive: 0xffa040, emissiveIntensity: 2 }), 0.1, 0.2, 0.1, radio);
    const handle = this.box(0.42, 0.03, 0.03, trim, 0, 0.36, 0, radio);
    handle.position.y = 0.36;
    radio.position.set(openX - 0.9, 0.9, -D / 2 + 0.7);
    root.add(radio);
    const inside = new THREE.PointLight(0xffb070, 14, 14, 1.6);
    inside.position.set(openX, 3.2, -1);
    root.add(inside);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshStandardMaterial({ color: 0x221100, emissive: 0xffd09a, emissiveIntensity: 6 }));
    bulb.position.copy(inside.position);
    root.add(bulb);
    // Amber gooseneck lamp over the open bay; a real spotlight on the apron and street.
    const arm = this.box(0.06, 0.06, 0.8, trim, openX, 4.3, D / 2 + 0.45, root);
    arm.rotation.x = 0.3;
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.3, 14, 1, true), new THREE.MeshStandardMaterial({ color: 0x2b3a33, side: THREE.DoubleSide }));
    shade.position.set(openX, 4.2, D / 2 + 0.85);
    root.add(shade);
    const lampBulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshStandardMaterial({ color: 0x221100, emissive: 0xffa340, emissiveIntensity: 8 }));
    lampBulb.position.set(openX, 4.1, D / 2 + 0.85);
    root.add(lampBulb);
    const lamp = new THREE.SpotLight(0xffa04a, 38, 30, 0.7, 0.7, 1.6);
    lamp.position.set(openX, 4.1, D / 2 + 0.9);
    lamp.target.position.set(openX - 1, 0, D / 2 + 9);
    root.add(lamp, lamp.target);
    // Apron slab between sidewalk and doors.
    const apron = new THREE.Mesh(new THREE.BoxGeometry(W, 0.08, f.street ? GARAGE.setback - 4.3 : 4), floor);
    apron.position.set(0, 0.04, D / 2 + (GARAGE.setback - 4.3) / 2);
    root.add(apron);
    this.group.add(root);
    this.rectCollider(statics, root, W, D, bayW);
    root.updateMatrixWorld(true);
    const local = (x: number, z: number) => new THREE.Vector3(x, 0, z).applyMatrix4(root.matrixWorld);
    const showcase = local(openX, D / 2 + 2.6);
    // The car waits at the curb just up the block, nose toward College Avenue, so
    // the low opening shot from behind it takes in the garage and its amber lamp.
    const park = resolveAnchor(this.d, { ...GARAGE.anchor, along: GARAGE.anchor.along + 7 });
    const pe = this.d.edges[park.edge];
    const off = (pe.width / 2 - 1.3) * GARAGE.side;
    const curb = { x: park.x - Math.cos(park.h) * off, z: park.z + Math.sin(park.h) * off, h: park.h + Math.PI };
    root.worldToLocal(lamp.target.position.set(curb.x, this.ground(curb.x, curb.z), curb.z));
    return {
      root, door, doorOpen: 1, doorTarget: 1, lamp, inside,
      radioPos: local(openX - 0.9, -D / 2 + 0.7),
      showcase: { x: showcase.x, z: showcase.z, y: gy + 0.08, h: f.face - 0.75 },
      curb,
      y: gy,
      face: f.face,
      center: f.center,
    };
  }

  /** Animate the roll-up door (open = 1). */
  update(dt: number) {
    const g = this.garage;
    g.doorOpen += Math.sign(g.doorTarget - g.doorOpen) * Math.min(Math.abs(g.doorTarget - g.doorOpen), dt * 0.45);
    // Rolled up: scale the panel toward the header.
    g.door.scale.y = Math.max(0.04, 1 - g.doorOpen);
    g.door.position.y = 3.6 * (1 - g.door.scale.y);
    g.inside.intensity = 4 + 10 * g.doorOpen;
  }

  private buildRehearsal(statics: StaticWorld) {
    const f = venueFrame(this.d, REHEARSAL);
    const root = new THREE.Group();
    const W = REHEARSAL.width, D = REHEARSAL.depth, H = 6.5;
    this.seat(root, f, W, D);
    const brick = new THREE.MeshStandardMaterial({ color: 0x6a3426, roughness: 0.9 });
    this.box(W, H, D, brick, 0, H / 2, 0, root);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 1.6),
      new THREE.MeshStandardMaterial({
        map: signTexture([
          { text: REHEARSAL.sign[0], font: '800 110px "Barlow Condensed", sans-serif', color: '#7ad7ff' },
          { text: REHEARSAL.sign[1], font: '600 52px "Barlow Condensed", sans-serif', color: '#e8e4d8' },
        ], 1024, 280, '#0b1418'),
        emissive: 0xffffff, emissiveIntensity: 0.9,
      }),
    );
    (sign.material as THREE.MeshStandardMaterial).emissiveMap = (sign.material as THREE.MeshStandardMaterial).map;
    sign.position.set(0, 4.3, D / 2 + 0.03);
    root.add(sign);
    const doorLight = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.4), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffb36a, emissiveIntensity: 1.6 }));
    doorLight.position.set(-2.5, 1.2, D / 2 + 0.03);
    root.add(doorLight);
    this.group.add(root);
    this.rectCollider(statics, root, W, D);
  }

  private buildCopperEar(statics: StaticWorld) {
    const f = venueFrame(this.d, VENUE);
    const root = new THREE.Group();
    const W = VENUE.width, D = VENUE.depth, H = 9;
    this.seat(root, f, W, D);
    const stone = new THREE.MeshStandardMaterial({ color: 0x8a7a66, roughness: 0.85 });
    this.box(W, H, D, stone, 0, H / 2, 0, root);
    // Marquee with bulbs.
    const marquee = new THREE.Mesh(
      new THREE.BoxGeometry(W - 2, 1.8, 1.2),
      new THREE.MeshStandardMaterial({
        map: signTexture([
          { text: VENUE.sign[0], font: '800 120px "Barlow Condensed", sans-serif', color: '#ffcf7a' },
          { text: VENUE.sign[1], font: '600 60px "Barlow Condensed", sans-serif', color: '#ffffff' },
        ], 1024, 300, '#2a120a', '#d4823a'),
        emissive: 0xffffff, emissiveIntensity: 0.8,
      }),
    );
    (marquee.material as THREE.MeshStandardMaterial).emissiveMap = (marquee.material as THREE.MeshStandardMaterial).map;
    marquee.position.set(0, 4.2, D / 2 + 0.6);
    root.add(marquee);
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0x221100, emissive: 0xffd08a, emissiveIntensity: 5 });
    for (let x = -W / 2 + 1.2; x <= W / 2 - 1.2; x += 0.6) {
      for (const y of [3.25, 5.15]) this.box(0.1, 0.1, 0.1, bulbMat, x, y, D / 2 + 1.22, root);
    }
    const glow = new THREE.PointLight(0xffa060, 30, 18, 1.5);
    glow.position.set(0, 3, D / 2 + 3);
    root.add(glow);
    this.group.add(root);
    this.rectCollider(statics, root, W, D);
  }

  /** "Village of ..." signs where main roads cross into the map's villages. */
  private buildWelcomeSigns() {
    const signs = MAP.welcomeSigns;
    const villages = (this.d.data.villages ?? []).filter((v) => signs.some((w) => w.name === v.n) && v.p.length > 60);
    const brick = new THREE.MeshStandardMaterial({ color: 0x7a3b2a, roughness: 0.9 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.8 });
    const tex: Record<string, THREE.Texture> = {};
    const placed: { x: number; z: number }[] = [];
    for (const v of villages) {
      tex[v.n] ??= signTexture([
        { text: 'Welcome to', font: 'italic 400 52px Georgia, serif', color: '#e8dcc0' },
        { text: `Village of ${v.n}`, font: '700 84px Georgia, serif', color: '#fff6e0' },
        { text: signs.find((w) => w.name === v.n)!.est, font: '400 40px Georgia, serif', color: '#d8c8a4' },
      ], 1024, 360, signs.find((w) => w.name === v.n)!.bg, '#c9a44a');
      for (const e of this.d.edges) {
        if (!['primary', 'secondary', 'tertiary'].includes(e.cls) || e.bridge) continue;
        const pts = e.pts;
        for (let i = 2; i < pts.length; i += 2) {
          const ina = pointInPolygon(pts[i - 2], pts[i - 1], v.p), inb = pointInPolygon(pts[i], pts[i + 1], v.p);
          if (ina === inb) continue;
          // Travel direction into the village; the sign stands on the right, facing incoming traffic.
          const [ox, oz, ix, iz] = ina ? [pts[i], pts[i + 1], pts[i - 2], pts[i - 1]] : [pts[i - 2], pts[i - 1], pts[i], pts[i + 1]];
          const len = Math.hypot(ix - ox, iz - oz) || 1;
          const fx = (ix - ox) / len, fz = (iz - oz) / len;
          const mx = (ox + ix) / 2, mz = (oz + iz) / 2;
          if (placed.some((q) => Math.hypot(q.x - mx, q.z - mz) < 400)) continue;
          placed.push({ x: mx, z: mz });
          const rx = -fz, rz = fx; // right of travel (+x east, +z south, heading atan2(dx,dz))
          const off = e.width / 2 + 4.5;
          const x = mx + rx * off, z = mz + rz * off;
          const root = new THREE.Group();
          root.position.set(x, this.ground(x, z), z);
          root.rotation.y = Math.atan2(-fx, -fz); // face oncoming drivers
          this.box(0.25, 2.6, 0.25, wood, -1.9, 1.3, 0, root);
          this.box(0.25, 2.6, 0.25, wood, 1.9, 1.3, 0, root);
          this.box(4.4, 0.6, 0.6, brick, 0, 0.3, 0, root);
          const panel = new THREE.Mesh(new THREE.PlaneGeometry(4, 1.4), new THREE.MeshStandardMaterial({ map: tex[v.n], emissive: 0xffffff, emissiveMap: tex[v.n], emissiveIntensity: 0.25 }));
          panel.position.set(0, 1.9, 0.14);
          const back = this.box(4.2, 1.6, 0.2, wood, 0, 1.9, 0, root);
          back.castShadow = true;
          root.add(panel);
          this.group.add(root);
        }
      }
    }
  }
}
