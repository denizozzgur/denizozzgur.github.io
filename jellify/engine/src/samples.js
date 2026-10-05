// Procedurally painted sample images: no external assets, fully deterministic.
//
// Every painter returns a square canvas with the object on a transparent background,
// filling ~90% of the canvas and lit from the upper-left. The bulk of each image is a
// per-pixel "shader" written into ImageData (colour ramps, fibres, cells, lighting);
// crisp details (seeds, hairs, leaves) are then drawn as vector shapes on top.

export const SAMPLES = [
  { id: 'kiwi', label: 'Kiwi', emoji: '🥝', material: 'kiwi' },
  { id: 'strawberry', label: 'Strawberry', emoji: '🍓', material: 'strawberry' },
  { id: 'orange', label: 'Orange', emoji: '🍊', material: 'orange' },
  { id: 'watermelon', label: 'Watermelon', emoji: '🍉', material: 'watermelon' },
  // The bear's moulded eye dimples (paintGummy reliefs at (±0.062, −0.222)·G, r 0.019·G, G = 1.19)
  // as blink-rig eyes [x, y, r] in unit canvas coordinates. The four fruits have no face.
  { id: 'gummy', label: 'Gummy', emoji: '🐻', material: 'gummy', eyes: [[0.426, 0.236, 0.023], [0.574, 0.236, 0.023]] },
];

const PAINTERS = {
  kiwi: paintKiwi,
  strawberry: paintStrawberry,
  orange: paintOrange,
  watermelon: paintWatermelon,
  gummy: paintGummy,
};

const cache = new Map();

// Returns a fresh canvas (callers may draw on it); the painting itself is cached per id+size.
export function drawSample(id, size = 640) {
  const s = Math.max(32, Math.round(size) || 640);
  const key = `${PAINTERS[id] ? id : 'kiwi'}@${s}`;
  let master = cache.get(key);
  if (!master) {
    master = paintSample(id, s);
    cache.set(key, master);
  }
  const out = makeCanvas(s, s);
  out.getContext('2d').drawImage(master, 0, 0);
  return out;
}

// Uncached painter (used by drawSample and by the determinism test).
export function paintSample(id, size = 640) {
  let painter = PAINTERS[id];
  if (!painter) {
    console.warn(`[samples] unknown sample "${id}", using kiwi`);
    painter = PAINTERS.kiwi;
  }
  return painter(Math.max(32, Math.round(size) || 640));
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgb = (r, g, b) => `rgb(${Math.round(clamp01(r) * 255)},${Math.round(clamp01(g) * 255)},${Math.round(clamp01(b) * 255)})`;

function normalize3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// Colour ramp → three channel tables of n entries over 0..1. stops: [[pos, r, g, b], ...].
function ramp(stops, n = 512) {
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i / (n - 1);
    let j = 0;
    while (j < stops.length - 2 && p > stops[j + 1][0]) j++;
    const s0 = stops[j], s1 = stops[j + 1];
    const t = smoothstep(s0[0], s1[0], p);
    R[i] = mix(s0[1], s1[1], t);
    G[i] = mix(s0[2], s1[2], t);
    B[i] = mix(s0[3], s1[3], t);
  }
  return [R, G, B];
}

// Rasterise a shape with Canvas 2D (anti-aliased) and return its alpha as 0..1 floats.
function rasterAlpha(S, draw) {
  const c = makeCanvas(S, S);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = g.strokeStyle = '#fff';
  draw(g);
  const d = g.getImageData(0, 0, S, S).data;
  const a = new Float32Array(S * S);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
  return a;
}

// ---------------------------------------------------------------------------
// Noise (shared tables are built once from fixed seeds)
// ---------------------------------------------------------------------------

let valueTable = null;
function valueNoiseTable() {
  if (!valueTable) {
    const rand = mulberry32(0x9e3779b9);
    valueTable = new Float32Array(256 * 256);
    for (let i = 0; i < valueTable.length; i++) valueTable[i] = rand();
  }
  return valueTable;
}

// Smooth 2-D value noise in 0..1, tiling every 256 units on both axes.
function vnoise(T, x, y) {
  const xf = Math.floor(x), yf = Math.floor(y);
  let fx = x - xf, fy = y - yf;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const x0 = xf & 255, x1 = (xf + 1) & 255, y0 = (yf & 255) << 8, y1 = ((yf + 1) & 255) << 8;
  const a = T[y0 + x0], b = T[y0 + x1], c = T[y1 + x0], d = T[y1 + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Tileable Worley (cellular) noise: 256×256 tile, one feature point per 8×8 cell.
//   f1   – distance to the nearest point (cell units, ~0 at the cell centre)
//   edge – F2 − F1 (0 on cell borders)
//   id   – random 0..1 per cell
const WN = 256, WCELL = 8;
let worley = null;
function worleyTile() {
  if (worley) return worley;
  const G = WN / WCELL, rand = mulberry32(0x5eed1e);
  const px = new Float32Array(G * G), py = new Float32Array(G * G), pr = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) {
    px[i] = rand();
    py[i] = rand();
    pr[i] = rand();
  }
  const f1 = new Float32Array(WN * WN), edge = new Float32Array(WN * WN), id = new Float32Array(WN * WN);
  for (let y = 0; y < WN; y++) {
    const gy = Math.floor(y / WCELL);
    for (let x = 0; x < WN; x++) {
      const gx = Math.floor(x / WCELL);
      let d1 = Infinity, d2 = Infinity, best = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = gx + ox, cy = gy + oy;
          const k = ((cy + G) % G) * G + ((cx + G) % G);
          const dx = (cx + px[k]) * WCELL - x - 0.5, dy = (cy + py[k]) * WCELL - y - 0.5;
          const dd = dx * dx + dy * dy;
          if (dd < d1) { d2 = d1; d1 = dd; best = k; } else if (dd < d2) d2 = dd;
        }
      }
      const o = y * WN + x;
      f1[o] = Math.sqrt(d1) / WCELL;
      edge[o] = (Math.sqrt(d2) - Math.sqrt(d1)) / WCELL;
      id[o] = pr[best];
    }
  }
  worley = { f1, edge, id };
  return worley;
}

// Bilinear / nearest samples of a 256×256 tiling field.
function tile(F, x, y) {
  const xf = Math.floor(x), yf = Math.floor(y), fx = x - xf, fy = y - yf;
  const x0 = xf & 255, x1 = (xf + 1) & 255, y0 = (yf & 255) << 8, y1 = ((yf + 1) & 255) << 8;
  const a = F[y0 + x0], b = F[y0 + x1], c = F[y1 + x0], d = F[y1 + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
const tileNearest = (F, x, y) => F[((Math.floor(y) & 255) << 8) | (Math.floor(x) & 255)];

// Angular tables: one full turn sampled into AN entries.
const AN = 4096, AMASK = AN - 1;

// Periodic 1-D value noise, range −1..1, `freq` random knots per turn.
function periodicNoise(rand, freq) {
  const knots = new Float32Array(freq);
  for (let i = 0; i < freq; i++) knots[i] = rand() * 2 - 1;
  const out = new Float32Array(AN);
  for (let i = 0; i < AN; i++) {
    const p = (i / AN) * freq, k = Math.floor(p);
    let f = p - k;
    f = f * f * (3 - 2 * f);
    const a = knots[k % freq];
    out[i] = a + (knots[(k + 1) % freq] - a) * f;
  }
  return out;
}

// Sum of periodic octaves: [[freq, amplitude], ...].
function angularNoise(rand, octaves) {
  const out = new Float32Array(AN);
  for (const [freq, amp] of octaves) {
    const t = periodicNoise(rand, freq);
    for (let i = 0; i < AN; i++) out[i] += t[i] * amp;
  }
  return out;
}

// Thin bright lines at the zero crossings of periodic noise, normalised to 0..1.
// octaves: [[freq, amplitude, sharpness], ...].
function ridgedNoise(rand, octaves) {
  const out = new Float32Array(AN);
  for (const [freq, amp, sharp] of octaves) {
    const t = periodicNoise(rand, freq);
    for (let i = 0; i < AN; i++) out[i] += amp * Math.pow(1 - Math.abs(t[i]), sharp);
  }
  let max = 1e-6;
  for (let i = 0; i < AN; i++) max = Math.max(max, out[i]);
  for (let i = 0; i < AN; i++) out[i] /= max;
  return out;
}

// Linear lookup into an angular table; `turn` may be any real number (wraps).
function lookup(T, turn) {
  const p = turn * AN, i = Math.floor(p), a = T[i & AMASK];
  return a + (T[(i + 1) & AMASK] - a) * (p - i);
}

function blurCircular(T, r) {
  const out = new Float32Array(AN);
  let acc = 0;
  for (let i = -r; i <= r; i++) acc += T[i & AMASK];
  for (let i = 0; i < AN; i++) {
    out[i] = acc / (2 * r + 1);
    acc += T[(i + r + 1) & AMASK] - T[(i - r) & AMASK];
  }
  return out;
}

// Pre-filtered copies of an angular table (box widths 1, 3, 9, 27 samples) so radial
// lines that converge towards the centre fade out instead of aliasing.
function angularMips(T) {
  const levels = [T];
  for (let r = 1; r <= 13; r = r * 3 + 1) levels.push(blurCircular(T, r));
  return levels;
}

// Fractional mip level (0..3) for a table sampled at `samplesPerPixel` entries per pixel.
const mipLevel = (samplesPerPixel) => Math.min(3, Math.max(0, Math.log(samplesPerPixel) * 0.9102)); // log3

function lookupMip(levels, turn, level) {
  const l0 = Math.floor(level), a = lookup(levels[l0], turn);
  return l0 < 3 ? a + (lookup(levels[l0 + 1], turn) - a) * (level - l0) : a;
}

// ---------------------------------------------------------------------------
// Fields: distance transform, box blur, canvas blur
// ---------------------------------------------------------------------------

// Chamfer distance (px) from every inside pixel (alpha > 0.5) to the outside.
function distanceInside(alpha, w, h) {
  const d = new Float32Array(w * h), D2 = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = alpha[i] > 0.5 ? 1e6 : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + D2, at(x + 1, y - 1) + D2);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + D2, at(x - 1, y + 1) + D2);
    }
  }
  return d;
}

