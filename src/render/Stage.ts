// Renderer, post-processing, sky, sun, fog, time of day, and the small pool of
// real lights that follow the player.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { TIMES, type TimeId, type TimePreset } from './TimeOfDay';
import { worldUniforms } from './World';

export interface Lamp { hx: number; hy: number; hz: number; gy?: number }

function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uHor: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() },
      uDisk: { value: 1 }, uStars: { value: 0 },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }',
    fragmentShader: `
      varying vec3 vDir; uniform vec3 uTop, uMid, uHor, uGlow, uSun, uSunCol; uniform float uDisk, uStars;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
      float n2(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
        float a=fract(sin(dot(i,vec2(127.1,311.7)))*43758.5), b=fract(sin(dot(i+vec2(1,0),vec2(127.1,311.7)))*43758.5),
        c=fract(sin(dot(i+vec2(0,1),vec2(127.1,311.7)))*43758.5), d=fract(sin(dot(i+vec2(1,1),vec2(127.1,311.7)))*43758.5);
        return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
      void main(){
        vec3 d = normalize(vDir);
        float y = clamp(d.y, -0.2, 1.0);
        vec3 col = mix(uHor, uMid, smoothstep(-0.02, 0.22, y));
        col = mix(col, uTop, smoothstep(0.22, 0.95, y));
        float sd = max(dot(d, normalize(uSun)), 0.0);
        col += uGlow * pow(sd, 6.0) * 0.45 * (1.0 - smoothstep(0.0, 0.6, y)) ;
        col += uGlow * exp(-max(y,0.0)*10.0) * 0.12;
        // soft clouds
        if (y > 0.0) {
          vec2 cp = d.xz / (d.y + 0.15) * 2.0;
          float c = smoothstep(0.55, 0.85, n2(cp*1.3) * 0.65 + n2(cp*3.1) * 0.35);
          col = mix(col, mix(uHor, vec3(1.0), 0.5) * (0.7 + 0.3*uDisk), c * 0.35 * (1.0 - uStars*0.7) * smoothstep(0.02, 0.2, y));
        }
        col += uSunCol * smoothstep(0.9993, 0.9997, sd) * (uDisk > 0.5 ? 6.0 : 1.2);
        col += uSunCol * pow(sd, 120.0) * 0.6;
        vec3 sp = floor(d*420.0);
        col += vec3(step(0.9975, h(sp)) * smoothstep(0.12, 0.5, y) * uStars * 0.8);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private renderPass: RenderPass | null = null;
  private pool: THREE.PointLight[] = [];
  private sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private hemi: THREE.HemisphereLight;
  readonly sun: THREE.DirectionalLight;
  readonly headlight: THREE.SpotLight;
  lowEffects = false;
  private lampList: Lamp[] = [];
  private pixelRatioCap = 1.5;
  time: TimePreset = TIMES.golden;
  private envRT: THREE.WebGLRenderTarget | null = null;
  fogFar = 2200;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.scene.fog = new THREE.FogExp2(0xffffff, 0.001);
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), skyMaterial());
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -95;
    sc.right = sc.top = 95;
    sc.near = 1;
    sc.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);

    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffa24a, 0, 26, 1.6);
      this.scene.add(l);
      this.pool.push(l);
    }
    this.headlight = new THREE.SpotLight(0xfff0d8, 0, 70, 0.55, 0.45, 1.3);
    this.scene.add(this.headlight, this.headlight.target);
    this.setTime('golden');
  }

  /** Apply a time-of-day preset to sky, lights, fog, materials and reflections. */
  setTime(id: TimeId) {
    const t = TIMES[id];
    this.time = t;
    const u = this.sky.material.uniforms;
    u.uTop.value.set(t.skyTop);
    u.uMid.value.set(t.skyMid);
    u.uHor.value.set(t.skyHorizon);
    u.uGlow.value.set(t.horizonGlow);
    u.uSun.value.set(...t.sunDir).normalize();
    u.uSunCol.value.set(t.sunColor);
    u.uDisk.value = t.sunDisk;
    u.uStars.value = t.stars;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.set(t.fog);
    fog.density = t.fogDensity * (this.lowEffects ? 1.35 : 1);
    this.fogFar = Math.min(3000, 2.6 / fog.density);
    this.scene.background = new THREE.Color(t.fog);
    this.hemi.color.set(t.hemiSky);
    this.hemi.groundColor.set(t.hemiGround);
    this.hemi.intensity = t.hemiIntensity;
    this.sun.color.set(t.sunColor);
    this.sun.intensity = t.sunIntensity;
    this.sun.castShadow = t.shadows && !this.lowEffects;
    this.renderer.toneMappingExposure = t.exposure;
    worldUniforms.windowLight.value = t.windowLight;
    worldUniforms.wetness.value = t.wetness;
    if (this.bloom) this.bloom.strength = t.bloom;
    this.buildEnvironment(t);
  }

  /** Reflection environment painted from the preset's sky colours. */
  private buildEnvironment(t: TimePreset) {
    const w = 512, h = 256;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hex(t.skyTop));
    grad.addColorStop(0.38, hex(t.skyMid));
    grad.addColorStop(0.5, hex(t.skyHorizon));
    grad.addColorStop(0.53, hex(t.hemiGround));
    grad.addColorStop(1, '#0a0806');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    if (t.windowLight > 0.5) {
      for (let i = 0; i < 160; i++) {
        g.fillStyle = `rgba(255,${150 + Math.random() * 80},${60 + Math.random() * 60},${0.4 + Math.random() * 0.6})`;
        g.fillRect(Math.random() * w, h * (0.46 + Math.random() * 0.06), 1 + Math.random() * 2, 1 + Math.random() * 2);
      }
    }
    if (t.sunDisk > 0) {
      const sx = ((Math.atan2(t.sunDir[0], -t.sunDir[2]) / (Math.PI * 2)) + 0.5) * w;
      const sy = (0.5 - Math.asin(t.sunDir[1] / Math.hypot(...t.sunDir)) / Math.PI) * h;
      const rg = g.createRadialGradient(sx, sy, 0, sx, sy, 40);
      rg.addColorStop(0, 'rgba(255,240,210,1)');
      rg.addColorStop(1, 'rgba(255,200,140,0)');
      g.fillStyle = rg;
      g.fillRect(sx - 40, sy - 40, 80, 80);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT?.dispose();
    this.envRT = pmrem.fromEquirectangular(tex);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = t.windowLight > 0.5 ? 0.9 : 1.0;
    pmrem.dispose();
    tex.dispose();
  }

  setLamps(lamps: Lamp[]) {
    this.lampList = lamps;
  }

  /**
   * Draw every mesh under `roots` once into a tiny offscreen target, culling and
   * LOD visibility suspended, so all static geometry is uploaded now (and its
   * JavaScript copy can be released) instead of the first time it comes into view.
   */
  warmUp(roots: THREE.Object3D[], camera: THREE.Camera) {
    const touched: { o: THREE.Object3D; visible: boolean; culled: boolean }[] = [];
    for (const r of roots) r.traverse((o) => {
      touched.push({ o, visible: o.visible, culled: o.frustumCulled });
      o.visible = true;
      o.frustumCulled = false;
    });
    const rt = new THREE.WebGLRenderTarget(16, 16);
    const prevTarget = this.renderer.getRenderTarget();
    const shadows = this.renderer.shadowMap.enabled;
    this.renderer.shadowMap.enabled = false;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, camera);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.shadowMap.enabled = shadows;
    rt.dispose();
    for (const t of touched) { t.o.visible = t.visible; t.o.frustumCulled = t.culled; }
  }

  /** Current render scale cap (device pixels per CSS pixel). */
  get pixelCap() {
    return Math.min(window.devicePixelRatio, this.pixelRatioCap);
  }

  /** Adaptive resolution: render at a lower scale when the GPU can't keep up. */
  setPixelCap(cap: number, camera: THREE.PerspectiveCamera) {
    this.pixelRatioCap = cap;
    this.resize(camera);
  }

  setQuality(low: boolean, camera: THREE.Camera) {
    this.lowEffects = low;
    this.pixelRatioCap = low ? 1 : 1.5;
    this.resize(camera as THREE.PerspectiveCamera);
    this.setTime(this.time.id);
    if (low) {
      this.composer = null;
      this.bloom = null;
      this.pool.forEach((l, i) => (l.visible = i < 2));
      return;
    }
    this.pool.forEach((l) => (l.visible = true));
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), this.time.bloom, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, this.pixelRatioCap));
    this.composer.setSize(size.x, size.y);
  }

  resize(camera: THREE.PerspectiveCamera) {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.pixelRatioCap));
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(Math.min(window.devicePixelRatio, this.pixelRatioCap));
      this.composer.setSize(w, h);
    }
  }

  /** Follow the focus point with the sun's shadow box and the street-light pool. */
  updateLights(focus: THREE.Vector3, camera: THREE.Camera) {
    this.sky.position.copy(camera.position);
    const d = this.time.sunDir;
    const len = Math.hypot(...d);
    this.sun.position.set(focus.x + (d[0] / len) * 300, focus.y + (d[1] / len) * 300, focus.z + (d[2] / len) * 300);
    this.sun.target.position.copy(focus);
    const n = this.time.lamps > 0 ? (this.lowEffects ? 2 : this.pool.length) : 0;
    const best: { d: number; l: Lamp }[] = [];
    if (n > 0) {
      for (const l of this.lampList) {
        const dx = l.hx - focus.x, dz = l.hz - focus.z, dy = (l.gy ?? l.hy - 6) - focus.y;
        // Height counts too: the lights in a tunnel below are not the street's.
        const dd = dx * dx + dz * dz + dy * dy * 6;
        if (dd > 140 * 140) continue;
        if (best.length < n) best.push({ d: dd, l });
        else {
          let wi = 0;
          for (let i = 1; i < best.length; i++) if (best[i].d > best[wi].d) wi = i;
          if (dd < best[wi].d) best[wi] = { d: dd, l };
        }
      }
    }
    this.pool.forEach((p, i) => {
      const b = best[i];
      if (!b) { p.intensity = 0; return; }
      p.position.set(b.l.hx, b.l.hy - 0.4, b.l.hz);
      p.intensity = this.time.lamps;
    });
  }

  render(camera: THREE.Camera) {
    this.renderer.info.reset();
    if (this.composer && this.renderPass) {
      this.renderPass.camera = camera;
      this.composer.render();
    } else this.renderer.render(this.scene, camera);
  }
}
