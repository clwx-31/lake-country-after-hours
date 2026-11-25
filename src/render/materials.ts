// Procedural materials: wet asphalt, ground, building facades with lit windows, water.
import * as THREE from 'three';

const NOISE = /* glsl */ `
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = h21(i), b = h21(i+vec2(1,0)), c = h21(i+vec2(0,1)), d = h21(i+vec2(1,1));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<4;i++){ s+=a*vnoise(p); p*=2.03; a*=0.5; } return s; }
`;

function worldPosHook(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec4 wp4 = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        wp4 = instanceMatrix * wp4;
      #endif
      vWPos = (modelMatrix * wp4).xyz;`,
    );
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\n${NOISE}`);
}

/** Asphalt that is wet (puddles, mirror-like) or dry depending on `wetness` 0..1. */
export function wetAsphalt(lowEffects: boolean, wetness: { value: number } = { value: 1 }) {
  const m = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.5, metalness: 0.0, vertexColors: true });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uWet = wetness;
    worldPosHook(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWet;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float grain = vnoise(vWPos.xz*3.1)*0.5 + vnoise(vWPos.xz*0.21)*0.5;
        float puddle = smoothstep(0.58, 0.72, fbm(vWPos.xz*0.045 + 3.7)) * uWet;
        diffuseColor.rgb *= (0.78 + grain*0.38) * mix(1.25, 1.0, uWet);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035,0.04,0.05), puddle*0.75);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.82, mix(${lowEffects ? '0.42' : '0.26'}, 0.04, puddle), uWet) + grain*0.08;`,
      );
  };
  return m;
}

export function groundMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x2c3a22, roughness: 0.95, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    worldPosHook(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      float n = fbm(vWPos.xz*0.08);
      float leaves = smoothstep(0.55, 0.8, vnoise(vWPos.xz*0.9));
      vec3 grass = mix(vec3(0.10,0.15,0.07), vec3(0.17,0.19,0.09), n);
      grass = mix(grass, vec3(0.32,0.17,0.06), leaves*0.55);
      diffuseColor.rgb = grass;`,
    );
  };
  return m;
}

export function concreteMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.62, metalness: 0, vertexColors: true });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  m.onBeforeCompile = (shader) => {
    worldPosHook(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float slab = step(0.94, fract(vWPos.x*0.66)) + step(0.94, fract(vWPos.z*0.66));
        diffuseColor.rgb *= (0.85 + vnoise(vWPos.xz*2.0)*0.25) * (1.0 - clamp(slab,0.0,1.0)*0.25);`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = 0.45 + vnoise(vWPos.xz*0.5)*0.3;`);
  };
  return m;
}

/**
 * Facade shader. attribute aFacade = (u along wall m, v height m, wall height m),
 * aStyle = 0 house siding, 1 brick institutional, 2 downtown storefront, 3 shed, 4 generic, 5 roof.
 */
export function buildingMaterial(windowLight: { value: number }) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uWindowLight = windowLight;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 aFacade; attribute vec2 aStyle;
        varying vec3 vFacade; varying vec2 vStyle;`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = aFacade; vStyle = aStyle;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uWindowLight;
        varying vec3 vFacade; varying vec2 vStyle;
        float bh(vec2 p){ p = fract(p*vec2(233.34, 851.73)); p += dot(p, p+23.45); return fract(p.x*p.y); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float style = vStyle.x; float seed = vStyle.y;
        float u = vFacade.x, v = vFacade.y, top = vFacade.z;
        float winMask = 0.0; float lit = 0.0; float store = 0.0;
        if (style < 4.5) {
          float colW = style < 0.5 ? 3.4 : (style < 1.5 ? 2.8 : (style < 2.5 ? 3.0 : 4.0));
          float floorH = style < 2.5 && style > 1.5 ? 3.5 : 3.0;
          vec2 cell = vec2(floor(u/colW), floor(v/floorH));
          vec2 f = vec2(fract(u/colW), fract(v/floorH));
          float r = bh(cell + seed*17.0);
          bool ground = v < floorH;
          if (style > 1.5 && style < 2.5 && ground) {
            // Storefront: big glass at street level.
            winMask = step(0.07, f.x)*step(f.x, 0.93)*step(0.08, f.y)*step(f.y, 0.78);
            lit = step(0.25, r);
            store = 1.0;
          } else if (style < 2.5 || style > 3.5) {
            float wx = style < 0.5 ? 0.3 : 0.24;
            winMask = step(wx, f.x)*step(f.x, 1.0-wx)*step(0.32, f.y)*step(f.y, 0.82);
            winMask *= step(0.6, v) * step(v, top-0.5);
            if (style < 0.5) winMask *= step(0.35, bh(cell*1.7+seed));
            float litChance = style < 0.5 ? 0.55 : (style < 1.5 ? 0.78 : (style < 2.5 ? 0.6 : 0.82));
            lit = step(litChance, r);
          }
          // Wall texture: siding lines for houses, brick courses for masonry.
          if (style < 0.5) diffuseColor.rgb *= 0.88 + 0.12*step(0.18, fract(v*5.0));
          else if (style < 2.5) {
            float row = floor(v*13.0);
            float bx = fract(u*4.2 + mod(row,2.0)*0.5);
            float mortar = step(0.9, fract(v*13.0)) + step(0.92, bx);
            diffuseColor.rgb *= (0.86 + bh(vec2(floor(u*4.2+mod(row,2.0)*0.5), row))*0.22) * (1.0 - clamp(mortar,0.0,1.0)*0.35);
          }
          if (style < 0.5 || (style > 1.5 && style < 2.5)) {
            // Cornice / trim line at the top of the wall.
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75,0.72,0.66), step(top-0.35, v)*0.6);
          }
        }
        vec3 glass = vec3(0.05,0.07,0.09);
        diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec3 warm = mix(vec3(1.0,0.62,0.3), vec3(1.0,0.82,0.55), bh(vec2(seed, floor(u))));
        float glow = winMask * lit * uWindowLight * (store > 0.5 ? 0.7 : 0.8);
        totalEmissiveRadiance += warm * glow * (0.55 + 0.45*bh(vec2(floor(u/3.0), floor(v/3.0))+seed));`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.15, winMask);');
  };
  return m;
}