// Separable box blur, repeated `passes` times (≈ Gaussian). Edges clamp.
function boxBlur(src, w, h, r, passes) {
  let a = src, b = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc * norm;
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += b[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc * norm;
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

// ctx.filter is missing or a no-op in some browsers (older Safari): probe it once.
let filterWorks;
function canvasFilterWorks() {
  if (filterWorks === undefined) {
    try {
      const c = makeCanvas(9, 9), g = c.getContext('2d', { willReadFrequently: true });
      g.filter = 'blur(2px)';
      g.fillStyle = '#fff';
      g.fillRect(4, 4, 1, 1);
      filterWorks = g.getImageData(2, 4, 1, 1).data[3] > 0;
    } catch {
      filterWorks = false;
    }
  }
  return filterWorks;
}

// Blurred copy of a canvas. Falls back to bilinear down/up-sampling without ctx.filter.
function blurredCopy(src, radius) {
  const w = src.width, h = src.height, out = makeCanvas(w, h), g = out.getContext('2d');
  if (canvasFilterWorks()) {
    g.filter = `blur(${radius}px)`;
    g.drawImage(src, 0, 0);
    return out;
  }
  const k = Math.max(1, radius / 1.2);
  const small = makeCanvas(Math.max(1, Math.round(w / k)), Math.max(1, Math.round(h / k)));
  const sg = small.getContext('2d');
  sg.imageSmoothingQuality = g.imageSmoothingQuality = 'high';
  sg.drawImage(src, 0, 0, small.width, small.height);
  g.drawImage(small, 0, 0, w, h);
  return out;
}

const ellipse = (g, x, y, rx, ry, rot) => {
  g.beginPath();
  g.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, TAU);
};

// Egg/teardrop outline in a local frame: pointed end at −x, round end at +x.
function teardrop(g, hl, hw) {
  g.beginPath();
  g.moveTo(-hl, 0);
  g.bezierCurveTo(-hl * 0.72, -hw * 0.72, -hl * 0.3, -hw, hl * 0.15, -hw);
  g.bezierCurveTo(hl * 0.62, -hw, hl, -hw * 0.56, hl, 0);
  g.bezierCurveTo(hl, hw * 0.56, hl * 0.62, hw, hl * 0.15, hw);
  g.bezierCurveTo(-hl * 0.3, hw, -hl * 0.72, hw * 0.72, -hl, 0);
  g.closePath();
}

// Upper-left light direction expressed in a frame rotated by `ang`.
const localLight = (ang) => [
  -0.7071 * (Math.cos(ang) + Math.sin(ang)),
  0.7071 * (Math.sin(ang) - Math.cos(ang)),
];

// A glossy dark seed (kiwi, watermelon). s: {x, y, ang, len, wid}; +x of the frame points
// along `ang`, the pointed end faces the opposite way.
function drawDarkSeed(g, s, tone) {
  const hl = s.len / 2, hw = s.wid / 2;
  const [lx, ly] = localLight(s.ang);
  g.save();
  g.translate(s.x, s.y);
  g.rotate(s.ang);
  const body = g.createRadialGradient(lx * hl * 0.35, ly * hw * 0.45, 0, 0, 0, hl * 1.05);
  body.addColorStop(0, tone[0]);
  body.addColorStop(0.35, tone[1]);
  body.addColorStop(0.78, tone[2]);
  body.addColorStop(1, tone[3]);
  teardrop(g, hl, hw);
  g.fillStyle = body;
  g.fill();
  // broad soft sheen on the lit flank + a crisp wet glint
  const sx = lx * hl * 0.3, sy = ly * hw * 0.5;
  const sheen = g.createRadialGradient(sx, sy, 0, sx, sy, hl * 0.55);
  sheen.addColorStop(0, 'rgba(255,255,240,0.22)');
  sheen.addColorStop(1, 'rgba(255,255,240,0)');
  g.fillStyle = sheen;
  teardrop(g, hl, hw);
  g.fill();
  const hx = lx * hl * 0.36, hy = ly * hw * 0.5, hr = Math.max(0.6, hl * 0.2);
  const hi = g.createRadialGradient(hx, hy, 0, hx, hy, hr);
  hi.addColorStop(0, 'rgba(255,255,250,0.95)');
  hi.addColorStop(0.35, 'rgba(255,255,250,0.55)');
  hi.addColorStop(1, 'rgba(255,255,250,0)');
  g.fillStyle = hi;
  ellipse(g, hx, hy, hr, hr * 0.7, 0);
  g.fill();
  g.restore();
}

// Soft layer of shapes, blurred and composited onto ctx with a blend mode.
function softLayer(ctx, S, radius, mode, alpha, draw) {
  const layer = makeCanvas(S, S);
  draw(layer.getContext('2d'));
  ctx.save();
  ctx.globalCompositeOperation = mode;
  ctx.globalAlpha = alpha;
  ctx.drawImage(blurredCopy(layer, radius), 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Kiwi slice (hero)
// ---------------------------------------------------------------------------

function paintKiwi(S) {
  const rand = mulberry32(0x6b697769);
  const NT = valueNoiseTable();
  const px1 = S / 640; // one "design pixel"
  const cx = S * 0.5, cy = S * 0.5, R = S * 0.437;
  const AY = 0.935, rot = -0.42, cr = Math.cos(rot), sr = Math.sin(rot); // slightly oval, tilted

  const edgeT = angularNoise(rand, [[5, 0.011], [11, 0.006], [29, 0.0025]]);
  const skinT = angularNoise(rand, [[9, 0.003], [37, 0.002]]);
  const coreT = angularNoise(rand, [[5, 0.08], [11, 0.05], [27, 0.025]]);
  const toneT = angularNoise(rand, [[18, 0.045], [47, 0.03]]);
  const fibres = angularMips(ridgedNoise(rand, [[560, 0.55, 7], [250, 0.45, 5], [96, 0.3, 3]]));

  // Locules: wedge-shaped translucent chambers around the core that hold the seeds,
  // separated by pale septa (the white rays radiating from the core).
  const NL = 36;
  const lc = new Float32Array(NL), rI = new Float32Array(NL), rO = new Float32Array(NL), tone = new Float32Array(NL);
  for (let k = 0; k < NL; k++) {
    lc[k] = (k + 0.5 + (rand() - 0.5) * 0.4) / NL;
    rI[k] = 0.215 + rand() * 0.03;
    rO[k] = 0.5 + rand() * 0.07;
    tone[k] = 0.9 + rand() * 0.2;
  }
  const locK = new Uint8Array(AN), locA = new Float32Array(AN), locW = new Float32Array(AN);
  for (let i = 0; i < AN; i++) {
    const t = (i + 0.5) / AN;
    let best = 0, bd = 1;
    for (let k = 0; k < NL; k++) {
      let d = t - lc[k];
      d -= Math.round(d);
      if (Math.abs(d) < Math.abs(bd)) { bd = d; best = k; }
    }
    const nb = bd >= 0 ? (best + 1) % NL : (best + NL - 1) % NL;
    let gap = lc[nb] - lc[best];
    gap = Math.abs(gap - Math.round(gap));
    locK[i] = best;
    locW[i] = gap / 2; // half-width (turns)
    locA[i] = clamp01(1 - Math.abs(bd) / locW[i]); // 1 at the locule centre, 0 on the septum
  }

  // Flesh by radius: pale round the core, glassy in the seed ring, bright just outside it,
  // deeper green towards the skin.
  const [FR, FG, FB] = ramp([
    [0.0, 0.8, 0.86, 0.45], [0.2, 0.74, 0.83, 0.38], [0.28, 0.58, 0.76, 0.18], [0.4, 0.5, 0.72, 0.1],
    [0.56, 0.54, 0.75, 0.13], [0.72, 0.47, 0.71, 0.09], [0.88, 0.38, 0.63, 0.06], [0.95, 0.33, 0.57, 0.05],
    [1.0, 0.3, 0.52, 0.05],
  ]);
  const FN = FR.length - 1;

  // Per-radius profiles, tabulated once instead of evaluated per pixel.
  const fibLevel = new Float32Array(FN + 1), fibFade = new Float32Array(FN + 1), sepFade = new Float32Array(FN + 1);
  const rimK = new Float32Array(FN + 1), streakK = new Float32Array(FN + 1);
  for (let i = 0; i <= FN; i++) {
    const rn = i / FN;
    fibLevel[i] = mipLevel(AN / (TAU * Math.max(rn, 0.02) * R)); // radial lines converge: pre-filter
    fibFade[i] = smoothstep(0.2, 0.5, rn) * (1 - 0.5 * smoothstep(0.75, 0.95, rn));
    sepFade[i] = smoothstep(0.14, 0.22, rn) * (0.25 + 0.75 * (1 - smoothstep(0.5, 0.66, rn))) * (1 - smoothstep(0.8, 0.95, rn)) * 0.7;
    rimK[i] = 1 - 0.08 * smoothstep(0.6, 1, rn);
    streakK[i] = 0.09 * smoothstep(0.3, 0.6, rn);
  }
  // Septum brightness by distance (px) and locule lens width by radial position.
  const sepLUT = new Float32Array(257), lensLUT = new Float32Array(257);
  for (let i = 0; i <= 256; i++) {
    const d = i / 8;
    sepLUT[i] = Math.exp(-d * d * 0.5) * 0.75 + Math.exp(-d * 0.25) * 0.25;
    lensLUT[i] = 0.92 * Math.pow(Math.sin((Math.PI * i) / 256), 0.35);
  }

  const canvas = makeCanvas(S, S), ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S), D = img.data;
  // One row per call: small functions get optimised by the JIT much sooner than one huge loop.
  const shadeRow = (y) => {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - cx;
      const u = dx * cr + dy * sr, v = (dy * cr - dx * sr) / AY;
      const rr = Math.sqrt(u * u + v * v) / R;
      if (rr > 1.06) continue;
      let turn = Math.atan2(v, u) / TAU;
      if (turn < 0) turn += 1;
      const e = 1 + lookup(edgeT, turn);
      const rn = rr / e;
      const alpha = clamp01((1 - rn) * R * e + 0.5);
      if (alpha <= 0) continue;
      const fi = Math.min(FN, (rn * FN) | 0);

      // Fibres: fine radial streaks, meandering slightly and broken up along the radius.
      const ft = turn + (vnoise(NT, (x * 0.03) / px1, (y * 0.03) / px1) - 0.5) * 0.004;
      const fibRaw = lookupMip(fibres, ft, fibLevel[fi]);
      const fib = fibRaw * (0.3 + 0.95 * vnoise(NT, rn * 20, ft * 256));

      let r = FR[fi], g = FG[fi], b = FB[fi];

      // Locule chambers: deeper, glassier green, lens-shaped in the radial direction.
      const li = Math.floor(ft * AN) & AMASK;
      const k = locK[li], la = locA[li];
      const lt = (rn - rI[k]) / (rO[k] - rI[k]);
      let loc = 0;
      if (lt > 0 && lt < 1) {
        // ragged chamber walls; the outer end dissolves into the flesh
        const wall = la - 1 + lensLUT[(lt * 256) | 0] + (vnoise(NT, rn * 26, ft * 256) - 0.5) * 0.2;
        loc = smoothstep(-0.28, 0.28, wall) * (1 - 0.55 * smoothstep(0.6, 1, lt)) * smoothstep(0, 0.3, la);
        const tn = tone[k] * (1.04 - 0.1 * lt), m = loc * 0.7;
        r = mix(r, 0.36 * tn, m);
        g = mix(g, 0.6 * tn, m);
        b = mix(b, 0.04 * tn, m);
      }

      // Septa: pale rays from the core through the seed ring, fading into the outer flesh.
      if (rn > 0.14 && rn < 0.95) {
        const sepPx = (la * locW[li] * TAU * rn * R) / px1;
        const sep = sepLUT[Math.min(256, (sepPx * 8) | 0)] * sepFade[fi];
        r = mix(r, 0.82, sep);
        g = mix(g, 0.88, sep);
        b = mix(b, 0.55, sep);
      }

      // Fibres brighten the flesh (less inside the glassy locules).
      const fa = fib * fibFade[fi] * (1 - 0.6 * loc);
      r += fa * 0.12;
      g += fa * 0.11;
      b += fa * 0.04;

      // Core: creamy, fairly defined edge, pushed out a little along each septum.
      let core = 0;
      const uc = u / R, vc = v / (R * 0.7);
      const rc = Math.sqrt(uc * uc + vc * vc);
      if (rc < 0.32) {
        const q = 1 - la, q4 = q * q * q * q;
        const cR = 0.215 * (1 + lookup(coreT, turn)) + 0.03 * q4 * q4 * q4;
        core = 1 - smoothstep(cR - 0.025, cR + 0.006, rc);
        if (core > 0) {
          const ct = clamp01(rc / cR), ct3 = ct * ct * ct;
          const stri = (1 - 0.06 * fibRaw) * (0.97 + 0.05 * vnoise(NT, (x * 0.5) / px1, (y * 0.5) / px1));
          r = mix(r, mix(0.96, 0.87, ct3) * stri, core);
          g = mix(g, mix(0.95, 0.9, ct3) * stri, core);
          b = mix(b, mix(0.8, 0.6, ct3) * stri, core);
        }
      }

      // Pale lime band under the skin, then the skin itself (dark inner edge).
      let skin = 0;
      if (rn > 0.93) {
        const skinW = 0.022 + lookup(skinT, turn);
        const sIn = 1 - skinW;
        const band = smoothstep(sIn - 0.035, sIn - 0.003, rn) * 0.6;
        r = mix(r, 0.64, band);
        g = mix(g, 0.76, band);
        b = mix(b, 0.3, band);
        skin = smoothstep(sIn - 0.0025, sIn + 0.0025, rn);
        if (skin > 0) {
          const st = smoothstep(0, 0.6, (rn - sIn) / skinW);
          const m = 0.8 + 0.4 * vnoise(NT, (x * 0.45) / px1, (y * 0.45) / px1);
          r = mix(r, mix(0.22, 0.42, st) * m, skin);
          g = mix(g, mix(0.17, 0.29, st) * m, skin);
          b = mix(b, mix(0.06, 0.14, st) * m, skin);
        }
      }

      // Texture: radial streak grain (fine in angle, long in radius), pixel grain, tonal sectors.
      const streak = vnoise(NT, (rn * R) / (10 * px1), ft * 512) - 0.5;
      const grain = 0.975 + 0.05 * NT[(((y * 3) & 255) << 8) | ((x * 5 + 50) & 255)];
      const toneK = (1 + lookup(toneT, turn) * (1 - core)) * (1 + streak * streakK[fi] * (1 - skin));

      // Lighting: brighter towards the upper-left, gentle falloff at the rim, wet sheen.
      const lx = dx / R, ly = dy / R;
      const light = (1 - 0.05 * (lx + ly)) * rimK[fi];
      const hx = lx + 0.3, hy = ly + 0.36;
      const along = (hx - hy) * 0.7071, across = (hx + hy) * 0.7071;
      const sx = along * along * 10 + across * across * 40;
      const sheen = sx < 9 ? Math.exp(-sx) * (0.25 + 0.9 * fib) * 0.1 * (1 - skin) : 0;

      const kk = light * grain * toneK;
      const o = (y * S + x) * 4;
      D[o] = (r * kk + sheen) * 255;
      D[o + 1] = (g * kk + sheen) * 255;
      D[o + 2] = (b * kk + sheen * 0.9) * 255;
      D[o + 3] = alpha * 255;
    }
  };
  for (let y = 0; y < S; y++) shadeRow(y);
  ctx.putImageData(img, 0, 0);

  // Map (normalised radius, turn) back to canvas pixels.
  const point = (rn, turn) => {
    const rr = rn * (1 + lookup(edgeT, turn)) * R, th = turn * TAU;
    const u = rr * Math.cos(th), v = rr * Math.sin(th) * AY;
    return { x: cx + u * cr - v * sr, y: cy + u * sr + v * cr };
  };

  // Seeds: two staggered columns per locule → ~120 seeds in ragged rings, oriented radially.
  const seeds = [];
  for (let k = 0; k < NL; k++) {
    const span = rO[k] - rI[k];
    for (const side of [-1, 1]) {
      const rows = rand() < 0.45 ? 3 : 2;
      for (let j = 0; j < rows; j++) {
        if (rand() < 0.14) continue;
        const t = (j + 0.5 + side * 0.18 + (rand() - 0.5) * 0.4) / rows;
        const rn = rI[k] + span * (0.14 + 0.7 * t);
        const p = point(rn, lc[k] + (side * (0.42 + rand() * 0.2) + (rand() - 0.5) * 0.15) * (0.5 / NL));
        const len = S * (0.019 + 0.01 * rand()) * (0.85 + 0.3 * t);
        seeds.push({
          x: p.x, y: p.y, len, wid: len * (0.42 + 0.1 * rand()),
          ang: Math.atan2(p.y - cy, p.x - cx) + (rand() - 0.5) * 0.6,
        });
      }
    }
  }
  // Each seed sits in a sliver of clear gel with a darker rim.
  softLayer(ctx, S, 3 * px1, 'screen', 0.2, (g) => {
    g.fillStyle = 'rgb(170,215,90)';
    for (const s of seeds) { ellipse(g, s.x, s.y, s.len * 0.8, s.wid * 1.3, s.ang); g.fill(); }
  });
  softLayer(ctx, S, 1.2 * px1, 'multiply', 0.5, (g) => {
    g.fillStyle = 'rgb(30,70,0)';
    for (const s of seeds) { ellipse(g, s.x, s.y, s.len * 0.6, s.wid * 0.72, s.ang); g.fill(); }
  });
  const seedTone = ['rgb(62,44,26)', 'rgb(28,19,11)', 'rgb(11,8,5)', 'rgb(5,4,2)'];
  for (const s of seeds) drawDarkSeed(ctx, s, seedTone);

  // Fuzzy skin: a soft velvet haze, then dense, short, fine hairs (some lying across the skin).
  const rimPath = new Path2D();
  for (let i = 0; i <= 360; i++) {
    const p = point(1.004, i / 360);
    if (i === 0) rimPath.moveTo(p.x, p.y); else rimPath.lineTo(p.x, p.y);
  }
  softLayer(ctx, S, 2.5 * px1, 'source-over', 0.5, (g) => {
    g.lineWidth = 4 * px1;
    g.strokeStyle = 'rgb(122,92,56)';
    g.stroke(rimPath);
  });
  const hairCols = ['rgba(64,42,20,0.6)', 'rgba(98,70,38,0.5)', 'rgba(140,108,68,0.45)', 'rgba(182,150,104,0.35)'];
  const hairs = hairCols.map(() => new Path2D());
  const nHair = Math.round(9000 * px1);
  for (let i = 0; i < nHair; i++) {
    const p = point(0.978 + rand() * 0.024, rand());
    let nx = p.x - cx, ny = p.y - cy;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const dev = (rand() - 0.5) * 2.4, c = Math.cos(dev), s = Math.sin(dev);
    const hx = nx * c - ny * s, hy = nx * s + ny * c;
    const len = S * (0.003 + 0.007 * rand() * rand());
    const bend = (rand() - 0.5) * len * 0.9;
    const ex = p.x + hx * len, ey = p.y + hy * len;
    const pick = rand(), path = hairs[pick < 0.2 ? 0 : pick < 0.55 ? 1 : pick < 0.85 ? 2 : 3];
    path.moveTo(p.x, p.y);
    path.quadraticCurveTo((p.x + ex) / 2 - hy * bend, (p.y + ey) / 2 + hx * bend, ex, ey);
  }
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(0.5, 0.65 * px1);
  hairs.forEach((p, i) => { ctx.strokeStyle = hairCols[i]; ctx.stroke(p); });
  return canvas;
}

// ---------------------------------------------------------------------------
// Strawberry
// ---------------------------------------------------------------------------

function strawberryGeometry(S) {
  const cx = S * 0.5, top = S * 0.12, H = S * 0.82, hw = S * 0.415;
  const P = (x, y) => [cx + x * hw, top + y * H];
  const berry = new Path2D();
  berry.moveTo(...P(0, 0.04));
  berry.bezierCurveTo(...P(0.28, -0.035), ...P(0.78, -0.03), ...P(0.95, 0.16));
  berry.bezierCurveTo(...P(1.04, 0.3), ...P(0.98, 0.52), ...P(0.7, 0.76));
  berry.bezierCurveTo(...P(0.48, 0.93), ...P(0.17, 1.0), ...P(0.01, 1.0));
  berry.bezierCurveTo(...P(-0.15, 1.0), ...P(-0.45, 0.93), ...P(-0.67, 0.77));
  berry.bezierCurveTo(...P(-0.96, 0.53), ...P(-1.02, 0.3), ...P(-0.93, 0.16));
  berry.bezierCurveTo(...P(-0.77, -0.03), ...P(-0.28, -0.035), ...P(0, 0.04));
  berry.closePath();
  return { berry, cx, top, H, hw, calyx: { x: cx + S * 0.004, y: top + S * 0.03 } };
}

// A sepal: pointed leaf along a drooping quadratic midline.
function leafShape(bx, by, ang, len, widthK, droop) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const tx = bx + dx * len, ty = by + dy * len + droop;
  const qx = bx + dx * len * 0.55, qy = by + dy * len * 0.55 - droop * 0.2;
  const at = (t) => [
    (1 - t) * (1 - t) * bx + 2 * (1 - t) * t * qx + t * t * tx,
    (1 - t) * (1 - t) * by + 2 * (1 - t) * t * qy + t * t * ty,
  ];
  const left = [], right = [];
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const t = i / N, [x, y] = at(t);
    const ddx = 2 * (1 - t) * (qx - bx) + 2 * t * (tx - qx), ddy = 2 * (1 - t) * (qy - by) + 2 * t * (ty - qy);
    const l = Math.hypot(ddx, ddy) || 1;
    const w = len * widthK * 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.85) * (1 - 0.2 * t);
    left.push([x - (ddy / l) * w, y + (ddx / l) * w]);
    right.push([x + (ddy / l) * w, y - (ddx / l) * w]);
  }
  const outline = new Path2D(), half = new Path2D(), rib = new Path2D(), veins = new Path2D();
  outline.moveTo(bx, by);
  for (const p of left) outline.lineTo(p[0], p[1]);
  for (let i = right.length - 1; i >= 0; i--) outline.lineTo(right[i][0], right[i][1]);
  outline.closePath();
  // one half of the leaf (for a folded, two-tone look)
  half.moveTo(bx, by);
  for (const p of right) half.lineTo(p[0], p[1]);
  for (let i = N; i >= 0; i--) half.lineTo(...at(i / N));
  half.closePath();
  rib.moveTo(bx, by);
  for (let i = 1; i <= Math.round(N * 0.85); i++) rib.lineTo(...at(i / N));
  // lateral veins angled towards the tip
  for (let i = 3; i < N - 2; i += 2) {
    const m = at(i / N);
    for (const side of [left, right]) {
      const e = side[Math.min(N, i + 2)];
      veins.moveTo(m[0], m[1]);
      veins.quadraticCurveTo((m[0] + e[0]) / 2 + dx * len * 0.03, (m[1] + e[1]) / 2 + dy * len * 0.03, m[0] + (e[0] - m[0]) * 0.85, m[1] + (e[1] - m[1]) * 0.85);
    }
  }
  return { outline, half, rib, veins, tip: [tx, ty] };
}

