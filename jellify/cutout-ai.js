// Jellify Anything: in-browser subject cutout with MediaPipe Interactive Segmenter (MagicTouch).
//
// Everything is self-hosted under ./vendor and runs on this device: the photo is never uploaded.
//   - @mediapipe/tasks-vision 1.0.1 (Apache-2.0), vision_bundle.mjs patched so its built-in usage
//     logger never sends anything (see vendor/README.md); the page CSP also blocks any other origin.
//   - MagicTouch v1 (magic_touch.tflite, Apache-2.0, ~6 MB): segments the object / animal / person
//     under a point. We ask for the thing in the middle of the photo first, then a few other spots if
//     that answer is implausible; the user can also tap the object (`point`).
// Lazy: nothing here is fetched until the first photo (or the photo button is touched). The ~18 MB
// (≈9 MB gzipped) are downloaded once with progress, then the browser cache serves them.
// Without WebAssembly SIMD (Safari < 16.4) or on any failure, `cutoutMask` resolves to null and the
// engine's flood-fill fallback (segment.js) makes the cutout instead.

const BASE = new URL('./vendor/', import.meta.url);
const FILES = {
  bundle: new URL('mediapipe/vision_bundle.mjs', BASE).href,
  loader: new URL('mediapipe/wasm/vision_wasm_internal.js', BASE).href,
  wasm: new URL('mediapipe/wasm/vision_wasm_internal.wasm', BASE).href,
  model: new URL('models/magic_touch.tflite', BASE).href,
};
// Approximate transfer sizes for the progress bar when the server sends no Content-Length.
const EXPECT = { wasm: 11756954, model: 6227884 };

// MediaPipe's native layer prints its INFO / glog lines through console.error ("INFO: Created
// TensorFlow Lite XNNPACK delegate for CPU.", "I1005 …", "W1005 …"). They are not errors; keep the
// console meaningful by dropping exactly those while a MediaPipe call runs. Real errors (E…) pass.
const NATIVE_INFO = /^(INFO:|WARNING:|[IW]\d{4} )/;
let quietDepth = 0;
let rawError = null;
function quiet(on) {
  if (on) {
    if (quietDepth++ === 0) {
      rawError = console.error;
      console.error = (...a) => { if (typeof a[0] === 'string' && NATIVE_INFO.test(a[0])) return; rawError.apply(console, a); };
    }
  } else if (--quietDepth === 0 && rawError) { console.error = rawError; rawError = null; }
}

let readyPromise = null;
let segmenter = null;
let listeners = new Set();
let progress = 0;
let failed = null;

/** Subscribe to download progress (0..1). Returns an unsubscribe function. */
export function onProgress(fn) {
  listeners.add(fn);
  fn(progress);
  return () => listeners.delete(fn);
}
const emit = (p) => { progress = p; for (const fn of listeners) { try { fn(p); } catch { /* ignore */ } } };

/** Is the cutout model usable in this browser at all? (WASM SIMD + WebGL-free CPU path.) */
export function aiSupported() {
  try {
    // Smallest module using a v128 instruction: validates only where WASM SIMD is supported.
    return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch { return false; }
}

export const aiState = () => (segmenter ? 'ready' : failed ? 'failed' : readyPromise ? 'loading' : 'idle');

async function fetchWithProgress(url, expect, report) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || expect;
  if (!res.body || !res.body.getReader) { const b = new Uint8Array(await res.arrayBuffer()); report(1); return b; }
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    report(Math.min(0.99, got / Math.max(total, got)));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  report(1);
  return out;
}

/**
 * Start loading (idempotent). Resolves true when the segmenter is ready, false when the AI cutout is
 * unavailable (the caller then uses the flood fill). Never rejects.
 */
