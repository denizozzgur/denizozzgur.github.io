// Juice & slap feedback on a 2D-canvas overlay (pointer-events: none):
// glossy juice droplets, floor splats, slap rings with comic impact streaks
// and a cartoon hand print.
//
// Every effect lives in a fixed-size struct-of-arrays pool; a full pool
// recycles its oldest item and the frame loop itself allocates nothing.
// World units are CSS pixels, y points down.

const GRAVITY = 2400;          // px/s², same as the physics world
const MAX_DROPS = 450;
const MAX_SPLATS = 90;
const MAX_RINGS = 12;
const MAX_PRINTS = 6;
const MAX_COMBO = 8;           // combo rings (Squeeze Out! combo ladder)
const COMBO_GLINTS = 9;        // max star glints per combo ring
const MAX_PER_SPLASH = 40;
const MAX_MIST = 18;
const EDGE = 12;               // px: hits this close to a boundary count as on it
const MAX_PUDDLE_W = 64;       // px, half-width cap for merged puddles
const MAX_PUDDLE_H = 9;
const LOBES = 7;               // irregular outline points per splat
const DOTS = 3;                // satellite specks per splat
const STREAKS = 8;             // max comic impact streaks per ring
const STRETCH_STEP = 0.2;      // teardrop tail length step (in radii)
const STRETCH_LEVELS = 13;     // pre-built teardrops, tail 1 .. 3.4 radii
const FLY_LIFE = 6;            // s, safety limit for flying droplets
const FLASH_TIME = 0.13;
const FLASH_DISCS = [1, 0.14, 0.72, 0.2, 0.46, 0.3, 0.22, 0.45]; // (radius, alpha) pairs
const HAND_SPRITE = 256;
const TAU = Math.PI * 2;

// droplet states (0 = free slot)
const FLY = 1, SLIDE = 2, MIST = 3;

const INK = 'rgba(58, 30, 66, 0.85)';
const RING_SHADE = 'rgba(58, 30, 66, 0.16)';
const GLINT = 'rgba(255, 255, 255, 0.92)';
const SPLAT_GLINT = 'rgba(255, 255, 255, 0.5)';
const HAND_COLOR = '#ffffff';   // cartoon glove
const HAND_EDGE = '#3a1e42';
const DEFAULT_TINT = [0.95, 0.45, 0.55];

const LOBE_COS = new Float32Array(LOBES);
const LOBE_SIN = new Float32Array(LOBES);
for (let k = 0; k < LOBES; k++) {
  LOBE_COS[k] = Math.cos((k / LOBES) * TAU);
  LOBE_SIN[k] = Math.sin((k / LOBES) * TAU);
}

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0); // NaN → 0
const rand = (a, b) => a + (b - a) * Math.random();
const easeOutCubic = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
function easeOutBack(t) {
  const c = 1.9, u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}