function paintStrawberry(S) {
  const rand = mulberry32(0x57a4b3);
  const NT = valueNoiseTable();
  const px1 = S / 640, n = S * S;
  const geo = strawberryGeometry(S);
  const alpha = rasterAlpha(S, (g) => g.fill(geo.berry));

  // Height field: rounded dome from the distance to the silhouette.
  const dist = distanceInside(alpha, S, S);
  let dmax = 1;
  for (let i = 0; i < n; i++) dmax = Math.max(dmax, dist[i]);
  let h = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, dist[i] / dmax);
    h[i] = Math.sqrt(t * (2 - t));
  }
  h = boxBlur(h, S, S, Math.max(1, Math.round(S / 70)), 2);
  const depth = dmax * 0.85;
  for (let i = 0; i < n; i++) h[i] *= depth;
  const grad = (x, y) => {
    const i = y * S + x;
    return [(h[i + 1] - h[i - 1]) * 0.5, (h[i + S] - h[i - S]) * 0.5];
  };

  // Achenes: Poisson-disc darts, packed tighter where the surface turns away (foreshortening).
  const sp = S * 0.045, cell = sp * 0.3, gw = Math.ceil(S / cell);
  const grid = new Int32Array(gw * gw).fill(-1);
  const pts = [];
  for (let tries = 0; tries < 9000; tries++) {
    const x = 2 + rand() * (S - 4), y = 2 + rand() * (S - 4);
    const xi = x | 0, yi = y | 0, i = yi * S + xi;
    if (alpha[i] < 0.99 || dist[i] < sp * 0.15) continue;
    const [gx, gy] = grad(xi, yi);
    const nz = 1 / Math.sqrt(gx * gx + gy * gy + 1);
    const minD = sp * (0.42 + 0.58 * nz);
    const cxi = Math.floor(x / cell), cyi = Math.floor(y / cell), reach = Math.ceil(minD / cell);
    let ok = true;
    for (let oy = -reach; oy <= reach && ok; oy++) {
      for (let ox = -reach; ox <= reach; ox++) {
        const qx = cxi + ox, qy = cyi + oy;
        if (qx < 0 || qy < 0 || qx >= gw || qy >= gw) continue;
        const q = grid[qy * gw + qx];
        if (q >= 0 && Math.hypot(pts[q].x - x, pts[q].y - y) < minD) { ok = false; break; }
      }
    }
    if (!ok) continue;
    grid[cyi * gw + cxi] = pts.length;
    pts.push({ x, y, nz, gx, gy, yN: (y - geo.top) / geo.H });
  }

  // Carve a foreshortened pit for every achene into the height field.
  const pit = new Float32Array(n);
  for (const p of pts) {
    const f = Math.max(0.35, p.nz), gl = Math.hypot(p.gx, p.gy) || 1;
    const ux = p.gx / gl, uy = p.gy / gl;
    const sig = sp * 0.2, dep = sp * 0.12, rad = Math.ceil(sig * 2.6);
    const x0 = p.x | 0, y0 = p.y | 0;
    for (let oy = -rad; oy <= rad; oy++) {
      for (let ox = -rad; ox <= rad; ox++) {
        const along = (ox * ux + oy * uy) / f, across = -ox * uy + oy * ux;
        const w = Math.exp(-(along * along + across * across) / (2 * sig * sig));
        if (w < 0.01) continue;
        const i = (y0 + oy) * S + x0 + ox;
        h[i] -= dep * w;
        pit[i] = Math.max(pit[i], w);
      }
    }
  }

  // Shade: glossy red with lighter shoulders, deeper tip, red subsurface glow at the rim.
  const L = normalize3(-0.5, -0.62, 0.6), Hv = normalize3(L[0], L[1], L[2] + 1);
  const canvas = makeCanvas(S, S), ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S), D = img.data;
  const shadeRow = (y) => {
    for (let x = 1; x < S - 1; x++) {
      const i = y * S + x, a = alpha[i];
      if (a <= 0) continue;
      const gx = (h[i + 1] - h[i - 1]) * 0.5, gy = (h[i + S] - h[i - S]) * 0.5;
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      const nx = -gx * inv, ny = -gy * inv, nz = inv;
      const diff = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const nh = Math.max(0, nx * Hv[0] + ny * Hv[1] + nz * Hv[2]);
      const yN = (y - geo.top) / geo.H;
      const m1 = vnoise(NT, (x * 0.025) / px1, (y * 0.025) / px1), m2 = vnoise(NT, (x * 0.09) / px1 + 40, (y * 0.09) / px1);
      let ar = 0.78 * (0.9 + 0.2 * m1), ag = 0.055 * (0.7 + 0.6 * m2), ab = 0.07;
      const sh = (1 - smoothstep(0.02, 0.24, yN)) * 0.55;
      ar = mix(ar, 0.92, sh); ag = mix(ag, 0.34, sh); ab = mix(ab, 0.14, sh);
      const tp = smoothstep(0.65, 1, yN) * 0.45;
      ar = mix(ar, 0.55, tp); ag = mix(ag, 0.02, tp); ab = mix(ab, 0.06, tp);
      const pk = 1 - 0.35 * pit[i];
      const shade = (0.3 + 0.85 * diff) * pk;
      const sss = (1 - nz) * (1 - nz) * 0.25;
      const spec = Math.pow(nh, 60) * 0.75 + Math.pow(nh, 12) * 0.07;
      const o = i * 4;
      D[o] = (ar * shade + sss * 0.9 + spec) * 255;
      D[o + 1] = (ag * shade + sss * 0.05 + spec * 0.95) * 255;
      D[o + 2] = (ab * shade + sss * 0.08 + spec * 0.92) * 255;
      D[o + 3] = a * 255;
    }
  };
  for (let y = 1; y < S - 1; y++) shadeRow(y);
  ctx.putImageData(img, 0, 0);

  // Achenes sitting in their pits: a shadow, a golden seed, a tiny highlight.
  const seeds = pts.map((p) => {
    const gl = Math.hypot(p.gx, p.gy) || 1;
    const fan = ((p.x - geo.cx) / geo.hw) * 0.9 * (1 - p.yN);
    return {
      ...p, gAng: gl > 1e-4 ? Math.atan2(p.gy, p.gx) : 0, sAng: Math.atan2(1, fan),
      f: Math.max(0.35, p.nz), len: sp * 0.38 * (0.85 + 0.3 * rand()),
    };
  });
  const inFrame = (s, draw) => {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.gAng);
    ctx.scale(s.f, 1);
    ctx.rotate(s.sAng - s.gAng);
    draw();
    ctx.restore();
  };
  ctx.fillStyle = 'rgba(70,0,6,0.45)';
  for (const s of seeds) {
    inFrame(s, () => { ellipse(ctx, 0.9 * px1, 0.4 * px1, s.len * 0.6, s.len * 0.36, 0); ctx.fill(); });
  }
  for (const s of seeds) {
    const green = 1 - smoothstep(0.05, 0.3, s.yN), red = smoothstep(0.65, 1, s.yN);
    const cr = 0.95 - 0.1 * green - 0.05 * red, cg = 0.78 + 0.04 * green - 0.2 * red, cb = 0.3 + 0.05 * green - 0.1 * red;
    inFrame(s, () => {
      const gr = ctx.createRadialGradient(-s.len * 0.12, -s.len * 0.08, 0, 0, 0, s.len * 0.55);
      gr.addColorStop(0, rgb(cr, cg + 0.08, cb + 0.1));
      gr.addColorStop(0.6, rgb(cr * 0.85, cg * 0.78, cb * 0.6));
      gr.addColorStop(1, rgb(cr * 0.6, cg * 0.45, cb * 0.3));
      ctx.fillStyle = gr;
      ellipse(ctx, 0, 0, s.len * 0.5, s.len * 0.29, 0);
      ctx.fill();
    });
  }
  ctx.fillStyle = 'rgba(255,255,240,0.75)';
  for (const s of seeds) {
    ellipse(ctx, s.x - s.len * 0.14 * s.f, s.y - s.len * 0.12, s.len * 0.1, s.len * 0.07, -0.6);
    ctx.fill();
  }

  // Calyx: back sepals, stem, front sepals; with a soft shadow on the berry.
  const C = geo.calyx;
  const sepals = [
    // angle (deg; 0 = right, 90 = down), length (×S), width (×length), droop (×S), front
    [-160, 0.15, 0.32, -0.01, false], [-118, 0.085, 0.4, 0, false], [-64, 0.09, 0.38, 0, false],
    [-22, 0.155, 0.32, -0.01, false], [177, 0.215, 0.27, 0.07, true], [145, 0.185, 0.3, 0.05, true],
    [110, 0.14, 0.36, 0.03, true], [73, 0.15, 0.34, 0.03, true], [37, 0.195, 0.29, 0.05, true],
    [4, 0.215, 0.27, 0.07, true],
  ].map(([deg, len, wk, droop, front]) => ({
    front, deg, shape: leafShape(C.x, C.y, (deg * Math.PI) / 180, len * S, wk, droop * S),
  }));
  // soft cast shadow + tight contact shadow of the front sepals on the berry
  for (const [blur, off, opacity] of [[7, 13, 0.6], [2, 3, 0.55]]) {
    softLayer(ctx, S, blur * px1, 'multiply', opacity, (g) => {
      g.save();
      g.clip(geo.berry);
      g.translate(off * 0.65 * px1, off * px1);
      g.fillStyle = 'rgb(60,0,0)';
      for (const s of sepals) if (s.front) g.fill(s.shape.outline);
      g.restore();
    });
  }
  const drawSepal = (s) => {
    const { outline, half, rib, veins, tip } = s.shape;
    const k = (s.front ? 1 : 0.72) * (1 + 0.12 * Math.cos(((s.deg + 135) * Math.PI) / 180));
    const lg = ctx.createLinearGradient(C.x, C.y, tip[0], tip[1]);
    lg.addColorStop(0, rgb(0.5 * k, 0.66 * k, 0.24 * k));
    lg.addColorStop(0.45, rgb(0.3 * k, 0.54 * k, 0.15 * k));
    lg.addColorStop(1, rgb(0.2 * k, 0.42 * k, 0.1 * k));
    ctx.fillStyle = lg;
    ctx.fill(outline);
    ctx.fillStyle = 'rgba(0,30,0,0.16)';
    ctx.fill(half);
    ctx.save();
    ctx.clip(outline);
    ctx.lineWidth = 0.7 * px1;
    ctx.strokeStyle = 'rgba(190,225,140,0.28)';
    ctx.stroke(veins);
    ctx.lineWidth = 4 * px1;
    ctx.strokeStyle = 'rgba(10,40,5,0.3)'; // darker, thinner leaf margin
    ctx.stroke(outline);
    ctx.restore();
    ctx.lineWidth = 1.2 * px1;
    ctx.strokeStyle = 'rgba(200,228,150,0.45)';
    ctx.stroke(rib);
    ctx.lineWidth = 0.8 * px1;
    ctx.strokeStyle = 'rgba(20,50,12,0.55)';
    ctx.stroke(outline);
  };
  for (const s of sepals) if (!s.front) drawSepal(s);

  const stem = new Path2D();
  const stemTop = [C.x + S * 0.02, C.y - S * 0.1];
  stem.moveTo(C.x, C.y + S * 0.01);
  stem.quadraticCurveTo(C.x - S * 0.006, C.y - S * 0.06, stemTop[0], stemTop[1]);
  const sg = ctx.createLinearGradient(C.x - S * 0.02, 0, C.x + S * 0.03, 0);
  sg.addColorStop(0, rgb(0.3, 0.46, 0.15));
  sg.addColorStop(0.35, rgb(0.56, 0.7, 0.3));
  sg.addColorStop(1, rgb(0.17, 0.3, 0.08));
  ctx.lineCap = 'butt';
  ctx.lineWidth = S * 0.036;
  ctx.strokeStyle = sg;
  ctx.stroke(stem);
  ctx.fillStyle = rgb(0.72, 0.78, 0.48);
  ellipse(ctx, stemTop[0], stemTop[1], S * 0.018, S * 0.008, 0.3);
  ctx.fill();
  ctx.lineWidth = 0.8 * px1;
  ctx.strokeStyle = 'rgba(40,70,20,0.6)';
  ctx.stroke();
  for (const s of sepals) if (s.front) drawSepal(s);
  return canvas;
}

