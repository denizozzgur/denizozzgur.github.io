// Jellify Anything: the jelly stage. Wires the real Squeeze Out! engine (engine/src = byte-exact copies
// of the game's src/, see tools/jellify/sync-engine.mjs): XPBD soft body (physics.js), the WebGL2 gel
// renderer with the photo-jelly material (render.js), mesh.js, segment.js, the procedural squish
// sounds (audio.js) and the juice / slap effects (effects.js), on a 9:16 stage that is also what a
// recorded clip shows.
//
// Layers inside .jf-scene (which shakes on hard hits): canvas.bg (backdrop + tabletop, painted here so
// the clip and the page look the same), canvas.gl (jellies; ends at the tabletop lip), canvas.fx
// (juice, splats, slap rings, hand prints). World units = CSS px of the stage; y down.
import { JellyWorld } from './engine/src/physics.js';
import { JellyRenderer } from './engine/src/render.js';
import { buildMesh } from './engine/src/mesh.js';
import { JellyAudio } from './engine/src/audio.js';
import { JellyEffects } from './engine/src/effects.js';
import { SAMPLES, drawSample } from './engine/src/samples.js';
import { imageToCutout, canvasToCutout, PAD } from './engine/src/segment.js';
import { materialFor, guessMaterialFromColor } from './engine/src/materials.js';
import { JellyInput } from './engine/src/input.js';
import { setCutoutPoint } from './engine/native/web/platform.js';

export { SAMPLES };