function smoothstep(a, b, v) {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function css(r, g, b) {
  return `rgb(${Math.round(clamp01(r) * 255)},${Math.round(clamp01(g) * 255)},${Math.round(clamp01(b) * 255)})`;
}
// Juice colours derived from one base colour (0..1 channels).
const bodyColor = (r, g, b) => css(r + (1 - r) * 0.07, g + (1 - g) * 0.07, b + (1 - b) * 0.07);
const rimColor = (r, g, b) => css(r ** 1.25 * 0.72, g ** 1.25 * 0.72, b ** 1.25 * 0.72);

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

function makePool(n, floats, extra = {}) {
  const p = { n, next: 0, live: 0, on: new Uint8Array(n) };
  for (const f of floats) p[f] = new Float32Array(n);
  for (const f in extra) p[f] = extra[f];
  return p;
}

// A free slot (searching on from the last one used), or the oldest item when full.
function claim(p) {
  const { n, on, age } = p;
  for (let k = 0, i = p.next; k < n; k++, i = i + 1 === n ? 0 : i + 1) {
    if (!on[i]) {
      p.next = i + 1 === n ? 0 : i + 1;
      p.live++;
      return i;
    }
  }
  let oldest = 0;
  for (let i = 1; i < n; i++) if (age[i] > age[oldest]) oldest = i;
  return oldest;
}

function kill(p, i) {
  if (p.on[i]) { p.on[i] = 0; p.live--; }
}

function ageAll(p, dt) {
  for (let i = 0; i < p.n; i++) {
    if (!p.on[i]) continue;
    p.age[i] += dt;
    if (p.age[i] >= p.life[i]) kill(p, i);
  }
}

// Unit teardrop in local coords: round head of radius 1 at the origin moving
// along +x, tail tapering back to (-tail, 0).
function teardrop(tail) {
  const p = new Path2D();
  if (tail < 1.05) {
    p.arc(0, 0, 1, 0, TAU);
    return p;
  }
  p.moveTo(0, -1);
  p.arc(0, 0, 1, -Math.PI / 2, Math.PI / 2);
  p.quadraticCurveTo(-tail * 0.5, 1, -tail, 0);
  p.quadraticCurveTo(-tail * 0.5, -1, 0, -1);
  p.closePath();
  return p;
}

// Cartoon palm, fingers pointing up (−y), centred in a HAND_SPRITE square.
function makeHandSprite() {
  const S = HAND_SPRITE, c = makeCanvas(S, S), g = c.getContext('2d');
  const u = S * 0.86;
  g.translate(S / 2 - 0.06 * u, S / 2 + 0.02 * u);
  g.lineCap = 'round';
  // [base x, length, lean] per finger, splayed so the gaps read at small sizes
  const fingers = [[-0.2, 0.3, -0.24], [-0.07, 0.37, -0.08], [0.07, 0.35, 0.08], [0.2, 0.27, 0.24]];
  const shape = (grow) => {
    g.beginPath();
    g.ellipse(0, 0.12 * u, 0.28 * u + grow, 0.26 * u + grow, 0, 0, TAU);
    g.fill();
    g.lineWidth = 0.115 * u + 2 * grow;
    g.beginPath();
    for (const [fx, len, lean] of fingers) {
      g.moveTo(fx * u, 0.02 * u);
      g.lineTo((fx + Math.sin(lean) * len) * u, -Math.cos(lean) * len * u);
    }
    g.moveTo(0.18 * u, 0.2 * u); // thumb
    g.lineTo(0.42 * u, 0.03 * u);
    g.stroke();
  };
  // ink outline, then the fill on top
  g.fillStyle = g.strokeStyle = HAND_EDGE;
  shape(S * 0.014);
  g.fillStyle = g.strokeStyle = HAND_COLOR;
  shape(0);

  // soft lavender shading towards the edges gives the glove some volume
  g.globalCompositeOperation = 'source-atop';
  const grad = g.createRadialGradient(-0.05 * u, 0.05 * u, 0.12 * u, -0.05 * u, 0.05 * u, 0.55 * u);
  grad.addColorStop(0, 'rgba(225,215,245,0)');
  grad.addColorStop(1, 'rgba(205,190,235,0.9)');
  g.fillStyle = grad;
  g.fillRect(-S, -S, 2 * S, 2 * S);
  return c;
}

export class JellyEffects {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (canvas.style) canvas.style.pointerEvents = 'none';
    this.width = canvas.clientWidth || canvas.width || 300;
    this.height = canvas.clientHeight || canvas.height || 150;
    this.dpr = 1;
    this.floorY = this.height;
    this.walls = true;     // false: droplets fly off the side edges instead of sliding down them
    this._dirty = false;   // canvas holds pixels that still need clearing
    this._gfx = null;      // lazily built paths & sprites

    this._d = makePool(MAX_DROPS,
      ['x', 'y', 'vx', 'vy', 'r', 'age', 'life', 'drag', 'phase', 'freq', 'wob', 'trail', 'cr', 'cg', 'cb'],
      { child: new Uint8Array(MAX_DROPS), body: new Array(MAX_DROPS).fill(''), rim: new Array(MAX_DROPS).fill('') });
    this._s = makePool(MAX_SPLATS, ['x', 'rx', 'ry', 'age', 'life', 'hitAt', 'cr', 'cg', 'cb'], {
      lobe: new Float32Array(MAX_SPLATS * LOBES),
      dot: new Float32Array(MAX_SPLATS * DOTS * 2), // (offset, radius) pairs
      body: new Array(MAX_SPLATS).fill(''), rim: new Array(MAX_SPLATS).fill(''),
    });
    this._r = makePool(MAX_RINGS, ['x', 'y', 'k', 'age', 'life'], {
      count: new Uint8Array(MAX_RINGS),
      ang: new Float32Array(MAX_RINGS * STREAKS),
      len: new Float32Array(MAX_RINGS * STREAKS),
    });
    this._p = makePool(MAX_PRINTS, ['x', 'y', 'angle', 'k', 'age', 'life', 'flip']);
    this._c = makePool(MAX_COMBO, ['x', 'y', 'lvl', 'age', 'life', 'rot', 'cr', 'cg', 'cb'], { css: new Array(MAX_COMBO).fill('') });

    // scratch for batching droplet glints into one path
    this._gx = new Float32Array(MAX_DROPS);
    this._gy = new Float32Array(MAX_DROPS);
    this._gr = new Float32Array(MAX_DROPS);
    this._tint = [0, 0, 0];
  }

  resize(width, height, dpr = 1) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr > 0 ? dpr : 1;
    this.canvas.width = Math.max(1, Math.round(this.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * this.dpr));
    if (this.canvas.style) {
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
    }
    this.floorY = this.height;
    this._dirty = true;
  }

  // Juice droplets flung from (x,y) in a cone around the normal (nx,ny), which
  // points away from the hit surface; (0,0) means a wide upward burst.
  // tint: [r,g,b] 0..1 (0..255 is accepted too). Returns the number of droplets spawned.
  splash(x, y, nx, ny, intensity = 0.5, tint = DEFAULT_TINT, juiciness = 0.7) {
    const I = clamp01(intensity), J = clamp01(juiciness ?? 0.7);
    if (!(I > 0 && J > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
    let len = Math.hypot(nx, ny), spread = 0.95;
    if (!(len > 1e-6)) { nx = 0; ny = -1; len = 1; spread = 1.5; }
    nx /= len; ny /= len;
    // At the floor or a side wall either normal sign is accepted: juice always
    // flies back into the room instead of splatting on the spot.
    if (y >= this.floorY - EDGE && ny > 0) ny = -ny;
    if (this.walls && ((x <= EDGE && nx < 0) || (x >= this.width - EDGE && nx > 0))) nx = -nx;
    const [tr, tg, tb] = this._normTint(tint);

    let count = Math.min(MAX_PER_SPLASH, Math.floor(42 * I ** 0.85 * J + Math.random()));
    // Pool running short: a new hit still gets a good share (evicting the oldest),
    // while droplets already in flight keep the rest so they get to land.
    const free = MAX_DROPS - this._d.live;
    if (count > free) count = Math.max(free, Math.ceil(count * 0.4));
    const rMax = 3 + 6.5 * I * (0.6 + 0.4 * J);
    const speed = 380 + 1250 * I;
    const heading = Math.atan2(ny, nx);
    const reach = 5 + 16 * I; // impact patch half-width along the tangent

    for (let k = 0; k < count; k++) {
      const r = 1.2 + (rMax - 1.2) * Math.random() ** 1.6; // mostly small, a few fat ones
      const a = heading + spread * (Math.random() + Math.random() - 1);
      const v = speed * rand(0.3, 1.1) * (1.12 - 0.35 * (r / rMax));
      const vx = Math.cos(a) * v, vy = Math.sin(a) * v;
      const off = rand(-reach, reach), lift = rand(2, 6);
      // start at a random sub-frame time so a burst is spread out on its first frame
      const t0 = Math.random() * 0.014;
      const l = rand(0.88, 1.08);
      this._spawnDrop(FLY,
        x - ny * off + nx * lift + vx * t0, y + nx * off + ny * lift + vy * t0, vx, vy, r,
        tr * l + rand(-0.03, 0.03), tg * l + rand(-0.03, 0.03), tb * l + rand(-0.03, 0.03), false);
    }

    // fine mist on strong hits; only ever uses free slots
    const mist = Math.min(MAX_MIST, MAX_DROPS - this._d.live, Math.floor((I - 0.45) * 44 * J + Math.random()));
    for (let k = 0; k < mist; k++) {
      const a = heading + spread * 1.25 * (Math.random() + Math.random() - 1);
      const v = speed * rand(0.45, 1.35);
      const l = rand(0.95, 1.15);
      this._spawnDrop(MIST, x + rand(-reach, reach) * 0.6, y + rand(-reach, reach) * 0.6,
        Math.cos(a) * v, Math.sin(a) * v, rand(0.55, 1.35), tr * l, tg * l, tb * l, false);
    }
    return count;
  }

  // Expanding soft ring + brief flash + comic impact streaks (~260–400 ms).
  slapRing(x, y, intensity = 0.7) {
    const I = clamp01(intensity);
    if (!(I > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const p = this._r, i = claim(p);
    p.on[i] = 1;
    p.x[i] = x; p.y[i] = y; p.k[i] = I;
    p.age[i] = 0; p.life[i] = 0.26 + 0.14 * I;
    const n = I < 0.12 ? 0 : Math.min(STREAKS, 4 + Math.round(4 * I));
    p.count[i] = n;
    const rot = Math.random() * TAU;
    for (let k = 0; k < n; k++) {
      p.ang[i * STREAKS + k] = rot + (k + rand(-0.3, 0.3)) * (TAU / n);
      p.len[i * STREAKS + k] = rand(0.65, 1.3);
    }
  }

  // Combo ladder ring (level 1…5): a ring in the jelly's colour that pops out with a white core,
  // plus `level + 3` star glints flung outward and spinning — bigger, longer and brighter per step.
  comboRing(x, y, level = 1, tint = DEFAULT_TINT) {
    const L = Math.max(1, Math.min(5, Math.floor(level) || 1));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const p = this._c, i = claim(p);
    const [r, g, b] = this._normTint(tint || DEFAULT_TINT);
    p.on[i] = 1;
    p.x[i] = x; p.y[i] = y; p.lvl[i] = L;
    p.age[i] = 0; p.life[i] = 0.32 + 0.05 * L;
    p.rot[i] = Math.random() * TAU;
    p.cr[i] = r; p.cg[i] = g; p.cb[i] = b;
    p.css[i] = css(r * 0.85 + 0.15, g * 0.85 + 0.15, b * 0.85 + 0.15);
  }

  // Translucent cartoon palm that slams in, squashes and fades.
  // angle: radians, 0 = fingers pointing up; positive rotates clockwise.
  handPrint(x, y, angle = 0, intensity = 0.7) {
    const I = clamp01(intensity);
    if (!(I > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const p = this._p, i = claim(p);
    p.on[i] = 1;
    p.x[i] = x; p.y[i] = y; p.k[i] = I;
    p.angle[i] = Number.isFinite(angle) ? angle : 0;
    p.age[i] = 0; p.life[i] = 0.75 + 0.35 * I;
    p.flip[i] = Math.random() < 0.5 ? -1 : 1;
  }

  update(dt, floorY = this.height) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 1 / 20);
    if (Number.isFinite(floorY)) this.floorY = floorY;
    if (this._d.live) this._updateDrops(dt);
    if (this._s.live) ageAll(this._s, dt);
    if (this._r.live) ageAll(this._r, dt);
    if (this._p.live) ageAll(this._p, dt);
    if (this._c.live) ageAll(this._c, dt);
  }

  /** Anything alive (or still on the canvas waiting to be cleared). */
  get active() {
    return this._dirty || this._d.live + this._s.live + this._r.live + this._p.live + this._c.live > 0;
  }

  /** Something quick is on screen (flying drops, rings, hand prints, combo text), not just fading splats. */
  get moving() {
    return this._d.live + this._r.live + this._p.live + this._c.live > 0;
  }

  draw() {
    const ctx = this.ctx;
    const live = this._d.live + this._s.live + this._r.live + this._p.live + this._c.live;
    if (!live && !this._dirty) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._dirty = live > 0;
    if (!live) return;
    const gfx = this._gfx || (this._gfx = {
      drops: Array.from({ length: STRETCH_LEVELS }, (_, k) => teardrop(1 + k * STRETCH_STEP)),
      hand: makeHandSprite(),
    });
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    if (this._s.live) this._drawSplats(ctx);
    if (this._d.live) this._drawDrops(ctx, gfx.drops);
    if (this._r.live) this._drawRings(ctx);
    if (this._p.live) this._drawPrints(ctx, gfx.hand);
    if (this._c.live) this._drawCombo(ctx);
    ctx.globalAlpha = 1;
  }

  clear() {
    for (const p of [this._d, this._s, this._r, this._p, this._c]) { p.on.fill(0); p.live = 0; }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._dirty = false;
  }

  // Live counts, for debugging and tests.
  stats() {
    let sliding = 0, mist = 0;
    const d = this._d;
    for (let i = 0; i < MAX_DROPS; i++) {
      if (d.on[i] === SLIDE) sliding++;
      else if (d.on[i] === MIST) mist++;
    }
    return { droplets: d.live, sliding, mist, splats: this._s.live, rings: this._r.live, prints: this._p.live, combos: this._c.live };
  }

  // ---- internals ---------------------------------------------------------

  _normTint(t) {
    const out = this._tint;
    if (!t || t.length < 3) t = DEFAULT_TINT;
    const k = t[0] > 1.5 || t[1] > 1.5 || t[2] > 1.5 ? 1 / 255 : 1;
    out[0] = clamp01(t[0] * k); out[1] = clamp01(t[1] * k); out[2] = clamp01(t[2] * k);
    return out;
  }

  _spawnDrop(state, x, y, vx, vy, r, cr, cg, cb, child) {
    const d = this._d, i = claim(d);
    cr = clamp01(cr); cg = clamp01(cg); cb = clamp01(cb);
    d.on[i] = state;
    d.child[i] = child ? 1 : 0;
    d.x[i] = x; d.y[i] = y; d.vx[i] = vx; d.vy[i] = vy; d.r[i] = r;
    d.age[i] = 0;
    d.life[i] = state === MIST ? rand(0.25, 0.6) : FLY_LIFE;
    d.drag[i] = state === MIST ? rand(4, 7) : 0.3 + 1.6 / (r + 1);
    d.phase[i] = Math.random() * TAU;
    d.freq[i] = rand(14, 26) * TAU;
    d.wob[i] = rand(0.1, 0.24);
    d.cr[i] = cr; d.cg[i] = cg; d.cb[i] = cb;
    d.body[i] = bodyColor(cr, cg, cb);
    d.rim[i] = state === MIST ? d.body[i] : rimColor(cr, cg, cb);
  }

  _updateDrops(dt) {
    const d = this._d, W = this.width, floor = this.floorY;
    for (let i = 0; i < MAX_DROPS; i++) {
      const st = d.on[i];
      if (!st) continue;
      const r = d.r[i];
      const age = (d.age[i] += dt);
      d.phase[i] += d.freq[i] * dt;

      if (st === SLIDE) {
        // creep down the wall towards its own slide speed (stored in vx), fading out
        let vy = d.vy[i];
        vy += (d.vx[i] - vy) * Math.min(1, 5 * dt);
        const y = d.y[i] + vy * dt;
        d.vy[i] = vy; d.y[i] = y;
        if (age >= d.life[i]) kill(d, i);
        else if (y + r >= floor) {
          if (age < d.life[i] * 0.75) this._addSplat(d.x[i], r * 0.8, 200, 0, d.cr[i], d.cg[i], d.cb[i]);
          kill(d, i);
        }
        continue;
      }

      const drag = Math.exp(-d.drag[i] * dt);
      const vx = d.vx[i] * drag;
      const vy = (d.vy[i] + GRAVITY * (st === MIST ? 0.35 : 1) * dt) * drag;
      const x = d.x[i] + vx * dt, y = d.y[i] + vy * dt;
      d.vx[i] = vx; d.vy[i] = vy; d.x[i] = x; d.y[i] = y;

      if (st === MIST) {
        if (age >= d.life[i] || y > floor) kill(d, i);
      } else if (y + r * 0.4 >= floor && vy > 0) {
        this._land(i, x, vx, vy);
      } else if (!this.walls && (x < -r * 2 || x > W + r * 2)) {
        kill(d, i);
      } else if (this.walls && ((x < r * 0.6 && vx < 0) || (x > W - r * 0.6 && vx > 0))) {
        d.on[i] = SLIDE;
        d.x[i] = x < W / 2 ? r * 0.45 : W - r * 0.45;
        d.vx[i] = rand(40, 150) * Math.min(1.4, r / 4); // target slide speed
        d.vy[i] = vy * 0.15;
        d.trail[i] = y;
        d.age[i] = 0;
        d.life[i] = rand(0.6, 1.5);
      } else if (age >= d.life[i]) {
        kill(d, i);
      }
    }
  }

  // Droplet reaches the floor: splat decal plus a tiny crown for big fast drops.
  _land(i, x, vx, vy) {
    const d = this._d, r = d.r[i], cr = d.cr[i], cg = d.cg[i], cb = d.cb[i];
    this._addSplat(x, r, vy, vx, cr, cg, cb);
    const child = d.child[i];
    kill(d, i);
    if (child || r < 2.6 || vy < 450) return;
    const n = Math.min(1 + Math.floor(Math.random() * 3), MAX_DROPS - d.live);
    for (let k = 0; k < n; k++) {
      this._spawnDrop(FLY, x + rand(-r, r), this.floorY - r, vx * 0.3 + rand(-220, 220),
        -vy * rand(0.18, 0.38), r * rand(0.28, 0.45), cr, cg, cb, true);
    }
  }

  _addSplat(x, r, vy, vx, cr, cg, cb) {
    const s = this._s;
    const impact = Math.min(2.6, Math.max(0, vy) / 650);
    const rx = r * (1.5 + impact) * rand(0.9, 1.15);
    const ry = r * rand(0.58, 0.8);
    x += Math.sign(vx) * r * 0.4;

    // a drop landing in a settled puddle of the same juice feeds it (and makes it jiggle)
    const m = this._puddleAt(x, cr, cg, cb);
    if (m >= 0) {
      s.x[m] += (x - s.x[m]) * 0.15;
      s.rx[m] = Math.min(MAX_PUDDLE_W, Math.hypot(s.rx[m], rx * 0.8));
      s.ry[m] = Math.min(MAX_PUDDLE_H, Math.max(s.ry[m], ry) + ry * 0.08);
      s.hitAt[m] = s.age[m];
      s.life[m] = Math.max(s.life[m], s.age[m] + rand(3, 5));
      return;
    }

    const i = claim(s);
    s.on[i] = 1;
    s.x[i] = x; s.rx[i] = rx; s.ry[i] = ry;
    s.age[i] = 0;
    s.hitAt[i] = -1;
    s.life[i] = rand(3, 6);
    s.cr[i] = cr; s.cg[i] = cg; s.cb[i] = cb;
    for (let k = 0; k < LOBES; k++) s.lobe[i * LOBES + k] = rand(-0.16, 0.34);
    for (let k = 0; k < DOTS; k++) {
      const o = (i * DOTS + k) * 2;
      s.dot[o] = (Math.random() < 0.5 ? -1 : 1) * rand(1.15, 1.9);
      s.dot[o + 1] = Math.random() < 0.6 ? r * rand(0.16, 0.34) : 0;
    }
    s.body[i] = bodyColor(cr, cg, cb);
    s.rim[i] = rimColor(cr, cg, cb);
  }

  _puddleAt(x, cr, cg, cb) {
    const s = this._s;
    for (let i = 0; i < MAX_SPLATS; i++) {
      if (!s.on[i] || s.age[i] < 0.12 || s.age[i] > s.life[i] * 0.45) continue;
      if (Math.abs(s.x[i] - x) > s.rx[i] * 0.7) continue;
      if (Math.abs(s.cr[i] - cr) + Math.abs(s.cg[i] - cg) + Math.abs(s.cb[i] - cb) > 0.25) continue;
      return i;
    }
    return -1;
  }

  _drawDrops(ctx, paths) {
    const d = this._d, dpr = this.dpr, gx = this._gx, gy = this._gy, gr = this._gr;
    let glints = 0;
    // oldest → newest, so fresh droplets are on top
    for (let k = 0, i = d.next; k < MAX_DROPS; k++, i = i + 1 === MAX_DROPS ? 0 : i + 1) {
      const st = d.on[i];
      if (!st) continue;
      const x = d.x[i], y = d.y[i], r = d.r[i], age = d.age[i];
      let vx = d.vx[i], vy = d.vy[i], alpha = 0.96, speedScale = 650;
      if (st === SLIDE) {
        const f = age / d.life[i];
        alpha = 0.96 * (1 - f * f);
        vx = 0;
        speedScale = 160;
        // faint wet trail left on the wall
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = alpha * 0.28;
        ctx.strokeStyle = d.body[i];
        ctx.lineWidth = r * 0.7;
        ctx.beginPath();
        ctx.moveTo(x, d.trail[i]);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else if (st === MIST) {
        alpha = 0.7 * (1 - age / d.life[i]);
      } else if (age > FLY_LIFE - 0.3) {
        alpha *= (FLY_LIFE - age) / 0.3;
      }

      const speed = Math.hypot(vx, vy);
      let c = 1, s = 0;
      if (speed > 1) { c = vx / speed; s = vy / speed; }
      const tail = 1 + Math.min(2.4, speed / speedScale);
      const lvl = Math.min(STRETCH_LEVELS - 1, Math.round((tail - 1) / STRETCH_STEP));
      // jiggle: strong right after launch, settling to a gentle shimmer
      const osc = Math.sin(d.phase[i]) * (d.wob[i] * Math.exp(-age * 5) + 0.035);
      const along = r * (1 + osc) * dpr;
      const across = (r * (1 - osc) * dpr / Math.sqrt(1 + 0.3 * (tail - 1))) * (st === SLIDE ? 0.8 : 1);
      const a = c * along, b = s * along, e = -s * across, f = c * across;

      ctx.globalAlpha = alpha;
      ctx.setTransform(a, b, e, f, x * dpr, y * dpr);
      ctx.fillStyle = d.rim[i];
      ctx.fill(paths[lvl]);
      if (st === MIST) continue;
      // lighter body shifted towards the light (top-left) leaves a shaded rim
      ctx.setTransform(a * 0.72, b * 0.72, e * 0.72, f * 0.72, (x - r * 0.1) * dpr, (y - r * 0.14) * dpr);
      ctx.fillStyle = d.body[i];
      ctx.fill(paths[lvl]);

      if (r > 1.3 && alpha > 0.35) {
        const rr = across / dpr;
        gx[glints] = x - rr * 0.36;
        gy[glints] = y - rr * 0.4;
        gr[glints] = Math.max(0.55, rr * 0.27);
        glints++;
      }
    }
    if (!glints) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = GLINT;
    ctx.beginPath();
    for (let g = 0; g < glints; g++) {
      ctx.moveTo(gx[g] + gr[g], gy[g]);
      ctx.arc(gx[g], gy[g], gr[g], 0, TAU);
    }
    ctx.fill();
  }

  _drawSplats(ctx) {
    const s = this._s, dpr = this.dpr, floor = this.floorY;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let k = 0, i = s.next; k < MAX_SPLATS; k++, i = i + 1 === MAX_SPLATS ? 0 : i + 1) {
      if (!s.on[i]) continue;
      const t = s.age[i], life = s.life[i];
      // lands as a tall drop, spreads out with a wet overshoot, then dries and fades
      const grow = t < 0.12 ? easeOutBack(t / 0.12) : 1;
      const dry = 1 - 0.14 * (t / life);
      const fade = 1 - smoothstep(life * 0.5, life, t);
      const sinceHit = t - s.hitAt[i];
      const jiggle = s.hitAt[i] >= 0 && sinceHit < 0.4 ? 0.12 * Math.exp(-sinceHit * 9) * Math.sin(sinceHit * 48) : 0;
      const rx = s.rx[i] * (0.35 + 0.65 * grow) * dry * (1 + jiggle);
      const ry = s.ry[i] * (1.6 - 0.6 * grow) * dry * (1 - 1.3 * jiggle);
      const cx = s.x[i], cy = floor - ry * 0.55, o = i * LOBES;

      ctx.globalAlpha = 0.92 * fade;
      ctx.fillStyle = s.rim[i];
      blobPath(ctx, cx, cy, rx, ry, s.lobe, o);
      ctx.fill();
      ctx.fillStyle = s.body[i];
      blobPath(ctx, cx - rx * 0.03, cy - ry * 0.18, rx * 0.84, ry * 0.66, s.lobe, o);
      ctx.fill();

      ctx.fillStyle = s.rim[i];
      ctx.beginPath();
      for (let j = 0; j < DOTS; j++) {
        const q = (i * DOTS + j) * 2, dr = s.dot[q + 1] * dry;
        if (dr <= 0) continue;
        const dx = cx + s.dot[q] * rx * grow;
        ctx.moveTo(dx + dr, floor - dr * 0.9);
        ctx.arc(dx, floor - dr * 0.9, dr, 0, TAU);
      }
      ctx.fill();

      ctx.globalAlpha = fade;
      ctx.fillStyle = SPLAT_GLINT;
      ctx.beginPath();
      ctx.ellipse(cx - rx * 0.22, cy - ry * 0.4, rx * 0.3, Math.max(0.5, ry * 0.18), 0, 0, TAU);
      ctx.fill();
    }
  }

  _drawRings(ctx) {
    const p = this._r, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = 0; i < MAX_RINGS; i++) {
      if (!p.on[i]) continue;
      const x = p.x[i], y = p.y[i], I = p.k[i], t = p.age[i], life = p.life[i], q = t / life;

      if (t < FLASH_TIME) {
        // soft glow from stacked translucent discs (far cheaper than a scaled sprite)
        const f = t / FLASH_TIME, R = (26 + 70 * I) * (0.55 + 0.45 * easeOutCubic(f));
        const a = (1 - f) * (1 - f) * (0.5 + 0.45 * I);
        ctx.fillStyle = '#fff';
        for (let k = 0; k < FLASH_DISCS.length; k += 2) {
          ctx.globalAlpha = a * FLASH_DISCS[k + 1];
          ctx.beginPath();
          ctx.arc(x, y, R * FLASH_DISCS[k], 0, TAU);
          ctx.fill();
        }
      }

      const R0 = 6 + 10 * I, R1 = 46 + 110 * I, w = (2 + 8 * I) * (1 - q) ** 1.3;
      ring(ctx, x, y, R0 + (R1 - R0) * easeOutCubic(q), w, (1 - q) ** 1.5);
      if (I > 0.45 && t > 0.06) {
        const q2 = (t - 0.06) / (life - 0.06);
        ring(ctx, x, y, R0 + (R1 * 0.6 - R0) * easeOutCubic(q2), w * 0.55, 0.7 * (1 - q2) ** 1.5);
      }

      const n = p.count[i];
      if (!n || q >= 0.85) continue;
      const u = q / 0.85, e = easeOutCubic(u);
      const rin = R0 * 1.3 + R1 * 0.75 * e;
      const baseLen = (12 + 34 * I) * (1 - u) ** 0.7, half = (1.2 + 2.3 * I) * (1 - 0.6 * u);
      ctx.globalAlpha = 1 - u * u;
      ctx.fillStyle = INK;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const a = p.ang[i * STREAKS + k], c = Math.cos(a), s = Math.sin(a);
        const len = baseLen * p.len[i * STREAKS + k];
        const mx = x + c * (rin + len * 0.4), my = y + s * (rin + len * 0.4);
        ctx.moveTo(x + c * rin, y + s * rin);
        ctx.lineTo(mx - s * half, my + c * half);
        ctx.lineTo(x + c * (rin + len), y + s * (rin + len));
        ctx.lineTo(mx + s * half, my - c * half);
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  _drawCombo(ctx) {
    const p = this._c, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = 0; i < MAX_COMBO; i++) {
      if (!p.on[i]) continue;
      const x = p.x[i], y = p.y[i], L = p.lvl[i], q = p.age[i] / p.life[i];
      const e = easeOutBack(Math.min(1, q * 1.25));
      // tinted ring with a white inner line
      const R = (8 + 5 * L) + (14 + 7 * L) * e, w = (2.5 + 0.8 * L) * (1 - q);
      if (w > 0.1) {
        ctx.globalAlpha = (1 - q) * 0.9;
        ctx.beginPath();
        ctx.arc(x, y, R, 0, TAU);
        ctx.lineWidth = w * 2;
        ctx.strokeStyle = p.css[i];
        ctx.stroke();
        ctx.lineWidth = w * 0.7;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      // star glints flung out, spinning
      const n = Math.min(COMBO_GLINTS, L + 3), u = easeOutCubic(q);
      const rr = R * (0.9 + 0.7 * u), sz = (2.2 + 0.7 * L) * (1 - q * 0.8);
      ctx.globalAlpha = 1 - q * q;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const a = p.rot[i] + (k / n) * TAU + q * 1.2;
        const cx = x + Math.cos(a) * rr, cy = y + Math.sin(a) * rr;
        // 4-point star
        ctx.moveTo(cx, cy - sz * 1.6);
        ctx.lineTo(cx + sz * 0.45, cy - sz * 0.45);
        ctx.lineTo(cx + sz * 1.6, cy);
        ctx.lineTo(cx + sz * 0.45, cy + sz * 0.45);
        ctx.lineTo(cx, cy + sz * 1.6);
        ctx.lineTo(cx - sz * 0.45, cy + sz * 0.45);
        ctx.lineTo(cx - sz * 1.6, cy);
        ctx.lineTo(cx - sz * 0.45, cy - sz * 0.45);
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  _drawPrints(ctx, hand) {
    const p = this._p, dpr = this.dpr, half = HAND_SPRITE / 2;
    for (let i = 0; i < MAX_PRINTS; i++) {
      if (!p.on[i]) continue;
      const t = p.age[i], q = t / p.life[i], I = p.k[i];
      // slams in oversized, undershoots, then springs back to rest size
      const s = t < 0.06
        ? 1.45 - 0.55 * easeOutCubic(t / 0.06)
        : 1 - 0.1 * Math.exp(-(t - 0.06) * 16) * Math.cos((t - 0.06) * 42);
      const squash = 0.22 * Math.exp(-t * 11);
      const size = ((95 + 75 * I) / HAND_SPRITE) * dpr;
      const sx = s * (1 + squash) * size * p.flip[i], sy = s * (1 - squash) * size;
      const c = Math.cos(p.angle[i]), n = Math.sin(p.angle[i]);
      ctx.setTransform(c * sx, n * sx, -n * sy, c * sy, p.x[i] * dpr, p.y[i] * dpr);
      const hold = 0.45 + 0.25 * I;
      ctx.globalAlpha = Math.min(1, t / 0.02) * (hold + (0.95 - hold) * Math.exp(-t * 9)) * (1 - smoothstep(0.35, 1, q));
      ctx.drawImage(hand, -half, -half);
    }
  }
}

function ring(ctx, x, y, R, w, alpha) {
  if (alpha <= 0.01 || w <= 0.05) return;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, TAU);
  ctx.lineWidth = w * 2 + 2;
  ctx.strokeStyle = RING_SHADE;
  ctx.stroke();
  ctx.lineWidth = w;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

// Smooth closed blob through LOBES jittered points on an ellipse.
function blobPath(ctx, cx, cy, rx, ry, lobe, o) {
  const last = o + LOBES - 1;
  let ax = cx + rx * (1 + lobe[last]) * LOBE_COS[LOBES - 1];
  let ay = cy + ry * (1 + lobe[last]) * LOBE_SIN[LOBES - 1];
  let bx = cx + rx * (1 + lobe[o]) * LOBE_COS[0];
  let by = cy + ry * (1 + lobe[o]) * LOBE_SIN[0];
  ctx.beginPath();
  ctx.moveTo((ax + bx) / 2, (ay + by) / 2);
  for (let k = 0; k < LOBES; k++) {
    ax = bx; ay = by;
    const n = k + 1 === LOBES ? 0 : k + 1;
    bx = cx + rx * (1 + lobe[o + n]) * LOBE_COS[n];
    by = cy + ry * (1 + lobe[o + n]) * LOBE_SIN[n];
    ctx.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2);
  }
  ctx.closePath();
}