// ---------------------------------------------------------------------------
// Orange slice
// ---------------------------------------------------------------------------

function paintOrange(S) {
  const rand = mulberry32(0x0a4e6e);
  const NT = valueNoiseTable(), W = worleyTile();
  const px1 = S / 640, cx = S * 0.5, cy = S * 0.5, R = S * 0.447, AY = 0.975;
  const edgeT = angularNoise(rand, [[4, 0.006], [9, 0.004], [23, 0.002]]);
  const peelT = angularNoise(rand, [[7, 0.006], [19, 0.003]]);

  // Segments: 11 wedges between membranes; a ∈ −1..1 across each wedge.
  const NS = 11, bounds = [];
  for (let k = 0; k < NS; k++) bounds.push((k + (rand() - 0.5) * 0.3) / NS + 0.013);
  const segK = new Uint8Array(AN), segA = new Float32Array(AN), segW = new Float32Array(AN);
  for (let i = 0; i < AN; i++) {
    const t = (i + 0.5) / AN;
    for (let k = 0; k < NS; k++) {
      const w = (((bounds[(k + 1) % NS] - bounds[k]) % 1) + 1) % 1;
      const rel = (((t - bounds[k]) % 1) + 1) % 1;
      if (rel < w) {
        segK[i] = k;
        segA[i] = (rel / w) * 2 - 1;
        segW[i] = w / 2;
        break;
      }
    }
  }

  const canvas = makeCanvas(S, S), ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S), D = img.data;
  const shadeRow = (y) => {
    const dy = y + 0.5 - cy, v = dy / AY;
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - cx;
      const rr = Math.sqrt(dx * dx + v * v) / R;
      if (rr > 1.05) continue;
      let turn = Math.atan2(v, dx) / TAU;
      if (turn < 0) turn += 1;
      const e = 1 + lookup(edgeT, turn), rn = rr / e;
      const alpha = clamp01((1 - rn) * R * e + 0.5);
      if (alpha <= 0) continue;

      const si = Math.floor(turn * AN) & AMASK;
      const k = segK[si], a = segA[si];
      const membPx = ((1 - Math.abs(a)) * segW[si] * TAU * rn * R) / px1;
      const peelIn = 0.935 + lookup(peelT, turn), pithIn = peelIn - 0.06;
      const rOut = pithIn - 0.004 - 0.05 * Math.pow(Math.abs(a), 5);
      const inSeg = smoothstep(1.4, 2.8, membPx) * (1 - smoothstep(rOut - 0.007, rOut, rn)) * smoothstep(0.04, 0.075, rn);
      const lx = dx / R, ly = dy / R;
      const lightMask = Math.exp(-((lx + 0.35) ** 2 + (ly + 0.4) ** 2) * 4);

      // White pith between segments and under the peel.
      const pn = vnoise(NT, (x * 0.2) / px1, (y * 0.2) / px1);
      const toPeel = smoothstep(pithIn, peelIn, rn);
      let r = mix(0.99, 0.98, toPeel) * (0.97 + 0.03 * pn);
      let g = mix(0.93, 0.8, toPeel) * (0.97 + 0.03 * pn);
      let b = mix(0.8, 0.5, toPeel) * (0.96 + 0.04 * pn);
      let spark = 0;

      if (inSeg > 0) {
        // Juice vesicles: long spindle cells fanning out from the centre, reseeded per segment,
        // with thin translucent walls and a shadowed crease beside each wall.
        const wx = ((rn * R) / (38 * px1)) * WCELL + k * 41.3, wy = turn * WN * 5;
        const f1 = tile(W.f1, wx, wy), ed = tile(W.edge, wx, wy), cid = tileNearest(W.id, wx, wy);
        const body = 1 - smoothstep(0, 0.8, f1);
        const wallLine = 1 - smoothstep(0, 0.07, ed);
        const crease = 1 - smoothstep(0.04, 0.25, ed) - wallLine;
        const depthT = smoothstep(0.1, 0.85, rn);
        const vk = (0.9 + 0.14 * body + 0.1 * (cid - 0.5)) * (1 - 0.12 * crease);
        let vr = vk, vg = mix(0.62, 0.5, depthT) * vk * (0.92 + 0.14 * body), vb = mix(0.13, 0.04, depthT) * vk;
        vr = mix(vr, 1, wallLine * 0.4);
        vg = mix(vg, 0.82, wallLine * 0.4);
        vb = mix(vb, 0.5, wallLine * 0.4);
        const glow = Math.exp(-membPx / 5) * 0.35; // translucent glow along the segment membranes
        vr = mix(vr, 1, glow);
        vg = mix(vg, 0.85, glow);
        vb = mix(vb, 0.55, glow);
        r = mix(r, vr, inSeg);
        g = mix(g, vg, inSeg);
        b = mix(b, vb, inSeg);
        const b2 = body * body, b4 = b2 * b2;
        spark = b4 * b4 * inSeg * (0.06 + 0.4 * lightMask) * (cid > 0.3 ? 1 : 0.3);
      }

      // Peel: pale inner rind → orange flavedo with oil glands → darker outer edge.
      const peel = smoothstep(peelIn - 0.003, peelIn + 0.004, rn);
      if (peel > 0) {
        const t = clamp01((rn - peelIn) / (1 - peelIn)), t4 = smoothstep(0, 0.4, t);
        const f1p = tile(W.f1, (x / (5 * px1)) * WCELL, (y / (5 * px1)) * WCELL);
        const gland = (1 - smoothstep(0.12, 0.3, f1p)) * smoothstep(0.3, 0.6, t) * 0.5;
        const edge = smoothstep(0.7, 1, t);
        const pr = mix(mix(mix(0.99, 0.96, t4), 0.86, edge), 1, gland);
        const pg = mix(mix(mix(0.76, 0.52, t4), 0.4, edge), 0.66, gland);
        const pb = mix(mix(mix(0.36, 0.07, t4), 0.03, edge), 0.2, gland);
        r = mix(r, pr, peel);
        g = mix(g, pg, peel);
        b = mix(b, pb, peel);
      }

      const light = (1 - 0.05 * (lx + ly)) * (1 - 0.08 * smoothstep(0.7, 1, rn));
      const o = (y * S + x) * 4;
      D[o] = (r * light + spark) * 255;
      D[o + 1] = (g * light + spark) * 255;
      D[o + 2] = (b * light + spark * 0.85) * 255;
      D[o + 3] = alpha * 255;
    }
  };
  for (let y = 0; y < S; y++) shadeRow(y);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// Watermelon wedge
