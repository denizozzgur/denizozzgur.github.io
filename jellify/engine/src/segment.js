// Image → transparent "cutout" of its main object, ready to become a jelly.
//
// Strategy (ARCHITECTURE.md): meaningful existing alpha → on-device subject segmentation by the OS
// (native SubjectCutout plugin in native/squeeze-native: Apple Vision on iOS 17+, Google ML Kit
// Subject Segmentation on Android; app only) → border flood-fill colour key → whole image with
// rounded corners. Every mask is cleaned up (largest component, holes filled, morphological
// close/open) and turned into a signed distance field, which is resampled at output resolution to
// get a smooth, 1–2 px feathered edge. Photos never leave the device: the native model runs in
// process, and the web build (no plugin) simply uses the flood fill.

import { plugin as nativePlugin } from '../native/web/platform.js';

export const PAD = 16;

const WORK_SIZE = 1024;      // analysis + segmentation input resolution (longest side)
const SOURCE_MAX = 2048;     // decoded images are capped to this before cropping
const MAX_UPSCALE = 3;       // small objects are enlarged towards maxSize, but not beyond this
const FEATHER = 1.5;         // width of the anti-aliased edge, in output px
const EDGE_CLEAN = 4;        // px inside a segmented edge whose colour is pulled from further in
                             // (fur over grass leaves a green/grey fringe there)
const ALPHA_THRESHOLD = 24;  // "part of the object" for images that already have alpha

const NATIVE_PLUGIN = 'SubjectCutout';
const NATIVE_TIMEOUT_MS = 20_000; // Vision / ML Kit take well under a second on a phone

/**
 * @param {File|Blob|HTMLImageElement|HTMLCanvasElement|ImageBitmap|string} source
 * @param {{ removeBackground?: boolean, maxSize?: number, ai?: boolean,
 *           onProgress?: (label: string, fraction: number|null) => void }} [options]
 *   `ai: false` skips the on-device segmentation model and goes straight to the flood-fill fallback.
 * @returns {Promise<Cutout>}
 */
export async function imageToCutout(source, { removeBackground = true, maxSize = 640, ai = true, onProgress } = {}) {
  const report = (label, fraction = null) => onProgress?.(label, fraction);
  report('Opening image…');

  const decoded = await loadSource(source);
  const src = rasterize(decoded, SOURCE_MAX);
  if (decoded !== source) decoded.close?.(); // ImageBitmaps we created ourselves
  const work = rasterize(src, WORK_SIZE);
  const img = readPixels(work);
  const { width: w, height: h } = img;

  let found = null;
  if (hasMeaningfulAlpha(img)) {
    found = { method: 'alpha', mask: alphaMask(img) };
  } else if (removeBackground) {
    const aiAlpha = ai ? await runNative(work, w, h, report) : null;
    if (aiAlpha) {
      const mask = cleanMask(threshold(aiAlpha, 128), w, h);
      if (plausible(mask, 0.003)) found = { method: 'ai', mask };
    }
    if (!found) {
      report('Finding the object…');
      found = floodFillCutoutMask(img);
    }
  }
  report('Making jelly…', 1);
  return compose(src, w, h, found?.method ?? 'none', found?.mask ?? roundedRectMask(w, h), maxSize);
}

/**
 * Synchronous cutout of a canvas that already has its object on a transparent
 * background (samples). Falls back to flood fill / rounded rect for opaque canvases.
 * @returns {Cutout}
 */
export function canvasToCutout(canvas, { maxSize = 640 } = {}) {
  const img = readPixels(rasterize(canvas, WORK_SIZE));
  const { width: w, height: h } = img;
  const found = hasMeaningfulAlpha(img)
    ? { method: 'alpha', mask: alphaMask(img) }
    : floodFillCutoutMask(img);
  return compose(canvas, w, h, found?.method ?? 'none', found?.mask ?? roundedRectMask(w, h), maxSize);
}

// ---------------------------------------------------------------------------
// Loading

async function loadSource(source) {
  if (typeof source === 'string') return loadImageURL(source);
  if (source instanceof Blob) return decodeBlob(source);
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    if (!source.complete || !source.naturalWidth) await source.decode();
    return source;
  }
  if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
    const c = makeCanvas(source.width, source.height);
    c.getContext('2d').putImageData(source, 0, 0);
    return c;
  }
  return source; // canvas, ImageBitmap, OffscreenCanvas, video…
}

async function decodeBlob(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      // 'from-image' applies EXIF orientation (phone photos).
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      // Some formats (e.g. SVG) only decode through <img>.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await loadImageURL(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImageURL(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!/^(data|blob):/i.test(url)) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be loaded'));
    img.src = url;
  });
}

