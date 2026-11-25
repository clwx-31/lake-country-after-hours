// Police helicopter: low-poly airframe, spinning rotors, a searchlight cone and a
// real spotlight that tracks its target. Purely visual; the flight model lives
// in Pursuit.
import * as THREE from 'three';

export class HelicopterModel {
  readonly root = new THREE.Group();
  private rotor = new THREE.Group();
  private tailRotor = new THREE.Group();
  private beam: THREE.Mesh;
  readonly light: THREE.SpotLight;
  private strobe: THREE.MeshStandardMaterial;

  constructor() {
    const body = new THREE.MeshStandardMaterial({ color: 0x182334, roughness: 0.45, metalness: 0.5 });
    const white = new THREE.MeshStandardMaterial({ color: 0xe6e6e0, roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0b1420, roughness: 0.1, metalness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.7 });
    const cabin = new THREE.Mesh(new THREE.SphereGeometry(1.5, 14, 10), body);
    cabin.scale.set(1, 0.85, 1.6);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(1.05, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), glass);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.1, 1.55);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.02, 0.35, 2.6), white);
    stripe.position.set(0, -0.15, -0.1);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.4, 4.6, 8).rotateX(Math.PI / 2), body);
    boom.position.set(0, 0.25, -3.6);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 0.8), body);
    fin.position.set(0, 0.85, -5.7);
    for (const s of [-1, 1]) {
      const skid = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.6), dark);
      skid.position.set(s * 1.05, -1.55, 0);
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), dark);
      strut.position.set(s * 1.0, -1.25, 0.6);
      const strut2 = strut.clone();
      strut2.position.z = -0.8;
      this.root.add(skid, strut, strut2);
    }
    // Rotors: two long thin blades each.
    const blade = new THREE.BoxGeometry(0.28, 0.05, 11);
    for (const a of [0, Math.PI / 2]) {
      const b = new THREE.Mesh(blade, dark);
      b.rotation.y = a;
      this.rotor.add(b);
    }
    this.rotor.position.y = 1.55;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.5, 8), dark);
    hub.position.y = 1.3;
    const tb = new THREE.BoxGeometry(0.05, 1.8, 0.16);
    this.tailRotor.add(new THREE.Mesh(tb, dark), new THREE.Mesh(tb, dark).rotateX(Math.PI / 2));
    this.tailRotor.position.set(0.18, 0.95, -5.8);
    this.strobe = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2030, emissiveIntensity: 0 });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), this.strobe);
    beacon.position.set(0, -1.3, 0.2);
    // Fictional unit marking on both doors.
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#e6e6e0'; g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#182334'; g.font = 'bold 30px sans-serif'; g.textAlign = 'center';
    g.fillText('LAKE COUNTRY POLICE', 128, 42);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    for (const s of [-1, 1]) {
      const label = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.32), new THREE.MeshBasicMaterial({ map: tex }));
      label.position.set(s * 1.52, -0.15, -0.1);
      label.rotation.y = (s * Math.PI) / 2;
      this.root.add(label);
    }
    this.root.add(cabin, nose, stripe, boom, fin, this.rotor, hub, this.tailRotor, beacon);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
    // Searchlight: a soft additive cone (visual) plus a real spotlight.
    const coneGeo = new THREE.ConeGeometry(1, 1, 20, 1, true).translate(0, -0.5, 0);
    this.beam = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.beam.renderOrder = 4;
    this.light = new THREE.SpotLight(0xfff3d8, 0, 160, 0.16, 0.5, 1.2);
    this.light.position.set(0, -1.4, 1.2);
    this.root.add(this.light, this.light.target);
  }

  get beamMesh() {
    return this.beam;
  }

  /** Pose the airframe and aim the searchlight at the target point. */
  update(t: number, x: number, y: number, z: number, heading: number, bank: number, pitch: number, target: THREE.Vector3, night: number, sees: boolean) {
    this.root.position.set(x, y, z);
    this.root.rotation.set(pitch, heading, bank, 'YXZ');
    this.rotor.rotation.y = t * 38;
    this.tailRotor.rotation.x = t * 60;
    this.strobe.emissiveIntensity = Math.floor(t * 1.6) % 2 ? 6 : 0;
    this.root.updateMatrixWorld(true);
    this.light.target.position.copy(this.root.worldToLocal(target.clone()));
    this.light.intensity = sees ? 900 * night + 120 : 0;
    // Beam from the light to the ground target, in world space.
    const from = this.light.getWorldPosition(new THREE.Vector3());
    const len = from.distanceTo(target);
    this.beam.position.copy(from);
    this.beam.scale.set(len * 0.09, len, len * 0.09);
    this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), target.clone().sub(from).normalize());
    // The visible beam is a night thing; in daylight only the spot on the car shows.
    (this.beam.material as THREE.MeshBasicMaterial).opacity = sees && night > 0.5 ? 0.09 : 0;
  }
}