// ---------------------------------------------------------------------------

function paintWatermelon(S) {
  const rand = mulberry32(0x3e10a5);
  const NT = valueNoiseTable(), W = worleyTile();
  const px1 = S / 640;
  const ax = S * 0.5, ay = S * 0.06, R = S * 0.83, phi = 0.53, sliver = 0.05, rho = S * 0.018;
  const sliverAt = (an) => sliver * Math.pow(Math.max(0, Math.cos((an * Math.PI) / 2)), 0.7);

  // Wedge = sector (apex at the melon centre) plus a sliver of the outer skin seen below the cut.
  const shape = new Path2D();
  shape.moveTo(ax, ay);
  for (let j = 0; j <= 64; j++) {
    const an = 1 - (2 * j) / 64, ang = an * phi, rr = 1 + sliverAt(an);
    shape.lineTo(ax + R * rr * Math.sin(ang), ay + R * rr * Math.cos(ang));
  }
  shape.closePath();
  const alpha = rasterAlpha(S, (g) => {
    g.fill(shape);
    g.lineJoin = 'round';
    g.lineWidth = rho * 2;
    g.stroke(shape);
  });

  // Cut face from the melon centre (0) to the skin (1): deep red heart → pink → white → greens.
  const [MR, MG, MB] = ramp([
    [0.0, 0.8, 0.08, 0.14], [0.35, 0.87, 0.12, 0.18], [0.65, 0.93, 0.2, 0.23], [0.8, 0.97, 0.35, 0.34],
    [0.855, 0.97, 0.63, 0.57], [0.885, 0.91, 0.93, 0.76], [0.93, 0.84, 0.92, 0.66], [0.955, 0.64, 0.8, 0.42],
    [0.975, 0.34, 0.56, 0.19], [0.985, 0.1, 0.28, 0.08], [1.0, 0.08, 0.24, 0.07],
  ], 1024);
  const fibres = angularMips(ridgedNoise(rand, [[300, 0.5, 6], [120, 0.4, 4]]));

  const canvas = makeCanvas(S, S), ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S), D = img.data;
  const shadeRow = (y) => {
    for (let x = 0; x < S; x++) {
      const i = y * S + x, a = alpha[i];
      if (a <= 0) continue;
      const dx = x + 0.5 - ax, dy = y + 0.5 - ay;
      const rr = Math.hypot(dx, dy) / R, an = Math.atan2(dx, dy) / phi;
      let r, g, b;
      if (rr > 1) {
        // Outer skin curving away from the viewer: dark wavy stripes with feathered edges.
        const wob = (vnoise(NT, an * 1.6 + 11, 0.5) - 0.5) * 1.4 + (vnoise(NT, an * 4 + 3, rr * 6) - 0.5) * 0.5;
        const feather = (vnoise(NT, an * 45, rr * 70) - 0.5) * 0.9 + (vnoise(NT, an * 110 + 5, rr * 160) - 0.5) * 0.5;
        const stripe = smoothstep(-0.55, 0.05, Math.sin((an * 5 + wob) * TAU) * 0.8 + feather);
        const sv = clamp01((rr - 1) / Math.max(1e-3, sliverAt(an)));
        const k = (1 - 0.5 * sv) * (0.9 + 0.2 * vnoise(NT, x * 0.3, y * 0.3));
        r = mix(0.42, 0.07, stripe) * k;
        g = mix(0.6, 0.22, stripe) * k;
        b = mix(0.22, 0.07, stripe) * k;
      } else {
        const rp = rr + (vnoise(NT, an * 30, 3) - 0.5) * 0.006 + (vnoise(NT, an * 90, 7) - 0.5) * 0.004;
        const mi = Math.min(1023, Math.max(0, (rp * 1023) | 0));
        r = MR[mi];
        g = MG[mi];
        b = MB[mi];
        // Flesh: fine crystalline grain, juicy mottling, glitter and faint radial fibres.
        const flesh = 1 - smoothstep(0.8, 0.87, rr);
        if (flesh > 0) {
          const wx = (x / (4.5 * px1)) * WCELL, wy = (y / (4.5 * px1)) * WCELL;
          const f1 = tile(W.f1, wx, wy), cid = tileNearest(W.id, wx, wy);
          const mott = vnoise(NT, (x * 0.035) / px1, (y * 0.035) / px1) - 0.5;
          const fib = lookupMip(fibres, (an * phi) / TAU, mipLevel(AN / (TAU * Math.max(rr, 0.02) * R)));
          const k = mix(1, 0.95 + 0.07 * (1 - f1) + 0.07 * (cid - 0.5) + 0.12 * mott, flesh);
          const lx = dx / R, ly = dy / R - 0.5;
          const lightMask = Math.exp(-((lx + 0.2) ** 2 + (ly + 0.25) ** 2) * 8);
          const g1 = clamp01(1 - f1 * 2.5), g2 = g1 * g1;
          const glit = g2 * g2 * (cid > 0.72 ? 1 : 0) * (0.15 + 0.7 * lightMask) * flesh;
          r = r * k + fib * 0.06 * flesh + glit * 0.5;
          g = g * k + fib * 0.05 * flesh + glit * 0.45;
          b = b * k + fib * 0.05 * flesh + glit * 0.45;
        }
        const grain = 0.975 + 0.05 * NT[(((y * 3) & 255) << 8) | ((x * 5) & 255)];
        r *= grain;
        g *= grain;
        b *= grain;
      }
      const light = 1 - 0.06 * ((dx / R) * 1.6 + (dy / R - 0.5));
      const o = i * 4;
      D[o] = r * light * 255;
      D[o + 1] = g * light * 255;
      D[o + 2] = b * light * 255;
      D[o + 3] = a * 255;
    }
  };
  for (let y = 0; y < S; y++) shadeRow(y);
  ctx.putImageData(img, 0, 0);

  // Seeds scattered through a band around the heart, pointed end towards the melon centre.
  const seeds = [];
  for (let tries = 0; tries < 400 && seeds.length < 17; tries++) {
    const rr = 0.32 + rand() * 0.44, ang = (rand() * 2 - 1) * phi * (0.86 - 0.3 * (1 - rr));
    const x = ax + R * rr * Math.sin(ang), y = ay + R * rr * Math.cos(ang);
    if (seeds.some((q) => Math.hypot(q.x - x, q.y - y) < S * 0.075)) continue;
    const len = S * (0.032 + 0.014 * rand());
    seeds.push({ x, y, len, wid: len * 0.58, ang: Math.atan2(y - ay, x - ax) + (rand() - 0.5) * 0.7 });
  }
  softLayer(ctx, S, 3 * px1, 'multiply', 0.5, (g) => {
    g.fillStyle = 'rgb(90,0,10)';
    for (const s of seeds) { ellipse(g, s.x + 1.5 * px1, s.y + 2 * px1, s.len * 0.56, s.wid * 0.6, s.ang); g.fill(); }
  });
  // a few pale, immature seeds, clear of the dark ones
  ctx.fillStyle = 'rgba(255,236,215,0.7)';
  for (let j = 0; j < 7; j++) {
    const rr = 0.3 + rand() * 0.45, ang = (rand() * 2 - 1) * phi * 0.8;
    const x = ax + R * rr * Math.sin(ang), y = ay + R * rr * Math.cos(ang);
    if (seeds.some((q) => Math.hypot(q.x - x, q.y - y) < q.len)) continue;
    ellipse(ctx, x, y, S * 0.008, S * 0.004, Math.atan2(y - ay, x - ax));
    ctx.fill();
  }
  const seedTone = ['rgb(110,72,44)', 'rgb(52,32,20)', 'rgb(20,12,8)', 'rgb(10,6,4)'];
  for (const s of seeds) drawDarkSeed(ctx, s, seedTone);
  return canvas;
}