function sourceSize(src) {
  return {
    w: src.naturalWidth || src.videoWidth || src.displayWidth || src.width || 0,
    h: src.naturalHeight || src.videoHeight || src.displayHeight || src.height || 0,
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Draws `src` into a new canvas whose longest side is at most `maxSide`. */
function rasterize(src, maxSide) {
  const { w, h } = sourceSize(src);
  if (!w || !h) throw new Error('The image could not be decoded');
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function readPixels(canvas) {
  try {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    throw new Error('The image pixels are not readable (CORS)');
  }
}

// ---------------------------------------------------------------------------
// Mask sources

function hasMeaningfulAlpha({ data }) {
  const n = data.length >> 2;
  let clear = 0, solid = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 16) clear++;
    else if (data[i] > 200) solid++;
  }
  return clear > n * 0.02 && solid > n * 0.005;
}

function alphaMask({ data, width, height }) {
  const n = width * height;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] > ALPHA_THRESHOLD ? 1 : 0;
  return largestComponent(mask, width, height);
}

function threshold(values, t) {
  const mask = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) mask[i] = values[i] >= t ? 1 : 0;
  return mask;
}

function plausible(mask, minCoverage) {
  let area = 0;
  for (let i = 0; i < mask.length; i++) area += mask[i];
  const coverage = area / mask.length;
  return coverage >= minCoverage && coverage <= 0.97;
}

