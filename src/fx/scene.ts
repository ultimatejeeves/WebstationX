/**
 * The living backdrop behind every menu: a field of glassy towers in deep blue fog, drifting
 * motes of light and a slow, floating camera, in the spirit of turn-of-the-millennium console
 * system menus. One WebGL canvas for the whole app; it stops rendering entirely while a game
 * runs so the emulator gets the machine to itself.
 */
import * as THREE from 'three';
import { deviceGraphics, onHardwareChange, type GraphicsPreset } from '../core/hardware';

export type SceneMode = 'boot' | 'menu' | 'off';

const GRID = 15;
const SPACING = 1.7;
const MOTES = 700;
const ORBS = 6;
const BASE_ACCENT = '#3aa8ff';

/** Backdrop quality per device preset: pixel-ratio cap, motes drawn, whether the orbs draw, frame-rate cap (0 = display rate). 'high' is the full look. */
const FX_QUALITY: Record<GraphicsPreset['fx'], { dpr: number; motes: number; orbs: boolean; fps: number }> = {
  high: { dpr: 1.5, motes: MOTES, orbs: true, fps: 0 },
  medium: { dpr: 1, motes: 450, orbs: true, fps: 0 },
  low: { dpr: 0.75, motes: 200, orbs: false, fps: 30 },
};

const reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- Shaders ---------- */

const towerVert = /* glsl */ `
  attribute float aSeed;
  attribute float aDelay;
  uniform float uTime;
  uniform float uRise;
  uniform float uPulse;
  varying vec3 vLocal;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vSeed;
  varying float vHeight;
  varying float vWave;

  float easeOutBack(float x) {
    float c1 = 1.70158;
    float c3 = c1 + 1.0;
    return 1.0 + c3 * pow(x - 1.0, 3.0) + c1 * pow(x - 1.0, 2.0);
  }

  void main() {
    vec3 p = position;
    vLocal = p;
    // Instance origin (floor centre) and height straight from the instance matrix.
    vec3 origin = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
    float height = instanceMatrix[1][1];
    float dist = length(origin.xz);
    // Rise from the floor at boot, rippling outward from the centre.
    float r = clamp(uRise * 3.0 - aDelay, 0.0, 1.0);
    float rise = r <= 0.0 ? 0.0 : easeOutBack(r);
    // Slow breathing, plus a ring wave when something is selected.
    float breathe = 1.0 + 0.07 * sin(uTime * 0.35 + aSeed * 6.2831);
    float wave = exp(-pow(dist - uPulse * 14.0, 2.0) * 0.35) * exp(-uPulse * 1.6) * step(0.0001, uPulse);
    vWave = wave;
    p.y *= rise * breathe * (1.0 + wave * 0.25);
    vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
    vWorld = world.xyz;
    vHeight = height * rise;
    vSeed = aSeed;
    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const towerFrag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uAccent;
  uniform vec3 uDeep;
  uniform vec3 uFog;
  uniform float uFogDensity;
  uniform vec3 uCam;
  varying vec3 vLocal;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vSeed;
  varying float vHeight;
  varying float vWave;

  void main() {
    // Face-local coordinates: the two axes that are not the face normal.
    vec3 an = abs(vNormal);
    vec2 uv = an.y > 0.5 ? vLocal.xz : (an.x > 0.5 ? vec2(vLocal.z, vLocal.y) : vec2(vLocal.x, vLocal.y));
    // Unit cube is centred on x/z and spans 0..1 on y.
    vec2 f = vec2(abs(uv.x), an.y > 0.5 ? abs(uv.y) : abs(uv.y - 0.5));
    float edge = smoothstep(0.43, 0.5, max(f.x, f.y));
    vec3 V = normalize(uCam - vWorld);
    float fres = pow(1.0 - abs(dot(normalize(vNormal), V)), 2.2);
    float up = clamp(vWorld.y / max(vHeight, 0.001), 0.0, 1.0);
    // A band of light that climbs each tower now and then.
    float cycle = mod(uTime * (0.18 + vSeed * 0.2) + vSeed * 17.0, 7.0);
    float band = exp(-pow((vWorld.y - (cycle - 1.0) * max(vHeight, 1.0) * 0.5) * 2.4, 2.0)) * step(cycle, 3.0);
    vec3 glass = mix(uDeep, uAccent, 0.18 + up * 0.35);
    vec3 col = glass * (0.35 + fres * 1.1);
    col += uAccent * edge * (0.35 + up * 0.5);
    col += mix(uAccent, vec3(1.0), 0.5) * band * 0.55;
    col += vec3(0.8, 0.95, 1.0) * vWave * 0.6;
    if (an.y > 0.5 && vNormal.y > 0.0) col += uAccent * 0.25 + vec3(0.12);
    float fog = 1.0 - exp(-pow(uFogDensity * length(uCam - vWorld), 2.0));
    // Fade into the sky behind the canvas rather than toward a fixed colour.
    col *= 1.0 - fog;
    float alpha = 0.5 + edge * 0.4 + fres * 0.3;
    gl_FragColor = vec4(col * alpha, 1.0);
  }
`;