// ---------------------------------------------------------------------------
// Gummy bear
// ---------------------------------------------------------------------------

function paintGummy(S) {
  const NT = valueNoiseTable();
  const px1 = S / 640, c = S * 0.5, G = S * 1.19;
  // Ellipse primitives (units of G, relative to the centre): x, y, rx, ry, rotation, dome height.
  const parts = [
    [0, -0.19, 0.172, 0.148, 0, 0.9], // head
    [-0.128, -0.318, 0.06, 0.058, 0, 0.6], // ears
    [0.128, -0.318, 0.06, 0.058, 0, 0.6],
    [0, 0.07, 0.178, 0.2, 0, 1], // body
    [-0.168, -0.005, 0.052, 0.098, 0.6, 0.65], // arms
    [0.168, -0.005, 0.052, 0.098, -0.6, 0.65],
    [-0.105, 0.265, 0.085, 0.112, 0.28, 0.8], // legs
    [0.105, 0.265, 0.085, 0.112, -0.28, 0.8],
  ].map(([x, y, rx, ry, rot, hz]) => ({
    x: c + x * G, y: c + y * G, rx: rx * G, ry: ry * G, cos: Math.cos(rot), sin: Math.sin(rot), hz: hz * Math.min(rx, ry) * G,
  }));
  // Small reliefs: [x, y, rx, ry, height (×S)] — snout, nose, eyes, ear hollows, belly.
  const reliefs = [
    [0, -0.148, 0.075, 0.056, 0.026], [0, -0.17, 0.026, 0.019, 0.012],
    [-0.062, -0.222, 0.019, 0.019, -0.011], [0.062, -0.222, 0.019, 0.019, -0.011],
    [-0.128, -0.318, 0.031, 0.031, -0.011], [0.128, -0.318, 0.031, 0.031, -0.011],
    [0, 0.095, 0.105, 0.12, 0.016],
  ].map(([x, y, rx, ry, hgt]) => ({ x: c + x * G, y: c + y * G, rx: rx * G, ry: ry * G, h: hgt * S }));

  // Pass 1: smooth-union signed distance → silhouette, and a height field (pillowy edges +
  // per-part domes + reliefs).
  const k = S * 0.025, T = S * 0.08;
  const smax = (a, b) => {
    const hh = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.max(a, b) + (hh * hh * k) / 4;
  };
  const n = S * S, H = new Float32Array(n), A = new Float32Array(n);
  let Hmax = 1;
  const heightRow = (y) => {
    const py = y + 0.5;
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      let sd = -1e9, dome = -1e9;
      for (const p of parts) {
        const dx = px - p.x, dy = py - p.y;
        const lx = (dx * p.cos + dy * p.sin) / p.rx, ly = (-dx * p.sin + dy * p.cos) / p.ry;
        const q = Math.sqrt(lx * lx + ly * ly) + 1e-9;
        // first-order distance to the ellipse (px, positive inside)
        const gradLen = Math.sqrt((lx / p.rx) ** 2 + (ly / p.ry) ** 2) / q;
        sd = smax(sd, (1 - q) / (gradLen + 1e-9));
        dome = smax(dome, q < 1 ? p.hz * Math.sqrt(1 - q * q) : -(q - 1) * p.hz);
      }
      if (sd < -2) continue;
      const i = y * S + x;
      A[i] = clamp01(sd + 0.5);
      const t = clamp01(sd / T);
      let hgt = T * Math.sqrt(t * (2 - t)) * 0.75 + Math.max(0, dome) * 0.4;
      for (const r of reliefs) {
        const qx = (px - r.x) / r.rx, qy = (py - r.y) / r.ry, q2 = qx * qx + qy * qy;
        if (q2 < 1) hgt += r.h * (1 - q2) * (1 - q2);
      }
      hgt += (vnoise(NT, (x * 0.05) / px1, (y * 0.05) / px1) - 0.5) * 0.8 * px1; // tiny dents
      H[i] = hgt;
      if (hgt > Hmax) Hmax = hgt;
    }
  };
  for (let y = 0; y < S; y++) heightRow(y);

  // Pass 2: translucent gummy. Beer–Lambert colour by thickness (pale gold where thin, deep
  // amber where thick), light leaking through thin edges, warm inner glow on the side away
  // from the light, Fresnel rim, sharp key highlight and a soft fill highlight.
  const L = normalize3(-0.45, -0.65, 0.62), Hk = normalize3(L[0], L[1], L[2] + 1);
  const Hf = normalize3(0.6, 0.45, 1.5);
  const canvas = makeCanvas(S, S), ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S), D = img.data;
  const shadeRow = (y) => {
    for (let x = 1; x < S - 1; x++) {
      const i = y * S + x, a = A[i];
      if (a <= 0) continue;
      const gx = (H[i + 1] - H[i - 1]) * 0.5, gy = (H[i + S] - H[i - S]) * 0.5;
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      const nx = -gx * inv, ny = -gy * inv, nz = inv;
      const th = clamp01(H[i] / Hmax), t = 0.2 + 2.3 * Math.pow(th, 1.3);
      const diff = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const base = 0.72 + 0.35 * diff;
      let r = Math.exp(-0.05 * t) * base, g = Math.exp(-0.55 * t) * base, b = Math.exp(-2.4 * t) * base;
      const thin = (1 - smoothstep(0.05, 0.35, th)) * 0.22;
      r = mix(r, 1, thin); g = mix(g, 0.9, thin); b = mix(b, 0.45, thin);
      const away = clamp01(0.5 - 0.6 * (nx * L[0] + ny * L[1]));
      const glow = th * th * away * 0.35;
      r += glow; g += glow * 0.55; b += glow * 0.08;
      const fr = Math.pow(1 - nz, 3) * 0.35;
      r += fr; g += fr * 0.9; b += fr * 0.6;
      const nh = Math.max(0, nx * Hk[0] + ny * Hk[1] + nz * Hk[2]);
      const nf = Math.max(0, nx * Hf[0] + ny * Hf[1] + nz * Hf[2]);
      const spec = Math.pow(nh, 110) * 1.1 + Math.pow(nh, 22) * 0.12 + Math.pow(nf, 40) * 0.22;
      const o = i * 4;
      D[o] = (r + spec) * 255;
      D[o + 1] = (g + spec) * 255;
      D[o + 2] = (b + spec * 0.9) * 255;
      D[o + 3] = a * 255;
    }
  };
  for (let y = 1; y < S - 1; y++) shadeRow(y);
  ctx.putImageData(img, 0, 0);
  return canvas;
}