function roundedRectMask(w, h) {
  const mask = new Uint8Array(w * h);
  const inset = 1, r = Math.max(2, Math.min(w, h) * 0.12);
  const left = inset + r, right = w - inset - r, top = inset + r, bottom = h - inset - r;
  for (let y = 0; y < h; y++) {
    const dy = Math.max(top - (y + 0.5), 0, y + 0.5 - bottom);
    for (let x = 0; x < w; x++) {
      const dx = Math.max(left - (x + 0.5), 0, x + 0.5 - right);
      mask[y * w + x] = dx * dx + dy * dy <= r * r ? 1 : 0;
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------
// On-device subject segmentation (native SubjectCutout plugin, app only)
//
// The analysis canvas goes over the Capacitor bridge as a JPEG data URL; the plugin answers with a
// PNG whose alpha channel is the soft subject mask at the same size. Any failure (iOS < 17, ML Kit
// model still downloading, no subject, timeout) returns null and the caller uses the flood fill.

/**
 * Optional: let the platform get the segmentation model ready before the first photo (on Android
 * this asks Google Play services to download the ML Kit module if it is missing; on iOS the model is
 * part of the OS). Safe to call repeatedly; does nothing on the web.
 */
export function warmUpAI() {
  try {
    nativePlugin(NATIVE_PLUGIN)?.prepare?.()?.catch?.(() => {});
  } catch {
    // optional
  }
}

/** @returns {Promise<Uint8Array|null>} per-pixel foreground alpha at w×h, or null when unavailable */
async function runNative(canvas, w, h, report) {
  const SC = nativePlugin(NATIVE_PLUGIN);
  if (!SC || typeof SC.cutout !== 'function') return null;
  report('Removing background…');
  let timer = 0;
  try {
    const call = SC.cutout({ image: canvas.toDataURL('image/jpeg', 0.92) });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), NATIVE_TIMEOUT_MS); });
    const res = await Promise.race([call, timeout]);
    if (!res || typeof res.mask !== 'string') return null;
    const maskImg = await loadImageURL(res.mask);
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(maskImg, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
    return alpha;
  } catch (err) {
    console.warn('[segment] on-device segmentation unavailable, using flood fill:', err?.code || err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fallback: flood the background in from the image border (CIELAB colour key)

const LOCAL_STEP = 3.2; // max ΔE between neighbours for gradient-following growth

function floodFillCutoutMask(img) {
  const { width: w, height: h } = img;
  const n = w * h;
  const lab = toLab(boxBlurRGB(img, w >= 700 || h >= 700 ? 2 : 1), n);

  const border = borderIndices(w, h);
  const clusters = kMeansLab(lab, border, 3);
  const largestShare = Math.max(...clusters.map(c => c.share));
  // A cluster covering a real share of the border is background; small ones are
  // probably the object touching the frame.
  const bg = clusters.filter(c => c.share >= 0.18 || c.share === largestShare);
  for (const c of bg) c.tol = Math.min(38, Math.max(10, 8 + 2.2 * c.spread));

  // Distance to the nearest background cluster, in units of that cluster's tolerance.
  const keyDistance = (i) => {
    let best = Infinity;
    for (const c of bg) {
      const dL = lab[i * 3] - c.L, da = lab[i * 3 + 1] - c.a, db = lab[i * 3 + 2] - c.b;
      best = Math.min(best, Math.sqrt(dL * dL + da * da + db * db) / c.tol);
    }
    return best;
  };

  const isBg = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  for (const i of border) {
    if (!isBg[i] && keyDistance(i) <= 1) { isBg[i] = 1; stack[top++] = i; }
  }
  const tryGrow = (from, to) => {
    if (isBg[to]) return;
    const k = keyDistance(to);
    if (k > 2.2) return;
    if (k > 1) {
      const dL = lab[to * 3] - lab[from * 3], da = lab[to * 3 + 1] - lab[from * 3 + 1], db = lab[to * 3 + 2] - lab[from * 3 + 2];
      if (dL * dL + da * da + db * db > LOCAL_STEP * LOCAL_STEP) return;
    }
    isBg[to] = 1;
    stack[top++] = to;
  };
  while (top) {
    const i = stack[--top];
    const x = i % w;
    if (x > 0) tryGrow(i, i - 1);
    if (x < w - 1) tryGrow(i, i + 1);
    if (i >= w) tryGrow(i, i - w);
    if (i < n - w) tryGrow(i, i + w);
  }

  const object = new Uint8Array(n);
  for (let i = 0; i < n; i++) object[i] = isBg[i] ? 0 : 1;
  const mask = cleanMask(object, w, h);
  return plausible(mask, 0.015) ? { method: 'floodfill', mask } : null;
}

function boxBlurRGB({ data, width: w, height: h }, r) {
  const n = w * h;
  const tmp = new Float32Array(n * 3);
  const out = new Float32Array(n * 3);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let R = 0, G = 0, B = 0;
      for (let k = -r; k <= r; k++) {
        const j = (y * w + Math.min(w - 1, Math.max(0, x + k))) * 4;
        R += data[j]; G += data[j + 1]; B += data[j + 2];
      }
      const o = (y * w + x) * 3;
      tmp[o] = R * norm; tmp[o + 1] = G * norm; tmp[o + 2] = B * norm;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let R = 0, G = 0, B = 0;
      for (let k = -r; k <= r; k++) {
        const j = (Math.min(h - 1, Math.max(0, y + k)) * w + x) * 3;
        R += tmp[j]; G += tmp[j + 1]; B += tmp[j + 2];
      }
      const o = (y * w + x) * 3;
      out[o] = R * norm; out[o + 1] = G * norm; out[o + 2] = B * norm;
    }
  }
  return out;
}

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** RGB (0..255 floats) → CIELAB (D65), in place into a new array. */
function toLab(rgb, n) {
  const lab = new Float32Array(n * 3);
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let i = 0; i < n; i++) {
    const r = SRGB_TO_LINEAR[rgb[i * 3] | 0], g = SRGB_TO_LINEAR[rgb[i * 3 + 1] | 0], b = SRGB_TO_LINEAR[rgb[i * 3 + 2] | 0];
    const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    lab[i * 3] = 116 * fy - 16;
    lab[i * 3 + 1] = 500 * (fx - fy);
    lab[i * 3 + 2] = 200 * (fy - fz);
  }
  return lab;
}

function borderIndices(w, h) {
  const idx = [];
  for (let x = 0; x < w; x++) idx.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) idx.push(y * w, y * w + w - 1);
  return idx;
}

/** Tiny k-means over the border pixels: → [{ L, a, b, share, spread }]. */
function kMeansLab(lab, idx, k) {
  const dist2 = (i, c) => {
    const dL = lab[i * 3] - c.L, da = lab[i * 3 + 1] - c.a, db = lab[i * 3 + 2] - c.b;
    return dL * dL + da * da + db * db;
  };
  // Start at the mean, then add the farthest outliers as new centres.
  const mean = { L: 0, a: 0, b: 0 };
  for (const i of idx) { mean.L += lab[i * 3]; mean.a += lab[i * 3 + 1]; mean.b += lab[i * 3 + 2]; }
  mean.L /= idx.length; mean.a /= idx.length; mean.b /= idx.length;
  const centers = [mean];
  while (centers.length < k) {
    let far = -1, farD = 144; // only split clusters that are > 12 ΔE apart
    for (const i of idx) {
      const d = Math.min(...centers.map(c => dist2(i, c)));
      if (d > farD) { farD = d; far = i; }
    }
    if (far < 0) break;
    centers.push({ L: lab[far * 3], a: lab[far * 3 + 1], b: lab[far * 3 + 2] });
  }

  const assign = new Uint8Array(idx.length);
  for (let iter = 0; iter < 8; iter++) {
    const sums = centers.map(() => ({ L: 0, a: 0, b: 0, count: 0 }));
    idx.forEach((i, j) => {
      let best = 0, bestD = Infinity;
      centers.forEach((c, ci) => { const d = dist2(i, c); if (d < bestD) { bestD = d; best = ci; } });
      assign[j] = best;
      const s = sums[best];
      s.L += lab[i * 3]; s.a += lab[i * 3 + 1]; s.b += lab[i * 3 + 2]; s.count++;
    });
    sums.forEach((s, ci) => {
      if (s.count) centers[ci] = { L: s.L / s.count, a: s.a / s.count, b: s.b / s.count };
    });
  }

  return centers.map((c, ci) => {
    let count = 0, sq = 0;
    idx.forEach((i, j) => { if (assign[j] === ci) { count++; sq += dist2(i, c); } });
    return { ...c, share: count / idx.length, spread: count ? Math.sqrt(sq / count) : 0 };
  }).filter(c => c.share > 0);
}