const floorVert = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const floorFrag = /* glsl */ `
  uniform vec3 uAccent;
  uniform vec3 uFog;
  uniform float uFogDensity;
  uniform vec3 uCam;
  uniform float uTime;
  uniform float uRise;
  varying vec3 vWorld;
  void main() {
    vec2 g = abs(fract(vWorld.xz / ${SPACING.toFixed(2)} + 0.5) - 0.5);
    float line = smoothstep(0.035, 0.0, min(g.x, g.y));
    float d = length(vWorld.xz);
    float pool = exp(-d * d * 0.012);
    float sweep = 0.5 + 0.5 * sin(d * 0.9 - uTime * 0.6);
    vec3 col = uAccent * (line * (0.1 + 0.08 * sweep) + pool * 0.08) * uRise;
    float fog = 1.0 - exp(-pow(uFogDensity * length(uCam - vWorld), 2.0));
    gl_FragColor = vec4(col, (1.0 - fog) * (0.55 + pool * 0.35));
  }
`;

const moteVert = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;
  uniform float uTime;
  uniform float uPixel;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    float t = uTime * (0.08 + aSeed * 0.12);
    p.y = mod(p.y + t * 3.0, 14.0) - 1.0;
    p.x += sin(t * 2.0 + aSeed * 40.0) * 0.8;
    p.z += cos(t * 1.7 + aSeed * 30.0) * 0.8;
    vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixel * (18.0 / -mv.z);
    float twinkle = 0.55 + 0.45 * sin(uTime * (1.5 + aSeed * 3.0) + aSeed * 50.0);
    float fadeY = smoothstep(-1.0, 1.0, p.y) * (1.0 - smoothstep(10.0, 13.0, p.y));
    vAlpha = twinkle * fadeY * clamp(1.0 - (-mv.z) / 40.0, 0.0, 1.0);
  }
`;

const moteFrag = /* glsl */ `
  uniform vec3 uAccent;
  uniform float uRise;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = exp(-d * d * 22.0) * vAlpha * uRise;
    gl_FragColor = vec4(mix(uAccent, vec3(1.0), 0.6) * a, 1.0);
  }
`;

const orbVert = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uPixel;
  varying float vSeed;
  void main() {
    float t = uTime * 0.06 + aSeed * 6.2831;
    vec3 p = vec3(cos(t) * (6.0 + aSeed * 5.0), 2.5 + sin(t * 1.3 + aSeed) * 1.8, sin(t) * (5.0 + aSeed * 4.0) - 4.0);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (90.0 + aSeed * 110.0) * uPixel * (10.0 / -mv.z);
    vSeed = aSeed;
  }
`;