export function waterMaterial(time: { value: number }) {
  const m = new THREE.MeshStandardMaterial({ color: 0x0b1820, roughness: 0.14, metalness: 0.1, transparent: false });
  // Lakes reflect the sky, but at half strength so they read as deep water, not ice.
  m.envMapIntensity = 0.5;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    worldPosHook(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float ripple = fbm(vWPos.xz*0.35 + vec2(uTime*0.05, uTime*0.12));
        diffuseColor.rgb = mix(vec3(0.015,0.05,0.085), vec3(0.035,0.10,0.15), ripple);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        float e = 0.6;
        vec2 q = vWPos.xz*0.5 + vec2(uTime*0.07, uTime*0.18);
        float n0 = fbm(q), nx = fbm(q+vec2(e,0.0)), nz = fbm(q+vec2(0.0,e));
        vec3 pert = vec3((n0-nx)*0.6, 0.0, (n0-nz)*0.6);
        normal = normalize(normal + (viewMatrix*vec4(pert,0.0)).xyz);`,
      );
  };
  return m;
}

/** Radial glow texture for lamp pools, porch lights, and light sprites. */
export function glowTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Broken vertical streak used for wet-road reflections of lamps. */
export function streakTexture() {
  const w = 64, h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const breaks: number[] = [];
  for (let y = 0; y < h; y++) breaks.push(rnd() < 0.18 ? 0.15 : 1);
  for (let y = 0; y < h; y++) {
    const fy = y / h;
    const along = Math.pow(1 - fy, 1.4) * breaks[y] * (0.7 + 0.3 * Math.sin(y * 0.9));
    for (let x = 0; x < w; x++) {
      const fx = (x - w / 2) / (w / 2);
      const wid = 0.25 + fy * 0.7;
      const a = Math.max(0, 1 - Math.abs(fx) / wid) ** 2 * along;
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Night sky dome: deep blue overhead, warm city glow at the horizon, faint stars. */
export function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uMoonDir: { value: new THREE.Vector3(-0.4, 0.55, -0.7).normalize() } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }`,
    fragmentShader: `
      varying vec3 vDir; uniform vec3 uMoonDir;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
      void main(){
        float y = clamp(vDir.y, -0.2, 1.0);
        vec3 top = vec3(0.025,0.04,0.10);
        vec3 mid = vec3(0.07,0.10,0.21);
        vec3 hor = vec3(0.30,0.20,0.20);
        vec3 col = mix(hor, mid, smoothstep(-0.02, 0.18, y));
        col = mix(col, top, smoothstep(0.18, 0.9, y));
        // warm amber city glow near the horizon
        col += vec3(0.20,0.10,0.03) * exp(-max(y,0.0)*14.0);
        vec3 sd = floor(vDir*420.0);
        float star = step(0.9975, h(sd)) * smoothstep(0.12, 0.5, y);
        col += vec3(star*0.8);
        float md = max(dot(normalize(vDir), uMoonDir), 0.0);
        col += vec3(0.9,0.92,1.0) * smoothstep(0.9993, 0.9997, md);
        col += vec3(0.10,0.12,0.18) * pow(md, 60.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}