const FLOOR_FRAC = 0.17;          // tabletop band, share of the stage height
const MAX_DPR = 2;
const SAMPLE_SIZE = 900;          // samples are painted big enough for a 1080 px wide clip
const SAMPLE_MESH = { targetVertices: 300, dilate: 11 };
const PHOTO_SIZE = 1024;
const PHOTO_MESH = { targetVertices: 400, dilate: 12 };
const QUIET_EVENT = 0.06;
const SPLASH_EVENT = 0.25;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Paints the backdrop + tabletop (same look as the game's Free mode). */
export function paintBackdrop(g, W, H, floorY) {
  const lin = g.createLinearGradient(0, 0, 0, H);
  lin.addColorStop(0, '#fff7f0'); lin.addColorStop(0.62, '#fde8dc'); lin.addColorStop(1, '#f9d7c8');
  g.fillStyle = lin; g.fillRect(0, 0, W, H);
  const blob = (x, y, r, rgb, a) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${rgb},${a})`); rg.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = rg; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  };
  const m = Math.max(W, H);
  blob(W * 0.1, H * 0.16, m * 0.34, '255,190,210', 0.55);
  blob(W * 0.9, H * 0.24, m * 0.32, '190,234,204', 0.55);
  blob(W * 0.72, H * 0.78, m * 0.3, '255,214,170', 0.45);
  g.save(); g.translate(W / 2, H * 0.36); g.scale(1, 0.62); blob(0, 0, W * 0.75, '255,255,255', 0.9); g.restore();
  // tabletop
  const fh = H - floorY;
  const top = g.createLinearGradient(0, floorY, 0, H);
  top.addColorStop(0, '#f6cdb8'); top.addColorStop(1, '#e7a48c');
  g.fillStyle = top; g.fillRect(0, floorY, W, fh);
  const sheen = g.createRadialGradient(W / 2, floorY, 0, W / 2, floorY, W * 0.6);
  sheen.addColorStop(0, 'rgba(255,236,224,0.55)'); sheen.addColorStop(1, 'rgba(255,236,224,0)');
  g.fillStyle = sheen; g.fillRect(0, floorY, W, fh);
  const lipShade = g.createLinearGradient(0, floorY + 3, 0, floorY + 18);
  lipShade.addColorStop(0, 'rgba(122,52,34,0.2)'); lipShade.addColorStop(1, 'rgba(122,52,34,0)');
  g.fillStyle = lipShade; g.fillRect(0, floorY + 3, W, 15);
  g.fillStyle = '#fff4ec'; g.fillRect(0, floorY, W, 3);
  // vignette
  g.save(); g.translate(W / 2, H * 0.4); g.scale(1.25, 1);
  const v = g.createRadialGradient(0, 0, H * 0.58 * 0.8, 0, 0, H * 0.8);
  v.addColorStop(0, 'rgba(110,50,34,0)'); v.addColorStop(1, 'rgba(110,50,34,0.17)');
  g.fillStyle = v; g.fillRect(-W, -H, W * 3, H * 3); g.restore();
}

/**
 * The engine's JellyInput assumes the stage sits at the viewport origin (clientX/Y = world coords).
 * Here the stage is a box in a scrolling page, so every event is shifted into stage coordinates.
 */
class StageInput extends JellyInput {
  _local(e) {
    const r = this.stage.getBoundingClientRect();
    const map = (ev) => new Proxy(ev, {
      get(t, k) {
        if (k === 'clientX') return t.clientX - r.left;
        if (k === 'clientY') return t.clientY - r.top;
        if (k === 'getCoalescedEvents') return () => (t.getCoalescedEvents ? t.getCoalescedEvents().map(map) : []);
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    return map(e);
  }
  _down(e) { super._down(this._local(e)); }
  _move(e) { super._move(this._local(e)); }
  _up(e, cancelled) { super._up(this._local(e), cancelled); }
  _wheel(e) { super._wheel(this._local(e)); }
}

export class JellyStage {
  /**
   * @param {HTMLElement} el  .jf-stage (contains .jf-scene with canvas.bg, canvas.gl, canvas.fx)
   */
  constructor(el) {
    this.el = el;
    this.scene = el.querySelector('.jf-scene');
    this.bg = el.querySelector('canvas.bg');
    this.glCanvas = el.querySelector('canvas.gl');
    this.fxCanvas = el.querySelector('canvas.fx');
    this.renderer = new JellyRenderer(this.glCanvas); // throws without WebGL2
    this.world = new JellyWorld({ width: 300, height: 400 });
    this.world.autoSleep = true;
    this.audio = new JellyAudio();
    this.effects = new JellyEffects(this.fxCanvas);
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.hero = null;            // the jelly body on stage
    this.spec = null;            // { cutout, mesh, material, kind, id }
    this.cache = new Map();      // sample id → spec
    this.clock = 0;
    this.shakeAmp = 0;
    this.shake = { x: 0, y: 0 };
    this.scale = 0;              // render scale override (recording); 0 = device pixel ratio
    this.lastInput = -1e9;       // performance.now() of the last user touch on the stage
    this.onFrame = null;         // (stage) → void, after every rendered frame (the recorder)
    this.onInteract = null;
    this.visible = true;
    this.raf = 0;
    this.last = 0;
    this._frame = (t) => this.frame(t);

    this.input = new StageInput(el, this.world, {
      interact: () => { this.lastInput = performance.now(); this.onInteract?.(); this.wake(); },
      grab: (body) => this.audio.grab({ pan: this.pan(body.center().x), material: body.material }),
      release: (body, speed) => this.audio.release({ speed, pan: this.pan(body.center().x), material: body.material }),
      slap: (result, dx, dy, kind) => this.slapFx(result, dx, dy, kind),
      pinchStart: () => {}, pinch: () => {}, pinchEnd: () => {},
      wheel: null,
    });

    for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
      window.addEventListener(type, () => this.audio.unlock(), true);
    }
    new ResizeObserver(() => this.resize()).observe(el);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((es) => { this.visible = es.some((e) => e.isIntersecting); this.wake(); }).observe(el);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.audio.hold?.('hidden'); else { this.audio.unhold?.('hidden'); this.wake(); }
    });
    this.resize();
    this.wake();
  }

  get W() { return this.view.W; }
  get H() { return this.view.H; }
  get floorY() { return this.view.floorY; }

  measure() {
    const W = Math.max(1, this.el.clientWidth), H = Math.max(1, this.el.clientHeight);
    return { W, H, floorY: Math.round(H * (1 - FLOOR_FRAC)) };
  }

  /** Backing-store scale of the canvases (device pixels, or the clip's 1080/W while recording). */
  get pixelScale() { return this.scale || Math.min(MAX_DPR, window.devicePixelRatio || 1); }

  resize() {
    const prev = this.view;
    const v = (this.view = this.measure());
    const k = this.pixelScale;
    this.world.resize(v.W, v.floorY);
    this.renderer.resize(v.W, v.floorY, k);
    this.effects.resize(v.W, v.H, k);
    const bw = Math.round(v.W * k), bh = Math.round(v.H * k);
    if (this.bg.width !== bw || this.bg.height !== bh || this._bgK !== k) {
      this.bg.width = bw; this.bg.height = bh; this._bgK = k;
      const g = this.bg.getContext('2d');
      g.setTransform(k, 0, 0, k, 0, 0);
      paintBackdrop(g, v.W, v.H, v.floorY);
    }
    // The stage changed size for real (rotation, desktop resize): keep the hero the same share of it.
    if (this.hero && prev && Math.abs(prev.W / v.W - 1) > 0.05) this.drop({ keepMotion: false });
    this.wake();
  }

  /** Render at a fixed scale (recording) or back at the device pixel ratio (0). */
  setPixelScale(k) { this.scale = k || 0; this._bgK = -1; this.resize(); }

  pan(x) { return clamp((x / this.W) * 2 - 1, -1, 1); }

  // --- jellies ---------------------------------------------------------------------------------

  sampleSpec(id) {
    let spec = this.cache.get(id);
    if (!spec) {
      const s = SAMPLES.find((x) => x.id === id) || SAMPLES[0];
      const cutout = canvasToCutout(drawSample(s.id, SAMPLE_SIZE), { maxSize: SAMPLE_SIZE });
      const mesh = buildMesh(cutout.alpha, cutout.width, cutout.height, SAMPLE_MESH);
      spec = { kind: 'sample', id: s.id, label: s.label, cutout, mesh, material: materialFor(s.material) };
      this.cache.set(id, spec);
    }
    return spec;
  }

  /**
   * Photo (File/Blob/URL) → cutout → spec. Runs on this device only.
   * opts: { point: {x, y} 0..1 to cut out the object under that spot, onProgress(label, fraction) }
   */
  async photoSpec(source, { point = null, onProgress } = {}) {
    setCutoutPoint(point);
    try {
      const cutout = await imageToCutout(source, { maxSize: PHOTO_SIZE, onProgress });
      const mesh = buildMesh(cutout.alpha, cutout.width, cutout.height, PHOTO_MESH);
      return { kind: 'photo', id: 'photo', label: 'Your photo', cutout, mesh, material: guessMaterialFromColor(...cutout.avgColor) };
    } finally {
      setCutoutPoint(null);
    }
  }

  /** Put `spec` on stage: the old jelly pops, the new one drops in from the top. */
  show(spec) {
    if (this.hero) this.removeHero(true);
    this.spec = spec;
    this.drop();
  }

  heroScale(spec = this.spec) {
    const { W, floorY } = this.view;
    const c = spec.cutout;
    const objW = Math.max(1, c.width - 2 * PAD), objH = Math.max(1, c.height - 2 * PAD);
    // Longest side ≈ 64% of the stage width, but never taller than ~60% of the space above the table.
    return Math.min((0.64 * W) / Math.max(objW, objH), (0.6 * floorY) / objH, (0.86 * W) / objW);
  }

  /** (Re)drop the current jelly from above the stage. */
  drop({ vy = 260, keepMotion = true } = {}) {
    if (!this.spec) return null;
    if (this.hero) this.removeHero(false);
    const { W } = this.view;
    const spec = this.spec;
    const scale = this.heroScale(spec);
    const half = (Math.max(spec.cutout.width, spec.cutout.height) * scale) / 2;
    const body = this.world.addBody(spec.mesh, {
      x: W / 2 + rand(-0.05, 0.05) * W,
      y: -half * 0.35,
      scale, material: spec.material,
      vx: keepMotion ? rand(-60, 60) : 0, vy,
      angle: rand(-0.22, 0.22), spin: rand(-1.2, 1.2),
    });
    this.renderer.addBody(body, spec.cutout.canvas, spec.material);
    this.hero = body;
    this.audio.spawn?.({ pan: 0, material: spec.material });
    this.wake();
    return body;
  }

  removeHero(pop) {
    const body = this.hero;
    if (!body) return;
    const c = body.center();
    this.input.forget(body);
    this.world.removeBody(body);
    this.renderer.removeBody(body);
    this.hero = null;
    if (pop) {
      const m = body.material;
      this.effects.splash(c.x, c.y, 0, -1, 0.7, m.juice || m.tint, Math.max(0.5, m.juiciness));
      this.audio.collide({ intensity: 0.6, pan: this.pan(c.x), material: m });
    }
  }

  /** A scripted poke / slap on the hero (the clip director, the "Poke" button). */
  autoPoke(kind = 'poke') {
    const body = this.hero;
    if (!body) return;
    const c = body.center(), r = body.radius();
    if (kind === 'swipe') {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const res = this.world.slap(c.x - dir * r * 0.55, c.y - r * 0.15, dir, -0.12, 0.95);
      if (res.hit) this.slapFx(res, dir, -0.12, 'swipe');
    } else {
      const x = c.x + rand(-0.25, 0.25) * r, y = c.y - r * 0.55;
      const res = this.world.slap(x, y, 0, 1, 0.75);
      if (res.hit) this.slapFx(res, 0, 1, 'poke');
    }
    this.wake();
  }

  slapFx(result, dx, dy, kind) {
    const { body, x, y, intensity } = result;
    const m = body.material;
    this.audio.slap({ intensity, pan: this.pan(x), material: m });
    this.effects.slapRing(x, y, intensity);
    if (kind !== 'poke') this.effects.handPrint(x, y, handAngle(dx, dy), intensity);
    const c = body.center();
    const ol = Math.hypot(x - c.x, y - c.y) || 1;
    this.effects.splash(x, y, (x - c.x) / ol + 0.35 * dx, (y - c.y) / ol + 0.35 * dy - 0.5, intensity, m.juice || m.tint, m.juiciness);
    if (kind !== 'poke' && intensity > 0.5) this.kick(2 + intensity * 5);
  }

  kick(px) { if (!this.reducedMotion) this.shakeAmp = Math.min(8, Math.max(this.shakeAmp, px)); }

  // --- loop ------------------------------------------------------------------------------------

  wake() {
    this.awakeUntil = performance.now() + 1500;
    if (!this.raf) { this.last = 0; this.raf = requestAnimationFrame(this._frame); }
  }

  get busy() {
    return this.recording || this.input.pointers.size > 0 || !this.world.asleep || this.effects.active
      || this.shakeAmp >= 0.2 || performance.now() < this.awakeUntil;
  }

  frame(now) {
    this.raf = 0;
    if (document.hidden || (!this.visible && !this.recording)) { this.last = 0; return; }
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 1 / 60;
    this.last = now;
    this.tick(dt);
    if (this.busy) this.raf = requestAnimationFrame(this._frame);
    else this.last = 0;
  }

  /** One frame. Also driven directly by tests (window.jellify.advance). */
  tick(dt) {
    this.clock += dt;
    this.world.step(dt);
    for (const ev of this.world.drainEvents()) {
      if (ev.intensity < QUIET_EVENT) continue;
      if (ev.type === 'impact') {
        this.audio.impact({ intensity: ev.intensity, pan: this.pan(ev.x), material: ev.body.material });
        if (ev.intensity > SPLASH_EVENT) this.squirt(ev);
        if (ev.intensity > 0.85) this.kick((ev.intensity - 0.7) * 12);
      } else if (ev.type === 'collide') {
        this.audio.collide({ intensity: ev.intensity, pan: this.pan(ev.x), material: ev.a.material });
      }
    }
    for (const body of this.world.bodies) {
      if (body.grabbed) this.audio.squish({ amount: deformation(body), pan: this.pan(body.center().x), material: body.material, id: body.id });
    }
    this.input.update();
    this.renderer.render(this.world.bodies, this.clock);
    this.effects.update(dt, this.floorY);
    this.effects.draw();
    this.updateShake(dt);
    this.onFrame?.(this);
  }

  squirt({ body, x, y, nx, ny, intensity }) {
    const P = body.positions, tx = -ny, ty = nx;
    let lo = 0, hi = 0;
    for (let i = 0; i < P.length; i += 2) {
      const dx = P[i] - x, dy = P[i + 1] - y;
      if (dx * nx + dy * ny > 4) continue;
      const t = dx * tx + dy * ty;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    const m = body.material;
    for (const [t, side] of [[lo, -1], [hi, 1]]) {
      this.effects.splash(x + tx * t, y + ty * t, nx + side * tx, ny + side * ty, intensity * 0.7, m.juice || m.tint, m.juiciness);
    }
  }

  updateShake(dt) {
    if (this.shakeAmp < 0.2) {
      if (this.shakeAmp || this.shake.x || this.shake.y) { this.shakeAmp = 0; this.shake = { x: 0, y: 0 }; this.scene.style.transform = ''; }
      return;
    }
    const a = this.shakeAmp;
    this.shake = { x: rand(-a, a), y: rand(-a, a) };
    this.scene.style.transform = `translate(${this.shake.x.toFixed(1)}px, ${this.shake.y.toFixed(1)}px)`;
    this.shakeAmp *= Math.exp(-dt * 18);
  }
}

/** RMS distance of the particles from the rest shape, relative to the radius (0 at rest). */
function deformation(body) {
  const P = body.positions, q = body.q, n = body.n;
  if (!q || !n) return 0;
  const c = body.center(), co = Math.cos(body.angle), si = Math.sin(body.angle);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const qx = q[2 * i], qy = q[2 * i + 1];
    const dx = P[2 * i] - c.x - (co * qx - si * qy);
    const dy = P[2 * i + 1] - c.y - (si * qx + co * qy);
    sum += dx * dx + dy * dy;
  }
  return Math.sqrt(sum / n) / body.radius();
}

function handAngle(dx, dy) {
  let px = -dy, py = dx;
  if (py > 0) { px = -px; py = -py; }
  return Math.atan2(px, -py) + rand(-0.25, 0.25);
}