const orbFrag = /* glsl */ `
  uniform vec3 uAccent;
  uniform float uRise;
  uniform float uTime;
  varying float vSeed;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float core = exp(-d * d * 18.0);
    float halo = exp(-d * d * 3.0) * 0.35;
    float pulse = 0.75 + 0.25 * sin(uTime * 0.8 + vSeed * 20.0);
    vec3 col = mix(uAccent, vec3(1.0), core) * (core + halo) * pulse * 0.55 * uRise;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ---------- Scene ---------- */

class TowerScene {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.1, 120);
  private clock = new THREE.Clock(false);
  private raf = 0;
  private mode: SceneMode = 'off';
  private canvas: HTMLCanvasElement | null = null;
  private time = 0;
  private rise = 0;
  private riseTarget = 0;
  private pulseAt = -1;
  private nudge = 0;
  private nudgeVel = 0;
  private accent = new THREE.Color('#3aa8ff');
  private accentTarget = new THREE.Color('#3aa8ff');
  private readonly uniforms = {
    uTime: { value: 0 },
    uRise: { value: 0 },
    uPulse: { value: 0 },
    uAccent: { value: new THREE.Color('#3aa8ff') },
    uDeep: { value: new THREE.Color('#0a1d4a') },
    uFog: { value: new THREE.Color('#02050f') },
    uFogDensity: { value: 0.052 },
    uCam: { value: new THREE.Vector3() },
    uPixel: { value: 1 },
  };
  private failed = false;
  private motePoints: THREE.Points | null = null;
  private orbPoints: THREE.Points | null = null;
  private lastRender = 0;
  private fpsCap = 0;

  /** Attach the canvas behind everything in `root`. Safe to call once. */
  mount(root: HTMLElement) {
    if (this.canvas || this.failed) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'fx-scene';
    root.prepend(canvas);
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      // No WebGL: the CSS gradient behind the canvas still gives a calm blue backdrop.
      this.failed = true;
      canvas.remove();
      return;
    }
    this.canvas = canvas;
    this.renderer.setClearColor(0x000000, 0);
    this.build();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Detection finishing (or the user picking a preset) re-tunes the backdrop live.
    onHardwareChange(() => this.resize());
    document.addEventListener('visibilitychange', () => this.kick());
  }

  private build() {
    const u = this.uniforms;
    // Towers: one instanced unit cube with its base on the floor.
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const count = GRID * GRID;
    const seeds = new Float32Array(count);
    const delays = new Float32Array(count);
    const mat = new THREE.ShaderMaterial({
      vertexShader: towerVert,
      fragmentShader: towerFrag,
      uniforms: u,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const towers = new THREE.InstancedMesh(box, mat, count);
    const m = new THREE.Matrix4();
    let rnd = mulberry32(1999);
    let i = 0;
    const half = (GRID - 1) / 2;
    for (let gx = 0; gx < GRID; gx++) {
      for (let gz = 0; gz < GRID; gz++) {
        const x = (gx - half) * SPACING + (rnd() - 0.5) * 0.3;
        const z = (gz - half) * SPACING - 6 + (rnd() - 0.5) * 0.3;
        // Leave an open avenue down the middle so the camera looks across the field.
        const avenue = Math.abs(x) < SPACING * 1.2 && z > -9;
        const hgt = avenue ? 0.08 + rnd() * 0.15 : 0.4 + Math.pow(rnd(), 2.6) * 7.5;
        const w = 0.55 + rnd() * 0.35;
        m.makeScale(w, hgt, w).setPosition(x, 0, z);
        towers.setMatrixAt(i, m);
        seeds[i] = rnd();
        delays[i] = Math.hypot(x, z + 6) * 0.09 + rnd() * 0.25;
        i++;
      }
    }
    box.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    box.setAttribute('aDelay', new THREE.InstancedBufferAttribute(delays, 1));
    towers.frustumCulled = false;
    this.scene.add(towers);

    // Floor grid that fades into the fog.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.ShaderMaterial({ vertexShader: floorVert, fragmentShader: floorFrag, uniforms: u, transparent: true, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.001;
    floor.renderOrder = -1;
    this.scene.add(floor);

    // Motes of light drifting upward.
    rnd = mulberry32(2001);
    const mp = new Float32Array(MOTES * 3);
    const ms = new Float32Array(MOTES);
    const msz = new Float32Array(MOTES);
    for (let k = 0; k < MOTES; k++) {
      mp[k * 3] = (rnd() - 0.5) * 36;
      mp[k * 3 + 1] = rnd() * 14;
      mp[k * 3 + 2] = (rnd() - 0.5) * 30 - 6;
      ms[k] = rnd();
      msz[k] = 0.6 + Math.pow(rnd(), 3) * 3.5;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    mg.setAttribute('aSeed', new THREE.BufferAttribute(ms, 1));
    mg.setAttribute('aSize', new THREE.BufferAttribute(msz, 1));
    const motes = new THREE.Points(
      mg,
      new THREE.ShaderMaterial({ vertexShader: moteVert, fragmentShader: moteFrag, uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    motes.frustumCulled = false;
    this.motePoints = motes;
    this.scene.add(motes);

    // A few big soft orbs wheeling slowly overhead.
    const og = new THREE.BufferGeometry();
    const os = new Float32Array(ORBS);
    for (let k = 0; k < ORBS; k++) os[k] = k / ORBS + rnd() * 0.1;
    og.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORBS * 3), 3));
    og.setAttribute('aSeed', new THREE.BufferAttribute(os, 1));
    const orbs = new THREE.Points(
      og,
      new THREE.ShaderMaterial({ vertexShader: orbVert, fragmentShader: orbFrag, uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    orbs.frustumCulled = false;
    this.orbPoints = orbs;
    this.scene.add(orbs);
  }

  private resize() {
    if (!this.renderer || !this.canvas) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const q = FX_QUALITY[deviceGraphics().preset.fx];
    this.motePoints?.geometry.setDrawRange(0, q.motes);
    if (this.orbPoints) this.orbPoints.visible = q.orbs;
    this.fpsCap = q.fps;
    const pr = Math.min(window.devicePixelRatio || 1, q.dpr);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.uniforms.uPixel.value = pr * (h / 900);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ---------- Public API ---------- */

  setMode(mode: SceneMode) {
    if (this.mode === mode) return;
    const prev = this.mode;
    this.mode = mode;
    document.body.dataset.scene = mode;
    if (mode === 'boot') {
      this.rise = 0;
      this.riseTarget = 1;
    } else if (mode === 'menu') {
      // Coming back from a game: rise again, a little faster.
      if (prev === 'off') this.rise = Math.min(this.rise, 0.25);
      this.riseTarget = 1;
    }
    this.kick();
  }

  /** Tint the world toward a game's colour. */
  setAccent(hex: string | null | undefined) {
    // Only a hint of the game's colour: the world stays console-menu blue.
    this.accentTarget.set(BASE_ACCENT);
    if (hex && /^#[0-9a-f]{6}$/i.test(hex)) this.accentTarget.lerp(new THREE.Color(hex), 0.32);
  }

  /** A ring of light rolling out from the centre. */
  pulse() {
    this.pulseAt = this.time;
  }

  /** Lean the camera a little toward a direction (carousel moves). */
  lean(dir: -1 | 1) {
    this.nudgeVel += dir * 0.9;
  }

  private kick() {
    const active = this.renderer && this.mode !== 'off' && !document.hidden;
    if (this.canvas) this.canvas.classList.toggle('fx-hidden', this.mode === 'off');
    if (active && !this.raf) {
      this.clock.start();
      this.raf = requestAnimationFrame(this.frame);
    } else if (!active && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.clock.stop();
    }
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    const cap = this.fpsCap;
    if (cap) {
      const now = performance.now();
      if (now - this.lastRender < 1000 / cap - 3) return;
      this.lastRender = now;
    }
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const speed = reducedMotion ? 0.25 : 1;
    this.time += dt * speed;
    const u = this.uniforms;
    u.uTime.value = this.time;

    // Boot rise takes ~3.5 s; returning from a game ~1.5 s.
    const riseRate = this.mode === 'boot' ? 0.3 : 0.7;
    this.rise = Math.min(this.riseTarget, this.rise + dt * riseRate);
    u.uRise.value = this.rise;
    u.uPulse.value = this.pulseAt >= 0 ? this.time - this.pulseAt : 0;
    if (u.uPulse.value > 4) this.pulseAt = -1;

    this.accent.lerp(this.accentTarget, 1 - Math.exp(-dt * 1.8));
    u.uAccent.value.copy(this.accent);

    // Spring for the carousel lean.
    this.nudgeVel += -this.nudge * 9 * dt;
    this.nudgeVel *= Math.exp(-dt * 4);
    this.nudge += this.nudgeVel * dt;

    const t = this.time;
    const drift = reducedMotion ? 0 : 1;
    const cam = this.camera;
    const boot = 1 - this.rise;
    cam.position.set(Math.sin(t * 0.045) * 3.2 * drift + this.nudge * 1.4, 2.1 + Math.sin(t * 0.07) * 0.45 * drift + boot * 1.5, 10.5 - boot * 3);
    cam.lookAt(Math.sin(t * 0.03) * 1.2 * drift + this.nudge * 0.6, 1.9 + boot * 0.8, -6);
    u.uCam.value.copy(cam.position);

    this.renderer!.render(this.scene, cam);
  };
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const scene = new TowerScene();