export function prepareAI() {
  if (readyPromise) return readyPromise;
  if (!aiSupported()) { failed = new Error('no WASM SIMD'); readyPromise = Promise.resolve(false); return readyPromise; }
  readyPromise = (async () => {
    let wasmUrl = '', modelUrl = '';
    try {
      const parts = { wasm: 0, model: 0 };
      const total = EXPECT.wasm + EXPECT.model;
      const tick = () => emit(Math.min(0.99, (parts.wasm * EXPECT.wasm + parts.model * EXPECT.model) / total));
      const [mp, wasmBytes, modelBytes] = await Promise.all([
        import(FILES.bundle),
        fetchWithProgress(FILES.wasm, EXPECT.wasm, (p) => { parts.wasm = p; tick(); }),
        fetchWithProgress(FILES.model, EXPECT.model, (p) => { parts.model = p; tick(); }),
      ]);
      wasmUrl = URL.createObjectURL(new Blob([wasmBytes], { type: 'application/wasm' }));
      // modelAssetBuffer is broken for this task in tasks-vision 1.0.1 ("ExternalFile must specify…"),
      // modelAssetPath works: hand it the downloaded bytes as a blob: URL (still no network).
      modelUrl = URL.createObjectURL(new Blob([modelBytes], { type: 'application/octet-stream' }));
      quiet(true);
      try {
      segmenter = await mp.InteractiveSegmenterLegacy.createFromOptions(
        { wasmLoaderPath: FILES.loader, wasmBinaryPath: wasmUrl },
        {
          baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        },
      );
      // First inference initialises XNNPACK (and logs about it): do it now, on a blank image.
      const warm = document.createElement('canvas');
      warm.width = warm.height = 64;
      warm.getContext('2d').fillRect(0, 0, 64, 64);
      runAt(warm, 0.5, 0.5);
      } finally { quiet(false); }
      emit(1);
      return true;
    } catch (err) {
      failed = err;
      console.warn('[jellify] AI cutout unavailable, using the colour-key fallback:', err?.message || err);
      emit(1);
      return false;
    } finally {
      for (const u of [wasmUrl, modelUrl]) if (u) setTimeout(() => URL.revokeObjectURL(u), 5000);
    }
  })();
  return readyPromise;
}

function runAt(image, x, y) {
  let out = null;
  segmenter.segment(image, { keypoint: { x, y } }, (result) => {
    const m = result.confidenceMasks && result.confidenceMasks[0];
    if (!m) return;
    // Copy out while the callback runs (MediaPipe recycles the buffer afterwards).
    out = { data: Float32Array.from(m.getAsFloat32Array()), width: m.width, height: m.height };
  });
  return out;
}

function score(mask) {
  const { data } = mask;
  let fg = 0, sure = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v >= 0.5) fg++;
    if (v < 0.15 || v > 0.85) sure++;
  }
  const cov = fg / data.length;
  return { cov, sure: sure / data.length, ok: cov >= 0.02 && cov <= 0.9 };
}

/**
 * Foreground alpha (0..255) for `canvas` at its own size, or null.
 * point: optional {x, y} in 0..1 (the user tapped the object). Without it the middle of the photo is
 * tried first, then a few other likely spots; the most confident plausible answer wins.
 */
export async function cutoutMask(canvas, point = null) {
  const ok = await prepareAI();
  if (!ok || !segmenter) return null;
  const w = canvas.width, h = canvas.height;
  const tries = point ? [point] : [
    { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.62 }, { x: 0.5, y: 0.4 }, { x: 0.38, y: 0.55 }, { x: 0.62, y: 0.55 },
  ];
  let best = null;
  for (const p of tries) {
    let mask;
    quiet(true);
    try { mask = runAt(canvas, p.x, p.y); } catch (err) { console.warn('[jellify] segmentation failed:', err?.message || err); return null; } finally { quiet(false); }
    if (!mask) continue;
    const s = score(mask);
    if (s.ok && (!best || s.sure > best.s.sure + 0.02)) best = { mask, s };
    if (best && (point || best.s.sure > 0.9)) break; // confident enough: stop early
    if (point && !best) best = { mask, s }; // the user's own pick, even if odd
  }
  if (!best) return null;
  // Resample the model's mask to the canvas size.
  const { data, width: mw, height: mh } = best.mask;
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mh - 1, ((y + 0.5) * mh) / h - 0.5);
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(mh - 1, y0 + 1), fy = Math.max(0, sy - y0);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mw - 1, ((x + 0.5) * mw) / w - 0.5);
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(mw - 1, x0 + 1), fx = Math.max(0, sx - x0);
      const a = data[y0 * mw + x0] * (1 - fx) + data[y0 * mw + x1] * fx;
      const b = data[y1 * mw + x0] * (1 - fx) + data[y1 * mw + x1] * fx;
      alpha[y * w + x] = Math.max(0, Math.min(255, Math.round((a * (1 - fy) + b * fy) * 255)));
    }
  }
  return alpha;
}