// ---------------------------------------------------------------------------
// Mask cleanup (binary Uint8Array masks, 1 = object)

function cleanMask(mask, w, h) {
  const r = Math.max(1, Math.round(Math.min(w, h) / 256)); // ~2–4 px at work size
  let m = erode(dilate(mask, w, h, 2 * r), w, h, 2 * r);  // close: bridge hairline gaps
  m = largestComponent(m, w, h);
  m = fillHoles(m, w, h);
  m = dilate(erode(m, w, h, r), w, h, r);                  // open: drop fringe and spurs
  return largestComponent(m, w, h);
}

function largestComponent(mask, w, h) {
  const n = w * h;
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  let label = 0, best = 0, bestArea = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || labels[s]) continue;
    label++;
    let area = 0, top = 0;
    labels[s] = label;
    stack[top++] = s;
    while (top) {
      const i = stack[--top];
      area++;
      const x = i % w;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = label; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = label; stack[top++] = i + 1; }
      if (i >= w && mask[i - w] && !labels[i - w]) { labels[i - w] = label; stack[top++] = i - w; }
      if (i < n - w && mask[i + w] && !labels[i + w]) { labels[i + w] = label; stack[top++] = i + w; }
    }
    if (area > bestArea) { bestArea = area; best = label; }
  }
  const out = new Uint8Array(n);
  if (best) for (let i = 0; i < n; i++) out[i] = labels[i] === best ? 1 : 0;
  return out;
}

function fillHoles(mask, w, h) {
  const n = w * h;
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const visit = (i) => {
    if (!mask[i] && !outside[i]) { outside[i] = 1; stack[top++] = i; }
  };
  for (let x = 0; x < w; x++) { visit(x); visit(n - w + x); }
  for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
  while (top) {
    const i = stack[--top];
    const x = i % w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

const FAR = 1e6;

/** Chamfer (1, √2) distance from every pixel to the nearest pixel with mask === target. */
function distanceTo(mask, w, h, target) {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] === target ? 0 : FAR;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  }
  return d;
}

function dilate(mask, w, h, r) {
  const d = distanceTo(mask, w, h, 1);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= r ? 1 : 0;
  return out;
}

function erode(mask, w, h, r) {
  const d = distanceTo(mask, w, h, 0);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i] > r ? 1 : 0;
  return out;
}

/** Positive inside, negative outside; the edge (0) lies half-way between pixel centres. */
function signedDistance(mask, w, h) {
  const toObject = distanceTo(mask, w, h, 1);
  const toBackground = distanceTo(mask, w, h, 0);
  const sd = new Float32Array(w * h);
  for (let i = 0; i < sd.length; i++) sd[i] = mask[i] ? toBackground[i] - 0.5 : 0.5 - toObject[i];
  return sd;
}

function bounds(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------
// Output

/**
 * Crops the object out of the full-resolution source, scales it so its longest side
 * is maxSize − 2·PAD, and applies the mask as a feathered alpha channel.
 */
function compose(src, ww, wh, method, mask, maxSize) {
  // Clearing the frame makes objects that touch the image edge get a soft edge there too.
  for (let x = 0; x < ww; x++) mask[x] = mask[(wh - 1) * ww + x] = 0;
  for (let y = 0; y < wh; y++) mask[y * ww] = mask[y * ww + ww - 1] = 0;
  let box = bounds(mask, ww, wh);
  if (!box) {
    method = 'none';
    mask = roundedRectMask(ww, wh);
    box = bounds(mask, ww, wh);
  }
  const sdf = signedDistance(mask, ww, wh);

  // Crop rectangle in source pixels (1 work px of slack for the feathered edge).
  const { w: sw, h: sh } = sourceSize(src);
  const sx = sw / ww, sy = sh / wh;
  const bx0 = Math.max(0, box.x0 - 1), by0 = Math.max(0, box.y0 - 1);
  const bx1 = Math.min(ww, box.x1 + 2), by1 = Math.min(wh, box.y1 + 2);
  const cropX = bx0 * sx, cropY = by0 * sy, cropW = (bx1 - bx0) * sx, cropH = (by1 - by0) * sy;
  const k = Math.min(MAX_UPSCALE, (maxSize - 2 * PAD) / Math.max(cropW, cropH));
  const iw = Math.max(1, Math.round(cropW * k)), ih = Math.max(1, Math.round(cropH * k));
  const W = iw + 2 * PAD, H = ih + 2 * PAD;

  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, cropX, cropY, cropW, cropH, PAD, PAD, iw, ih);
  const out = ctx.getImageData(0, 0, W, H);
  const px = out.data;

  // Output pixel (ox, oy) → work-pixel sampling coordinates (fx, fy).
  const ax = (bx1 - bx0) / iw, ay = (by1 - by0) / ih;
  const offX = bx0 + (0.5 - PAD) * ax - 0.5, offY = by0 + (0.5 - PAD) * ay - 0.5;
  const outPerWork = 2 / (ax + ay);
  const sample = (fx, fy) => {
    fx = Math.min(ww - 1, Math.max(0, fx));
    fy = Math.min(wh - 1, Math.max(0, fy));
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = Math.min(x0 + 1, ww - 1), y1 = Math.min(y0 + 1, wh - 1);
    const tx = fx - x0, ty = fy - y0;
    const top = sdf[y0 * ww + x0] * (1 - tx) + sdf[y0 * ww + x1] * tx;
    const bottom = sdf[y1 * ww + x0] * (1 - tx) + sdf[y1 * ww + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };

  // With existing alpha the image's own edge is authoritative; the mask only removes
  // stray islands, so it gets a margin that keeps the soft outer pixels.
  const hasAlpha = method === 'alpha';
  const margin = hasAlpha ? 2 * outPerWork + 1 : 0;
  const reach = FEATHER + 1.5;
  const alpha = new Uint8Array(W * H);
  let sumR = 0, sumG = 0, sumB = 0, count = 0;

  for (let oy = 0; oy < H; oy++) {
    const fy = oy * ay + offY;
    for (let ox = 0; ox < W; ox++) {
      const fx = ox * ax + offX;
      const d = sample(fx, fy) * outPerWork + margin; // signed distance in output px
      const m = Math.min(1, Math.max(0, 0.5 + d / FEATHER));
      const i = (oy * W + ox) * 4;
      if (m > 0 && d < EDGE_CLEAN && !hasAlpha) {
        // Edge decontamination: the semi-transparent rim takes the colour from just inside the
        // object, and the first EDGE_CLEAN px inside blend towards it, so no background tint
        // (grass between hairs) leaks into the outline.
        const gx = sample(fx + 1, fy) - sample(fx - 1, fy);
        const gy = sample(fx, fy + 1) - sample(fx, fy - 1);
        const len = Math.hypot(gx, gy);
        if (len > 1e-6) {
          const r = reach + Math.max(0, EDGE_CLEAN - Math.max(0, d));
          const qx = Math.min(W - 1, Math.max(0, Math.round(ox + (gx / len) * r)));
          const qy = Math.min(H - 1, Math.max(0, Math.round(oy + (gy / len) * r)));
          const j = (qy * W + qx) * 4;
          const k = m < 1 ? 1 : 0.85 * (1 - d / EDGE_CLEAN);
          if (px[j + 3] > 0) {
            px[i] += (px[j] - px[i]) * k; px[i + 1] += (px[j + 1] - px[i + 1]) * k; px[i + 2] += (px[j + 2] - px[i + 2]) * k;
          }
        }
      }
      px[i + 3] = px[i + 3] * m;
      const a = px[i + 3];
      alpha[oy * W + ox] = a;
      if (a >= 200) { sumR += px[i]; sumG += px[i + 1]; sumB += px[i + 2]; count++; }
    }
  }
  ctx.putImageData(out, 0, 0);

  const avgColor = count
    ? [Math.round(sumR / count), Math.round(sumG / count), Math.round(sumB / count)]
    : [200, 200, 200];
  return { canvas, alpha, width: W, height: H, avgColor, method };
}
