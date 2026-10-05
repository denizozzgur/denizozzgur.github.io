// Alpha mask → triangle mesh for the soft-body jelly. DOM-free (runs in Node for tests).
//
// buildMesh() pipeline
//   1. binarize (alpha ≥ 128), keep the largest 4-connected component, fill its holes
//   2. round dilation by `dilate` px: exact Euclidean distance transform, contoured with
//      marching squares + linear interpolation → smooth, sub-pixel outline
//   3. Ramer–Douglas–Peucker simplification
//   4. boundary samples: spacing ≤ s, shrunk where the shape is thin (ray-cast thickness,
//      gradient-limited) and refined until every chord hugs the outline; interior samples
//      on a hexagonal lattice with spacing s kept clear of the boundary. s is searched so
//      the vertex count lands near `targetVertices`.
//   5. Bowyer–Watson Delaunay made conforming by splitting missing boundary chords (any still
//      missing are then forced in by edge flips), a few rounds of Laplacian smoothing, then an
//      exact inside/outside flood fill bounded by the chords.
//   6. topology cleanup → a single manifold disk; boundary loop stored first, positive winding.

const ALPHA_THRESHOLD = 128;
const RDP_TOLERANCE = 0.75;        // px
const LEVEL_BIAS = 0.25;           // px added to the dilation: ties count as inside, and one-pixel
                                   // bridges keep a finite width instead of pinching to a point
const MIN_OUTLINE_AREA = 12;       // px²; smaller outlines fall back to a disk
const CIRCLE_SEGMENTS = 192;
const FEATURE_ANGLE = 1.0;         // rad (~57°); sharper outline corners are always sampled
const THICKNESS_RATIO = 1.0;       // boundary spacing ≤ ratio · local thickness …
const MIN_SPACING_RATIO = 0.2;     // … but never below ratio · s
const SIZE_GRADIENT = 0.45;        // boundary spacing may change by this much per px of arc
const SHORT_CHORD_RATIO = 0.4;     // chords shorter than this · local spacing get merged
const CHORD_ERROR_RATIO = 0.1;     // chords stay within ratio · s of the outline …
const CHORD_DILATE_RATIO = 0.45;   // … and within max(ratio · dilate, 1 px), so the gel rim, not the object, absorbs it
const INTERIOR_CLEARANCE = 0.55;   // interior lattice points keep ≥ this · s from the boundary
const SMOOTH_CLEARANCE = 0.5;      // ≥ half a chord: smoothed points never encroach on chords
const SMOOTH_ITERATIONS = 3;
const SMOOTH_WEIGHT = 0.6;
const SPLIT_ROUNDS = 4;            // conformity splitting rounds before chords are forced by flips
const SEARCH_ITERATIONS = 10;
const SEARCH_TOLERANCE = 0.03;     // relative vertex-count tolerance of the spacing search

/**
 * @param {ArrayLike<number>} alpha width*height alpha values 0..255
 * @returns JellyMesh (see ARCHITECTURE.md). Never throws for a sane size; an empty or
 *          near-empty mask yields a small disk at the mask centre.
 */
export function buildMesh(alpha, width, height, { targetVertices = 220, dilate = 8 } = {}) {
  const w = Math.max(1, Math.round(width) || 1);
  const h = Math.max(1, Math.round(height) || 1);
  const target = clampTarget(targetVertices);
  const dil = Number.isFinite(+dilate) ? Math.max(0, +dilate) : 8;

  const comp = largestComponent(alpha, w, h);
  if (comp) {
    fillHoles(comp, w, h);
    const outline = traceOutline(dilatedField(comp, w, h, dil, poolFactor(comp, w, h, dil, target)));
    if (outline && polygonArea(outline) >= MIN_OUTLINE_AREA) {
      // RDP can make near-touching parts of a ragged outline cross; the raw outline never does.
      let poly = simplifyClosed(outline, RDP_TOLERANCE);
      if (!isSimplePolygon(poly)) poly = simplifyClosed(outline, RDP_TOLERANCE / 4);
      if (!isSimplePolygon(poly)) poly = outline;
      const mesh = meshPolygon(poly, w, h, target, Math.max(CHORD_DILATE_RATIO * dil, 1));
      if (mesh) return mesh;
    }
  }
  const r = Math.max(4, dil + 0.5 + Math.sqrt((comp ? comp.count : 0) / Math.PI));
  console.warn(`mesh: ${comp ? 'unusable' : 'empty'} mask, using a ${r.toFixed(1)} px disk`);
  return circleMesh(r, target, {
    cx: comp ? comp.cx : w / 2, cy: comp ? comp.cy : h / 2, width: w, height: h,
  });
}

/**
 * JellyMesh of a disk. By default centred at (radius, radius) in a 2r × 2r "cutout";
 * pass { cx, cy, width, height } to place it inside a larger cutout.
 */
export function circleMesh(radius, targetVertices = 220, { cx, cy, width, height } = {}) {
  const r = Number.isFinite(+radius) && +radius > 0 ? +radius : 1;
  const x0 = cx ?? r, y0 = cy ?? r;
  const poly = new Float64Array(2 * CIRCLE_SEGMENTS);
  for (let k = 0; k < CIRCLE_SEGMENTS; k++) {
    const a = (2 * Math.PI * k) / CIRCLE_SEGMENTS;
    poly[2 * k] = x0 + r * Math.cos(a);
    poly[2 * k + 1] = y0 + r * Math.sin(a);
  }
  return meshPolygon(poly, width ?? 2 * r, height ?? 2 * r, clampTarget(targetVertices), Infinity);
}

function clampTarget(t) {
  const v = Math.round(Number(t));
  return Number.isFinite(v) ? Math.min(8000, Math.max(12, v)) : 220;
}

// ---------------------------------------------------------------------------------------
// Raster stage

// Largest 4-connected component of alpha ≥ threshold → { mask, count, bbox, centroid } | null
function largestComponent(alpha, w, h) {
  const n = w * h;
  const state = new Uint8Array(n); // 0 background, 1 unvisited foreground, 2 visited
  let any = false;
  if (alpha) for (let i = 0; i < n; i++) if (alpha[i] >= ALPHA_THRESHOLD) { state[i] = 1; any = true; }
  if (!any) return null;

  const queue = new Int32Array(n);
  let tail = 0, bestStart = 0, bestLen = 0;
  for (let i = 0; i < n; i++) {
    if (state[i] !== 1) continue;
    const start = tail;
    state[i] = 2; queue[tail++] = i;
    for (let head = start; head < tail; head++) {
      const p = queue[head], x = p % w;
      if (x > 0 && state[p - 1] === 1) { state[p - 1] = 2; queue[tail++] = p - 1; }
      if (x < w - 1 && state[p + 1] === 1) { state[p + 1] = 2; queue[tail++] = p + 1; }
      if (p >= w && state[p - w] === 1) { state[p - w] = 2; queue[tail++] = p - w; }
      if (p + w < n && state[p + w] === 1) { state[p + w] = 2; queue[tail++] = p + w; }
    }
    if (tail - start > bestLen) { bestLen = tail - start; bestStart = start; }
  }

  const mask = state.fill(0);
  let x0 = w, y0 = h, x1 = 0, y1 = 0, sx = 0, sy = 0;
  for (let k = bestStart; k < bestStart + bestLen; k++) {
    const p = queue[k], x = p % w, y = (p - x) / w;
    mask[p] = 1;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    sx += x; sy += y;
  }
  return { mask, count: bestLen, x0, y0, x1, y1, cx: sx / bestLen + 0.5, cy: sy / bestLen + 0.5 };
}

// Background pixels not 4-connected to the outside become foreground.
function fillHoles(comp, w, h) {
  const rx0 = Math.max(0, comp.x0 - 1), ry0 = Math.max(0, comp.y0 - 1);
  const RW = Math.min(w - 1, comp.x1 + 1) - rx0 + 1, RH = Math.min(h - 1, comp.y1 + 1) - ry0 + 1;
  const { mask } = comp;
  const outside = new Uint8Array(RW * RH);
  const queue = new Int32Array(RW * RH);
  let tail = 0;
  const seed = (i, j) => {
    const k = j * RW + i;
    if (!outside[k] && !mask[(ry0 + j) * w + rx0 + i]) { outside[k] = 1; queue[tail++] = k; }
  };
  for (let i = 0; i < RW; i++) { seed(i, 0); seed(i, RH - 1); }
  for (let j = 0; j < RH; j++) { seed(0, j); seed(RW - 1, j); }
  for (let head = 0; head < tail; head++) {
    const k = queue[head], i = k % RW, j = (k - i) / RW;
    if (i > 0) seed(i - 1, j);
    if (i < RW - 1) seed(i + 1, j);
    if (j > 0) seed(i, j - 1);
    if (j < RH - 1) seed(i, j + 1);
  }
  for (let j = 0; j < RH; j++) {
    for (let i = 0; i < RW; i++) {
      const p = (ry0 + j) * w + rx0 + i;
      if (!outside[j * RW + i] && !mask[p]) { mask[p] = 1; comp.count++; }
    }
  }
}

// The distance field only needs pixel accuracy relative to the triangle size: when the
// outline is far from the image border and triangles are big, sample it on 2×2 cells.
function poolFactor(comp, w, h, dil, target) {
  const margin = Math.ceil(dil) + 4; // = dilatedField's padding for f = 2
  const clear = comp.x0 >= margin && comp.y0 >= margin && comp.x1 + margin < w && comp.y1 + margin < h;
  return clear && dil >= 2 && Math.sqrt((1.155 * comp.count) / target) >= 12 ? 2 : 1;
}

// Field (level − distance to the nearest foreground sample) on f×f-pixel cells over the
// component bbox grown by the dilation; its zero level set is the dilated outline.
// level = dilate + 0.5 (foreground pixel edges lie half a pixel from their centres) + LEVEL_BIAS,
// plus for f > 1 the distance from a cell centre to its farthest pixel centre, so the pooled
// outline always contains the exact one.
function dilatedField(comp, w, h, dil, f) {
  const pad = Math.ceil(dil) + 2 + (f - 1) * 2;
  const x0 = Math.max(0, comp.x0 - pad), y0 = Math.max(0, comp.y0 - pad);
  const RW = Math.ceil((Math.min(w - 1, comp.x1 + pad) - x0 + 1) / f);
  const RH = Math.ceil((Math.min(h - 1, comp.y1 + pad) - y0 + 1) / f);
  let mask = comp.mask, stride = w, base = y0 * w + x0;
  if (f > 1) { // max-pool: a cell is foreground if any of its pixels is
    mask = new Uint8Array(RW * RH); stride = RW; base = 0;
    for (let y = y0, ye = Math.min(h, y0 + RH * f); y < ye; y++) {
      const row = y * w, cells = (((y - y0) / f) | 0) * RW;
      for (let x = x0, xe = Math.min(w, x0 + RW * f); x < xe; x++) if (comp.mask[row + x]) mask[cells + (((x - x0) / f) | 0)] = 1;
    }
  }
  const INF = 1e20;
  const field = new Float32Array(RW * RH);

  // Vertical distance to the nearest foreground cell in the same column (two sweeps).
  const last = new Int32Array(RW).fill(-1);
  for (let j = 0; j < RH; j++) {
    const row = base + j * stride, o = j * RW;
    for (let i = 0; i < RW; i++) {
      if (mask[row + i]) last[i] = j;
      field[o + i] = last[i] < 0 ? INF : j - last[i];
    }
  }
  last.fill(-1);
  for (let j = RH - 1; j >= 0; j--) {
    const row = base + j * stride, o = j * RW;
    for (let i = 0; i < RW; i++) {
      if (mask[row + i]) last[i] = j;
      if (last[i] >= 0 && last[i] - j < field[o + i]) field[o + i] = last[i] - j;
    }
  }

  // Exact 1-D squared distance transform along rows (Felzenszwalb & Huttenlocher).
  const g = new Float64Array(RW), v = new Int32Array(RW), z = new Float64Array(RW + 1);
  const level = (dil + 0.5 + LEVEL_BIAS + (f - 1) * Math.SQRT1_2) / f;
  for (let j = 0; j < RH; j++) {
    const o = j * RW;
    for (let i = 0; i < RW; i++) { const d = field[o + i]; g[i] = d >= INF ? INF : d * d; }
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < RW; q++) {
      const gq = g[q] + q * q;
      let s = (gq - (g[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
      while (s <= z[k]) { k--; s = (gq - (g[v[k]] + v[k] * v[k])) / (2 * (q - v[k])); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < RW; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      field[o + q] = level - Math.sqrt(dq * dq + g[v[k]]);
    }
  }
  return { field, RW, RH, x0, y0, f };
}

// Directed marching-squares segments per cell case, as [fromEdge, toEdge] pairs with the
// inside on the left of travel (math sense) → outer loops come out with positive area.
// Edges: 0 top, 1 right, 2 bottom, 3 left. Corner bits: 1 tl, 2 tr, 4 br, 8 bl.
const MS_SEGMENTS = [
  [], [0, 3], [1, 0], [1, 3], [2, 1], null, [2, 0], [2, 3],
  [3, 2], [0, 2], null, [1, 2], [3, 1], [0, 1], [3, 0], [],
];
// Saddles: [separated, joined] where "joined" means the two inside corners connect.
const MS_SADDLES = { 5: [[0, 3, 2, 1], [0, 1, 2, 3]], 10: [[1, 0, 3, 2], [3, 0, 1, 2]] };

// Outer iso-contour (field > 0) → Float64Array [x0, y0, x1, y1, …] in image pixels.
// Samples outside the grid count as "outside"; a crossing towards them lies half-way,
// i.e. exactly on the image border when the grid touches it.
function traceOutline({ field, RW, RH, x0, y0, f }) {
  const PW = RW + 2, PH = RH + 2;
  const inside = new Uint8Array(PW * PH);
  for (let j = 0; j < RH; j++) {
    for (let i = 0; i < RW; i++) if (field[j * RW + i] > 0) inside[(j + 1) * PW + i + 1] = 1;
  }
  const value = (px, py) => (px < 1 || py < 1 || px > RW || py > RH ? NaN : field[(py - 1) * RW + px - 1]);
  const slotOf = new Map();
  const cx = [], cy = [], next = [];
  const crossing = (id, ax, ay, bx, by) => {
    let s = slotOf.get(id);
    if (s !== undefined) return s;
    const fa = value(ax, ay), fb = value(bx, by);
    const t = fa === fa && fb === fb ? Math.min(1 - 1e-4, Math.max(1e-4, fa / (fa - fb))) : 0.5;
    s = cx.length;
    // padded sample (px, py) sits at the cell centre (x0 + f·(px − 0.5), y0 + f·(py − 0.5))
    cx.push(x0 + f * (ax - 0.5 + t * (bx - ax)));
    cy.push(y0 + f * (ay - 0.5 + t * (by - ay)));
    next.push(-1);
    slotOf.set(id, s);
    return s;
  };
  const edgeSlot = (e, px, py) => {
    const k = py * PW + px;
    switch (e) {
      case 0: return crossing(2 * k, px, py, px + 1, py);
      case 1: return crossing(2 * (k + 1) + 1, px + 1, py, px + 1, py + 1);
      case 2: return crossing(2 * (k + PW), px, py + 1, px + 1, py + 1);
      default: return crossing(2 * k + 1, px, py, px, py + 1);
    }
  };

  for (let py = 0; py < PH - 1; py++) {
    for (let px = 0; px < PW - 1; px++) {
      const k = py * PW + px;
      const code = inside[k] | (inside[k + 1] << 1) | (inside[k + PW + 1] << 2) | (inside[k + PW] << 3);
      if (code === 0 || code === 15) continue;
      let segs = MS_SEGMENTS[code];
      if (!segs) {
        const centre = value(px, py) + value(px + 1, py) + value(px + 1, py + 1) + value(px, py + 1);
        segs = MS_SADDLES[code][centre > 0 ? 1 : 0];
      }
      for (let q = 0; q < segs.length; q += 2) next[edgeSlot(segs[q], px, py)] = edgeSlot(segs[q + 1], px, py);
    }
  }

  const visited = new Uint8Array(cx.length);
  let best = null, bestArea = 0;
  for (let s0 = 0; s0 < cx.length; s0++) {
    if (visited[s0]) continue;
    const loop = [];
    let s = s0;
    while (s >= 0 && !visited[s]) { visited[s] = 1; loop.push(s); s = next[s]; }
    if (s !== s0) continue;
    let area = 0;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      area += cx[loop[j]] * cy[loop[i]] - cx[loop[i]] * cy[loop[j]];
    }
    if (area > bestArea) { bestArea = area; best = loop; }
  }
  if (!best) return null;
  // Where the outline runs along the grid (= image) border, marching squares leaves it via a
  // half-cell notch and cuts grid corners diagonally. Snap the notch onto the border and put
  // the true corners back, so border runs stay exactly on the image edge.
  const m = best.length;
  const px = best.map((s) => cx[s]), py = best.map((s) => cy[s]);
  const gx = [x0, x0 + f * RW], gy = [y0, y0 + f * RH];
  const firstX = [x0 + 0.5 * f, x0 + f * (RW - 0.5)], firstY = [y0 + 0.5 * f, y0 + f * (RH - 0.5)];
  for (let i = 0; i < m; i++) {
    const p = best[(i + m - 1) % m], q = best[(i + 1) % m];
    for (let side = 0; side < 2; side++) {
      if (cx[best[i]] === firstX[side] && (cx[p] === gx[side] || cx[q] === gx[side])) px[i] = gx[side];
      if (cy[best[i]] === firstY[side] && (cy[p] === gy[side] || cy[q] === gy[side])) py[i] = gy[side];
    }
  }
  const out = [];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    out.push(px[i], py[i]);
    const ax = gx.indexOf(px[i]), ay = gy.indexOf(py[i]), bx = gx.indexOf(px[j]), by = gy.indexOf(py[j]);
    if (ax >= 0 && by >= 0 && ay < 0 && bx < 0) out.push(gx[ax], gy[by]);
    else if (ay >= 0 && bx >= 0 && ax < 0 && by < 0) out.push(gx[bx], gy[ay]);
  }
  return Float64Array.from(out);
}

// Ramer–Douglas–Peucker on a closed polygon.
function simplifyClosed(poly, tol) {
  const n = poly.length / 2;
  if (n <= 8) return poly;
  let far = 0, farD = -1;
  for (let i = 1; i < n; i++) {
    const dx = poly[2 * i] - poly[0], dy = poly[2 * i + 1] - poly[1];
    if (dx * dx + dy * dy > farD) { farD = dx * dx + dy * dy; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack = [0, far, far, n];
  const tol2 = tol * tol;
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    const bi = b % n;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDistSq(poly[2 * i], poly[2 * i + 1], poly[2 * a], poly[2 * a + 1], poly[2 * bi], poly[2 * bi + 1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) { keep[idx] = 1; stack.push(a, idx, idx, b); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(poly[2 * i], poly[2 * i + 1]);
  return Float64Array.from(out);
}

// ---------------------------------------------------------------------------------------
// Polygon → sample points

function meshPolygon(poly, width, height, target, chordCap) {
  const P = preparePolygon(poly);
  if (!P) return null;
  const s0 = estimateSpacing(P.area, P.length, target);
  const stations = makeStations(P, Math.max(s0 / 3, P.length / 3000));
  let best = searchSpacing(P, stations, s0, target, chordCap);
  // A very ragged outline cannot follow a tight chord tolerance within the vertex budget.
  if (best.count > 1.25 * target && chordCap < Infinity) best = searchSpacing(P, stations, best.s, target, Infinity);
  return triangulate(P, best, width, height);
}

// Search the spacing s so the sample count lands near target: count(s) ~ s^-k, with k
// estimated from the last two probes.
function searchSpacing(P, stations, s0, target, chordCap) {
  let best = null, prev = null, s = s0, k = 2;
  for (let it = 0; it < SEARCH_ITERATIONS; it++) {
    const cur = planPoints(P, stations, s, Math.min(CHORD_ERROR_RATIO * s, chordCap));
    if (!best || Math.abs(cur.count - target) < Math.abs(best.count - target)) best = cur;
    if (Math.abs(cur.count - target) <= SEARCH_TOLERANCE * target) break;
    if (prev && prev.count !== cur.count) {
      k = clamp(-Math.log(cur.count / prev.count) / Math.log(cur.s / prev.s), 0.7, 2.5);
    }
    prev = cur;
    s *= clamp(Math.pow(cur.count / target, 1 / k), 0.6, 1.6);
  }
  return best;
}

// Cleaned, positively wound polygon with arc-length parametrisation, vertex normals
// (pointing inside) and the arc positions of sharp corners.
function preparePolygon(poly) {
  const px = [], py = [];
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i], y = poly[i + 1];
    const m = px.length;
    if (m && Math.abs(x - px[m - 1]) + Math.abs(y - py[m - 1]) < 1e-9) continue;
    px.push(x); py.push(y);
  }
  while (px.length > 1 && Math.abs(px[0] - px[px.length - 1]) + Math.abs(py[0] - py[py.length - 1]) < 1e-9) {
    px.pop(); py.pop();
  }
  const n = px.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += px[j] * py[i] - px[i] * py[j];
  area /= 2;
  if (!(Math.abs(area) > 1e-9)) return null;
  if (area < 0) { px.reverse(); py.reverse(); area = -area; }

  const xs = Float64Array.from(px), ys = Float64Array.from(py);
  const cum = new Float64Array(n + 1);
  const enx = new Float64Array(n), eny = new Float64Array(n);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, gx = 0, gy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = xs[j] - xs[i], dy = ys[j] - ys[i], len = Math.hypot(dx, dy);
    cum[i + 1] = cum[i] + len;
    enx[i] = -dy / len; eny[i] = dx / len; // inward normal for positive winding
    const c = xs[i] * ys[j] - xs[j] * ys[i];
    gx += (xs[i] + xs[j]) * c; gy += (ys[i] + ys[j]) * c;
    x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]);
    y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]);
  }
  const vnx = new Float64Array(n), vny = new Float64Array(n);
  const featureU = [];
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n;
    // turning angle between consecutive edges = angle between their normals
    const turn = Math.atan2(enx[p] * eny[i] - eny[p] * enx[i], enx[p] * enx[i] + eny[p] * eny[i]);
    if (Math.abs(turn) > FEATURE_ANGLE) featureU.push(cum[i]);
    let nx = enx[p] + enx[i], ny = eny[p] + eny[i];
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) { nx = enx[i]; ny = eny[i]; } else { nx /= len; ny /= len; }
    vnx[i] = nx; vny[i] = ny;
  }
  return {
    n, xs, ys, cum, length: cum[n], area, enx, eny, vnx, vny, featureU,
    cx: gx / (6 * area), cy: gy / (6 * area), x0, y0, x1, y1,
    extent: Math.max(x1 - x0, y1 - y0),
  };
}

// Initial spacing guess: hex lattice density 2/(√3 s²) plus a boundary correction.
function estimateSpacing(area, perimeter, target) {
  const a = 1.155 * area, b = 0.365 * perimeter;
  return (2 * a) / (-b + Math.sqrt(b * b + 4 * a * target));
}

// Stations along the outline where the local thickness (inward ray to the far side) is measured.
function makeStations(P, spacing) {
  const us = [], ts = [];
  const eps = 1e-6 * P.extent;
  for (let i = 0; i < P.n; i++) {
    const j = (i + 1) % P.n, len = P.cum[i + 1] - P.cum[i];
    const m = Math.max(1, Math.ceil(len / spacing));
    for (let k = 0; k < m; k++) {
      const f = k / m;
      const x = P.xs[i] + f * (P.xs[j] - P.xs[i]), y = P.ys[i] + f * (P.ys[j] - P.ys[i]);
      us.push(P.cum[i] + f * len);
      ts.push(k === 0 ? rayThickness(P, x, y, P.vnx[i], P.vny[i], eps) : rayThickness(P, x, y, P.enx[i], P.eny[i], eps));
    }
  }
  return { u: Float64Array.from(us), t: Float64Array.from(ts), n: us.length };
}

function rayThickness(P, px, py, nx, ny, eps) {
  const { xs, ys, n } = P;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = xs[j] - xs[i], ey = ys[j] - ys[i];
    const den = nx * ey - ny * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = xs[i] - px, wy = ys[i] - py;
    const t = (wx * ey - wy * ex) / den, lam = (wx * ny - wy * nx) / den;
    if (t > eps && t < best && lam >= 0 && lam <= 1) best = t;
  }
  return best;
}

function planPoints(P, stations, s, delta) {
  const us = sampleBoundary(P, stations, s, delta);
  const nb = us.length;
  const bx = new Float64Array(nb), by = new Float64Array(nb);
  for (let k = 0; k < nb; k++) pointAt(P, us[k], bx, by, k);
  const inner = latticePoints(P, bx, by, s);
  return { s, us, ix: inner.x, iy: inner.y, count: nb + inner.x.length };
}

// Arc positions of boundary samples: spaced by the size function h(u) = clamp(thickness, hmin, s)
// (gradient-limited), sharp corners pinned, then refined until every chord is within delta.
function sampleBoundary(P, st, s, delta) {
  const n = st.n, L = P.length, hmin = MIN_SPACING_RATIO * s;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = clamp(THICKNESS_RATIO * st.t[i], hmin, s);
  limitGradient(h, st.u, L, SIZE_GRADIENT);

  // G(u) = ∫ du / h — samples are equally spaced in G.
  const G = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const du = (i + 1 < n ? st.u[i + 1] : L) - st.u[i];
    G[i + 1] = G[i] + du * 0.5 * (1 / h[i] + 1 / h[(i + 1) % n]);
  }
  const GT = G[n];
  const gAt = (u) => {
    const i = upperBound(st.u, n, u) - 1;
    const u1 = i + 1 < n ? st.u[i + 1] : L;
    return G[i] + ((u - st.u[i]) / (u1 - st.u[i])) * (G[i + 1] - G[i]);
  };
  const uAt = (g) => {
    g = ((g % GT) + GT) % GT;
    const i = Math.min(n - 1, upperBound(G, n + 1, g) - 1);
    const u1 = i + 1 < n ? st.u[i + 1] : L;
    return st.u[i] + ((g - G[i]) / (G[i + 1] - G[i])) * (u1 - st.u[i]);
  };

  const us = [];
  const F = P.featureU;
  if (F.length === 0) {
    const N = Math.max(3, Math.round(GT));
    for (let k = 0; k < N; k++) us.push(uAt((k * GT) / N));
  } else {
    for (let f = 0; f < F.length; f++) {
      const ga = gAt(F[f]);
      const gb = f + 1 < F.length ? gAt(F[f + 1]) : gAt(F[0]) + GT;
      const N = Math.max(F.length === 1 ? 3 : 1, Math.round(gb - ga));
      us.push(F[f]);
      for (let k = 1; k < N; k++) us.push(uAt(ga + (k * (gb - ga)) / N));
    }
  }
  us.sort((a, b) => a - b);
  const hAt = (u) => {
    const i = upperBound(st.u, n, u) - 1, u1 = i + 1 < n ? st.u[i + 1] : L;
    return h[i] + ((u - st.u[i]) / (u1 - st.u[i])) * (h[(i + 1) % n] - h[i]);
  };
  return mergeShortChords(P, refineChords(P, dedupeCyclic(us, L), delta), hAt, delta);
}

// Remove chords much shorter than the local spacing (e.g. an outline corner cut into two
// kinks a few px apart) by dropping one end or collapsing both onto their arc midpoint,
// whichever keeps the neighbouring chords closest to the outline (within 1.5·delta).
function mergeShortChords(P, us, hAt, delta) {
  const L = P.length;
  const dev = (ua, ub) => { const a = ((ua % L) + L) % L; return chordDeviation(P, a, a + ub - ua); };
  for (let pass = 0; pass < 4 && us.length > 3; pass++) {
    const m = us.length, X = new Float64Array(m), Y = new Float64Array(m);
    const next = us.slice(), touched = new Uint8Array(m);
    for (let k = 0; k < m; k++) pointAt(P, us[k], X, Y, k);
    const u = (k) => us[((k % m) + m) % m] + Math.floor(k / m) * L; // unwrapped arc position
    let any = false;
    for (let k = 0; k < m; k++) {
      const k1 = (k + 1) % m;
      if (touched[(k + m - 1) % m] || touched[k] || touched[k1] || touched[(k + 2) % m]) continue;
      if (Math.hypot(X[k1] - X[k], Y[k1] - Y[k]) >= SHORT_CHORD_RATIO * hAt(us[k])) continue;
      const mid = (u(k) + u(k + 1)) / 2;
      const options = [
        [Math.max(dev(u(k - 1), mid), dev(mid, u(k + 2))), mid],
        [dev(u(k - 1), u(k + 1)), u(k + 1)],
        [dev(u(k), u(k + 2)), u(k)],
      ].sort((a, b) => a[0] - b[0]);
      if (options[0][0] > 1.5 * delta) continue;
      next[k] = options[0][1] % L;
      next[k1] = NaN;
      touched[k] = touched[k1] = 1;
      any = true;
    }
    if (!any) break;
    us = next.filter((v) => v === v).sort((a, b) => a - b);
  }
  return us;
}

// Lipschitz limit on a cyclic size function: h[i] ≤ h[j] + g·|u_i − u_j|.
function limitGradient(h, u, L, g) {
  const n = h.length;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 1; k <= n; k++) {
      const i = k % n, du = (k === n ? L : u[k]) - u[k - 1];
      if (h[k - 1] + g * du < h[i]) h[i] = h[k - 1] + g * du;
    }
    for (let k = n - 1; k >= 0; k--) {
      const j = (k + 1) % n, du = (k + 1 === n ? L : u[k + 1]) - u[k];
      if (h[j] + g * du < h[k]) h[k] = h[j] + g * du;
    }
  }
}

// Drop (cyclically) coincident arc positions from a sorted list.
function dedupeCyclic(us, L) {
  const eps = 1e-7 * L, out = [];
  for (const u of us) if (!out.length || u - out[out.length - 1] > eps) out.push(u);
  while (out.length > 1 && out[0] + L - out[out.length - 1] <= eps) out.pop();
  return out;
}

function refineChords(P, us, delta) {
  const L = P.length;
  for (let pass = 0; pass < 12; pass++) {
    const out = [];
    let added = false;
    for (let k = 0; k < us.length; k++) {
      const ua = us[k], ub = k + 1 < us.length ? us[k + 1] : us[0] + L;
      out.push(ua);
      if (us.length < 3 || chordDeviation(P, ua, ub) > delta) {
        out.push(((ua + ub) / 2) % L);
        added = true;
      }
    }
    us = out;
    if (!added) break;
    us.sort((a, b) => a - b);
  }
  return us;
}

// Max distance of outline vertices between arc positions ua < ub (ub may wrap past L) from the chord.
const chordX = new Float64Array(2), chordY = new Float64Array(2);
function chordDeviation(P, ua, ub) {
  const { xs, ys, cum, n, length: L } = P;
  pointAt(P, ua, chordX, chordY, 0);
  pointAt(P, ub % L, chordX, chordY, 1);
  let max = 0;
  for (let i = upperBound(cum, n + 1, ua); i < 2 * n; i++) {
    const idx = i % n, u = cum[idx] + (i >= n ? L : 0);
    if (u >= ub) break;
    const d = segDistSq(xs[idx], ys[idx], chordX[0], chordY[0], chordX[1], chordY[1]);
    if (d > max) max = d;
  }
  return Math.sqrt(max);
}

function pointAt(P, u, outX, outY, k) {
  const { xs, ys, cum, n } = P;
  const i = Math.min(n - 1, Math.max(0, upperBound(cum, n + 1, u) - 1));
  const j = (i + 1) % n, len = cum[i + 1] - cum[i];
  const t = len > 0 ? (u - cum[i]) / len : 0;
  outX[k] = xs[i] + t * (xs[j] - xs[i]);
  outY[k] = ys[i] + t * (ys[j] - ys[i]);
}

// Hexagonal lattice (spacing s, one point at the centroid) clipped to the boundary polygon
// with a clearance of INTERIOR_CLEARANCE·s.
function latticePoints(P, bx, by, s) {
  const nb = bx.length, rowH = (s * Math.sqrt(3)) / 2;
  const clear = INTERIOR_CLEARANCE * s, clear2 = clear * clear;
  const x = [], y = [], cross = [];
  const j0 = Math.ceil((P.y0 + clear - P.cy) / rowH), j1 = Math.floor((P.y1 - clear - P.cy) / rowH);
  for (let j = j0; j <= j1; j++) {
    const yy = P.cy + j * rowH;
    cross.length = 0;
    for (let a = 0, b = nb - 1; a < nb; b = a++) {
      if (by[a] > yy !== by[b] > yy) cross.push(bx[a] + ((yy - by[a]) * (bx[b] - bx[a])) / (by[b] - by[a]));
    }
    cross.sort((p, q) => p - q);
    const ox = P.cx + (j & 1 ? s / 2 : 0);
    for (let c = 0; c + 1 < cross.length; c += 2) {
      const xa = cross[c] + clear, xb = cross[c + 1] - clear;
      for (let i = Math.ceil((xa - ox) / s), xx = ox + i * s; xx <= xb; i++, xx = ox + i * s) {
        if (distSqToPolygon(xx, yy, bx, by, nb, clear2) >= clear2) { x.push(xx); y.push(yy); }
      }
    }
  }
  return { x, y };
}

// ---------------------------------------------------------------------------------------
// Triangulation

function triangulate(P, plan, width, height) {
  const { s } = plan, L = P.length, jitter = 1e-4 * s;
  let us = untangle(P, plan.us);
  const ix = Float64Array.from(plan.ix), iy = Float64Array.from(plan.iy);
  let splitsLeft = SPLIT_ROUNDS, smoothLeft = SMOOTH_ITERATIONS;
  for (;;) {
    const nb = us.length, n = nb + ix.length;
    const X = new Float64Array(n), Y = new Float64Array(n);
    for (let k = 0; k < nb; k++) {
      pointAt(P, us[k], X, Y, k);
      X[k] += jitter * (hash01(k, 1) - 0.5);
      Y[k] += jitter * (hash01(k, 2) - 0.5);
    }
    for (let k = 0; k < ix.length; k++) {
      X[nb + k] = ix[k] + jitter * (hash01(k, 3) - 0.5);
      Y[nb + k] = iy[k] + jitter * (hash01(k, 4) - 0.5);
    }
    const dt = delaunay(X, Y, n);
    const missing = missingChords(dt, nb);
    if (missing.length && splitsLeft > 0) {
      splitsLeft--;
      us = untangle(P, splitChords(us, missing, L));
      continue;
    }
    const keep = missing.length && !recoverChords(dt, nb, missing)
      ? classifyByPolygon(dt, nb, P.extent)
      : classifyByFlood(dt, nb);
    if (smoothLeft === 0) return finalize(dt, keep, width, height);
    smoothLeft--;
    smoothInterior(dt, keep, nb, ix, iy, s);
  }
}

// Split boundary chords until no two of them cross (the outline itself is simple, so
// chords converge onto it).
function untangle(P, us) {
  for (let pass = 0; pass < 40; pass++) {
    const nb = us.length, xs = new Float64Array(nb), ys = new Float64Array(nb);
    for (let k = 0; k < nb; k++) pointAt(P, us[k], xs, ys, k);
    const bad = crossingEdges(xs, ys, nb, false);
    if (!bad.length) break;
    us = splitChords(us, bad, P.length);
  }
  return us;
}

// Bowyer–Watson with triangle adjacency and walking point location.
// Triangles are positively wound; edge e of triangle t runs V[3t+e] → V[3t+(e+1)%3] and
// NB[3t+e] is the triangle across it (−1 on the super-triangle rim, dead slots have V = −1).
// Vertices n, n+1, n+2 are the super triangle.
function delaunay(X0, Y0, n) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (X0[i] < minX) minX = X0[i]; if (X0[i] > maxX) maxX = X0[i];
    if (Y0[i] < minY) minY = Y0[i]; if (Y0[i] > maxY) maxY = Y0[i];
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const N = n + 3;
  const X = new Float64Array(N), Y = new Float64Array(N);
  X.set(X0); Y.set(Y0);
  X[n] = mx - 20 * span; Y[n] = my - span;
  X[n + 1] = mx + 20 * span; Y[n + 1] = my - span;
  X[n + 2] = mx; Y[n + 2] = my + 20 * span;

  const cap = 2 * N + 8;
  const V = new Int32Array(3 * cap), NB = new Int32Array(3 * cap).fill(-1);
  const CX = new Float64Array(cap), CY = new Float64Array(cap), R2 = new Float64Array(cap);
  const mark = new Uint8Array(cap), cavity = new Int32Array(cap), free = new Int32Array(cap);
  const ea = new Int32Array(cap), eb = new Int32Array(cap), eo = new Int32Array(cap), nt = new Int32Array(cap);
  const startAt = new Int32Array(N).fill(-1), endAt = new Int32Array(N).fill(-1);
  let count = 0, nFree = 0;

  const setTri = (t, a, b, c) => {
    V[3 * t] = a; V[3 * t + 1] = b; V[3 * t + 2] = c;
    const ax = X[a], ay = Y[a];
    const bx = X[b] - ax, by = Y[b] - ay, cx = X[c] - ax, cy = Y[c] - ay;
    const d = 2 * (bx * cy - by * cx);
    if (d === 0) { CX[t] = ax; CY[t] = ay; R2[t] = Infinity; return; }
    const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (cy * b2 - by * c2) / d, uy = (bx * c2 - cx * b2) / d;
    CX[t] = ax + ux; CY[t] = ay + uy; R2[t] = ux * ux + uy * uy;
  };
  const locate = (start, x, y) => {
    let t = start;
    for (let step = 0; step < 4 * count + 16; step++) {
      let moved = false;
      for (let q = 0; q < 3; q++) {
        const e = (q + step) % 3;
        const a = V[3 * t + e], b = V[3 * t + ((e + 1) % 3)];
        if ((X[b] - X[a]) * (y - Y[a]) - (Y[b] - Y[a]) * (x - X[a]) < 0 && NB[3 * t + e] >= 0) {
          t = NB[3 * t + e]; moved = true; break;
        }
      }
      if (!moved) return t;
    }
    for (let u = 0; u < count; u++) {
      if (V[3 * u] >= 0 && (x - CX[u]) ** 2 + (y - CY[u]) ** 2 < R2[u]) return u;
    }
    return start;
  };

  setTri(0, n, n + 1, n + 2);
  count = 1;
  let last = 0;
  for (let p = 0; p < n; p++) {
    const x = X[p], y = Y[p];
    const t0 = locate(last, x, y);
    let cn = 0;
    cavity[cn++] = t0; mark[t0] = 1;
    for (let h = 0; h < cn; h++) {
      const c = cavity[h];
      for (let e = 0; e < 3; e++) {
        const o = NB[3 * c + e];
        if (o >= 0 && !mark[o] && (x - CX[o]) ** 2 + (y - CY[o]) ** 2 < R2[o]) { mark[o] = 1; cavity[cn++] = o; }
      }
    }
    let bn = 0;
    for (let h = 0; h < cn; h++) {
      const c = cavity[h];
      for (let e = 0; e < 3; e++) {
        const o = NB[3 * c + e];
        if (o < 0 || !mark[o]) { ea[bn] = V[3 * c + e]; eb[bn] = V[3 * c + ((e + 1) % 3)]; eo[bn] = o; bn++; }
      }
    }
    for (let h = 0; h < cn; h++) mark[cavity[h]] = 0;
    for (let h = bn; h < cn; h++) { V[3 * cavity[h]] = -1; free[nFree++] = cavity[h]; }
    for (let k = 0; k < bn; k++) {
      const t = k < cn ? cavity[k] : nFree > 0 ? free[--nFree] : count++;
      const a = ea[k], b = eb[k], o = eo[k];
      setTri(t, a, b, p);
      NB[3 * t] = o;
      if (o >= 0) {
        for (let e = 0; e < 3; e++) {
          if (V[3 * o + e] === b && V[3 * o + ((e + 1) % 3)] === a) { NB[3 * o + e] = t; break; }
        }
      }
      startAt[a] = t; endAt[b] = t; nt[k] = t;
    }
    for (let k = 0; k < bn; k++) {
      NB[3 * nt[k] + 1] = startAt[eb[k]]; // edge b→p borders the new triangle starting at b
      NB[3 * nt[k] + 2] = endAt[ea[k]];   // edge p→a borders the new triangle ending at a
    }
    for (let k = 0; k < bn; k++) { startAt[ea[k]] = -1; endAt[eb[k]] = -1; }
    last = nt[bn - 1];
  }
  return { V, NB, count, X, Y, n };
}

// Indices k of boundary chords (k → k+1) that are not Delaunay edges.
function missingChords({ V, count }, nb) {
  const has = new Uint8Array(nb);
  for (let t = 0; t < count; t++) {
    if (V[3 * t] < 0) continue;
    for (let e = 0; e < 3; e++) {
      const a = V[3 * t + e], b = V[3 * t + ((e + 1) % 3)];
      if (a >= nb || b >= nb) continue;
      if (b === (a + 1) % nb) has[a] = 1;
      else if (a === (b + 1) % nb) has[b] = 1;
    }
  }
  const out = [];
  for (let k = 0; k < nb; k++) if (!has[k]) out.push(k);
  return out;
}

function splitChords(us, chords, L) {
  const out = us.slice();
  for (const k of chords) {
    const ua = us[k], ub = k + 1 < us.length ? us[k + 1] : us[0] + L;
    out.push(((ua + ub) / 2) % L);
  }
  return out.sort((a, b) => a - b);
}

const isChord = (a, b, nb) => a < nb && b < nb && (b === (a + 1) % nb || a === (b + 1) % nb);

// Exact inside/outside when every boundary chord is an edge: flood from the super triangle
// without crossing chords; everything not reached is inside.
function classifyByFlood({ V, NB, count, X, Y, n }, nb) {
  const outside = new Uint8Array(count), stack = new Int32Array(count);
  let sp = 0;
  for (let t = 0; t < count; t++) {
    if (V[3 * t] >= 0 && (V[3 * t] >= n || V[3 * t + 1] >= n || V[3 * t + 2] >= n)) { outside[t] = 1; stack[sp++] = t; }
  }
  while (sp) {
    const t = stack[--sp];
    for (let e = 0; e < 3; e++) {
      const o = NB[3 * t + e];
      if (o < 0 || outside[o] || isChord(V[3 * t + e], V[3 * t + ((e + 1) % 3)], nb)) continue;
      outside[o] = 1; stack[sp++] = o;
    }
  }
  const keep = new Uint8Array(count);
  for (let t = 0; t < count; t++) {
    const a = V[3 * t], b = V[3 * t + 1], c = V[3 * t + 2];
    if (a >= 0 && !outside[t] && (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]) > 0) keep[t] = 1;
  }
  return keep;
}

// Force missing boundary chords into the triangulation by edge flips (Sloan's constrained
// Delaunay recovery). Chords never cross (see untangle). Returns false if one could not be
// recovered (degenerate input), in which case the caller falls back to polygon tests.
function recoverChords(dt, nb, missing) {
  const { V, NB, count, X, Y } = dt;
  const vt = new Int32Array(dt.n + 3).fill(-1); // some live triangle per vertex
  for (let t = 0; t < count; t++) if (V[3 * t] >= 0) vt[V[3 * t]] = vt[V[3 * t + 1]] = vt[V[3 * t + 2]] = t;
  const orient = (a, b, c) => (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
  const crosses = (a, b, c, d) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
  const at = (t, v) => (V[3 * t] === v ? 0 : V[3 * t + 1] === v ? 1 : 2);

  // Triangle and edge index holding the undirected edge u–v, or null.
  const findEdge = (u, v) => {
    let t = vt[u];
    for (let guard = 0; guard < 64 && t >= 0; guard++) {
      const i = at(t, u);
      if (V[3 * t + ((i + 1) % 3)] === v) return [t, i];
      if (V[3 * t + ((i + 2) % 3)] === v) return [t, (i + 2) % 3];
      t = NB[3 * t + ((i + 2) % 3)];
      if (t === vt[u]) break;
    }
    return null;
  };
  const relink = (t, from, to) => {
    if (t >= 0) for (let e = 0; e < 3; e++) if (NB[3 * t + e] === from) NB[3 * t + e] = to;
  };
  // Flip the diagonal of the quad formed by t and its neighbour across edge e.
  const flip = (t, e) => {
    const o = NB[3 * t + e];
    const u = V[3 * t + e], v = V[3 * t + ((e + 1) % 3)], x = V[3 * t + ((e + 2) % 3)];
    const f = at(o, v), y = V[3 * o + ((f + 2) % 3)];
    const n1 = NB[3 * t + ((e + 1) % 3)], n2 = NB[3 * t + ((e + 2) % 3)];
    const n3 = NB[3 * o + ((f + 1) % 3)], n4 = NB[3 * o + ((f + 2) % 3)];
    V[3 * t] = u; V[3 * t + 1] = y; V[3 * t + 2] = x;
    NB[3 * t] = n3; NB[3 * t + 1] = o; NB[3 * t + 2] = n2;
    V[3 * o] = y; V[3 * o + 1] = v; V[3 * o + 2] = x;
    NB[3 * o] = n4; NB[3 * o + 1] = n1; NB[3 * o + 2] = t;
    relink(n1, t, o); relink(n3, o, t);
    vt[u] = vt[y] = vt[x] = t; vt[v] = o;
    return [x, y];
  };

  for (const k of missing) {
    const a = k, b = (k + 1) % nb;
    if (findEdge(a, b)) continue;
    // Edges crossed by a→b: rotate around a to the wedge containing b, then walk to b.
    const queue = [];
    let t = vt[a], i = -1;
    for (let guard = 0; guard < 64; guard++) {
      i = at(t, a);
      const p = V[3 * t + ((i + 1) % 3)], q = V[3 * t + ((i + 2) % 3)];
      if (orient(a, p, b) > 0 && orient(a, q, b) < 0) { queue.push([p, q]); break; }
      t = NB[3 * t + ((i + 2) % 3)];
      if (t < 0) return false;
    }
    if (!queue.length) return false;
    let [u, w] = queue[0], cur = t, ce = (i + 1) % 3; // crossed edge u→w: u right of a→b, w left
    for (let guard = 0; ; guard++) {
      const o = NB[3 * cur + ce];
      if (o < 0 || guard > count) return false;
      const f = at(o, w), r = V[3 * o + ((f + 2) % 3)];
      if (r === b) break;
      const side = orient(a, b, r);
      if (side === 0) return false;
      if (side > 0) { queue.push([u, r]); w = r; ce = (f + 1) % 3; } else { queue.push([r, w]); u = r; ce = (f + 2) % 3; }
      cur = o;
    }
    for (let guard = 0, limit = 50 * queue.length + 100; queue.length; guard++) {
      if (guard > limit) return false;
      const [p, q] = queue.shift();
      const found = findEdge(p, q);
      if (!found) continue;
      const [ft, fe] = found, o = NB[3 * ft + fe];
      const x = V[3 * ft + ((fe + 2) % 3)], y = V[3 * o + ((at(o, V[3 * ft + ((fe + 1) % 3)]) + 2) % 3)];
      if (!crosses(x, y, p, q)) { queue.push([p, q]); continue; } // quad not convex yet
      const [nx, ny] = flip(ft, fe);
      if (nx !== a && nx !== b && ny !== a && ny !== b && crosses(nx, ny, a, b)) queue.push([nx, ny]);
    }
    if (!findEdge(a, b)) return false;
  }
  return true;
}

// Fallback classification: keep[t] = 1 for triangles inside the boundary polygon (vertices
// 0..nb−1), tested at the centroid and at edge midpoints nudged inwards; gaps fully enclosed
// by kept triangles are refilled.
function classifyByPolygon(dt, nb, extent) {
  const { V, NB, count, X, Y, n } = dt;
  const keep = new Uint8Array(count);
  const minArea2 = 1e-10 * extent * extent;
  const area2 = (t) => {
    const a = V[3 * t], b = V[3 * t + 1], c = V[3 * t + 2];
    return (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
  };
  for (let t = 0; t < count; t++) {
    const a = V[3 * t], b = V[3 * t + 1], c = V[3 * t + 2];
    if (a < 0 || a >= n || b >= n || c >= n || area2(t) <= minArea2) continue;
    const gx = (X[a] + X[b] + X[c]) / 3, gy = (Y[a] + Y[b] + Y[c]) / 3;
    let ok = insidePolygon(gx, gy, X, Y, nb);
    for (let e = 0; ok && e < 3; e++) {
      const p = V[3 * t + e], q = V[3 * t + ((e + 1) % 3)];
      ok = insidePolygon(0.45 * (X[p] + X[q]) + 0.1 * gx, 0.45 * (Y[p] + Y[q]) + 0.1 * gy, X, Y, nb);
    }
    if (ok) keep[t] = 1;
  }

  const seen = new Uint8Array(count), comp = new Int32Array(count);
  for (let t0 = 0; t0 < count; t0++) {
    if (V[3 * t0] < 0 || keep[t0] || seen[t0]) continue;
    let size = 0, enclosed = true;
    comp[size++] = t0; seen[t0] = 1;
    for (let h = 0; h < size; h++) {
      const t = comp[h];
      for (let e = 0; e < 3; e++) {
        if (V[3 * t + e] >= n) enclosed = false;
        const o = NB[3 * t + e];
        if (o >= 0 && !keep[o] && !seen[o]) { seen[o] = 1; comp[size++] = o; }
      }
    }
    if (enclosed) for (let h = 0; h < size; h++) if (area2(comp[h]) > minArea2) keep[comp[h]] = 1;
  }
  return keep;
}

// Laplacian smoothing of interior points (Jacobi), rejecting moves that leave the polygon
// or come closer than SMOOTH_CLEARANCE·s to it.
function smoothInterior({ V, count, X, Y, n }, keep, nb, ix, iy, s) {
  const sx = new Float64Array(n), sy = new Float64Array(n), cnt = new Int32Array(n);
  for (let t = 0; t < count; t++) {
    if (!keep[t]) continue;
    for (let e = 0; e < 3; e++) {
      const a = V[3 * t + e], b = V[3 * t + ((e + 1) % 3)];
      sx[a] += X[b]; sy[a] += Y[b]; cnt[a]++;
    }
  }
  const clear2 = (SMOOTH_CLEARANCE * s) ** 2;
  for (let v = nb; v < n; v++) {
    if (!cnt[v]) continue;
    const k = v - nb, tx = sx[v] / cnt[v], ty = sy[v] / cnt[v];
    for (let w = SMOOTH_WEIGHT; w > 0.1; w *= 0.5) {
      const x = ix[k] + w * (tx - ix[k]), y = iy[k] + w * (ty - iy[k]);
      if (insidePolygon(x, y, X, Y, nb) && distSqToPolygon(x, y, X, Y, nb, clear2) >= clear2) {
        ix[k] = x; iy[k] = y;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Topology cleanup and output

function finalize(dt, keep, width, height) {
  const { V, NB, count, X, Y, n } = dt;
  keepLargestComponent(dt, keep);
  for (let i = 0; i < 16 && splitPinches(dt, keep); i++) keepLargestComponent(dt, keep);

  // Boundary half-edges: edges whose neighbour is not kept.
  const next = new Int32Array(n).fill(-1);
  let start = -1, halfEdges = 0;
  for (let t = 0; t < count; t++) {
    if (!keep[t]) continue;
    for (let e = 0; e < 3; e++) {
      const o = NB[3 * t + e];
      if (o >= 0 && keep[o]) continue;
      const a = V[3 * t + e];
      next[a] = V[3 * t + ((e + 1) % 3)];
      halfEdges++;
      if (start < 0 || Y[a] < Y[start] || (Y[a] === Y[start] && X[a] < X[start])) start = a;
    }
  }
  if (start < 0) return null;
  const loop = [];
  let v = start;
  do { loop.push(v); v = next[v]; } while (v >= 0 && v !== start && loop.length <= halfEdges);
  if (v !== start || loop.length < 3) return null;

  // Compact: boundary loop first (in order), then interior vertices.
  const remap = new Int32Array(n).fill(-1);
  const used = new Uint8Array(n);
  let nt = 0;
  for (let t = 0; t < count; t++) {
    if (!keep[t]) continue;
    nt++;
    used[V[3 * t]] = used[V[3 * t + 1]] = used[V[3 * t + 2]] = 1;
  }
  let nv = 0;
  for (const b of loop) remap[b] = nv++;
  for (let i = 0; i < n; i++) if (used[i] && remap[i] < 0) remap[i] = nv++;
  if (nv > 65535) return null;

  const rest = new Float32Array(2 * nv), uv = new Float32Array(2 * nv);
  const src = new Int32Array(nv);
  for (let i = 0; i < n; i++) if (remap[i] >= 0) src[remap[i]] = i;
  for (let k = 0; k < nv; k++) {
    rest[2 * k] = X[src[k]]; rest[2 * k + 1] = Y[src[k]];
    uv[2 * k] = rest[2 * k] / width; uv[2 * k + 1] = rest[2 * k + 1] / height;
  }

  const tris = new Uint16Array(3 * nt), edgeList = [];
  let area = 0, m = 0;
  for (let t = 0; t < count; t++) {
    if (!keep[t]) continue;
    const a = V[3 * t], b = V[3 * t + 1], c = V[3 * t + 2];
    tris[m++] = remap[a]; tris[m++] = remap[b]; tris[m++] = remap[c];
    area += ((X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a])) / 2;
    for (let e = 0; e < 3; e++) {
      const o = NB[3 * t + e];
      if (o < 0 || !keep[o] || t < o) edgeList.push(remap[V[3 * t + e]], remap[V[3 * t + ((e + 1) % 3)]]);
    }
  }

  const nbnd = loop.length;
  const boundary = new Uint16Array(nbnd), isBoundary = new Uint8Array(nv);
  const bx = new Float64Array(nbnd), by = new Float64Array(nbnd);
  for (let k = 0; k < nbnd; k++) {
    boundary[k] = k; isBoundary[k] = 1;
    bx[k] = X[loop[k]]; by[k] = Y[loop[k]];
  }
  const depth = new Float32Array(nv);
  let maxD = 0;
  for (let k = nbnd; k < nv; k++) {
    const d = Math.sqrt(distSqToPolygon(X[src[k]], Y[src[k]], bx, by, nbnd, 0));
    depth[k] = d;
    if (d > maxD) maxD = d;
  }
  if (maxD > 0) for (let k = nbnd; k < nv; k++) depth[k] /= maxD;

  return {
    rest, uv, depth, tris, edges: Uint16Array.from(edgeList), boundary, isBoundary,
    area, width, height,
  };
}

function keepLargestComponent({ V, NB, count, X, Y }, keep) {
  const label = new Int32Array(count).fill(-1), stack = new Int32Array(count);
  let bestLabel = -1, bestArea = -1, labels = 0;
  for (let t0 = 0; t0 < count; t0++) {
    if (!keep[t0] || label[t0] >= 0) continue;
    let sp = 0, area = 0;
    stack[sp++] = t0; label[t0] = labels;
    while (sp) {
      const t = stack[--sp];
      const a = V[3 * t], b = V[3 * t + 1], c = V[3 * t + 2];
      area += (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
      for (let e = 0; e < 3; e++) {
        const o = NB[3 * t + e];
        if (o >= 0 && keep[o] && label[o] < 0) { label[o] = labels; stack[sp++] = o; }
      }
    }
    if (area > bestArea) { bestArea = area; bestLabel = labels; }
    labels++;
  }
  for (let t = 0; t < count; t++) if (keep[t] && label[t] !== bestLabel) keep[t] = 0;
}

// A vertex with more than one outgoing boundary half-edge joins separate triangle fans
// (a "bow-tie"); keep only its largest fan. Returns true if anything was removed.
function splitPinches({ V, NB, count, n }, keep) {
  const out = new Int32Array(n);
  for (let t = 0; t < count; t++) {
    if (!keep[t]) continue;
    for (let e = 0; e < 3; e++) {
      const o = NB[3 * t + e];
      if (o < 0 || !keep[o]) out[V[3 * t + e]]++;
    }
  }
  let changed = false;
  for (let v = 0; v < n; v++) {
    if (out[v] < 2) continue;
    const fans = [];
    const fanOf = new Map();
    for (let t = 0; t < count; t++) {
      if (!keep[t] || fanOf.has(t) || (V[3 * t] !== v && V[3 * t + 1] !== v && V[3 * t + 2] !== v)) continue;
      const fan = [t];
      fanOf.set(t, fan);
      for (let h = 0; h < fan.length; h++) {
        const u = fan[h];
        for (let e = 0; e < 3; e++) {
          const o = NB[3 * u + e];
          const touchesV = V[3 * u + e] === v || V[3 * u + ((e + 1) % 3)] === v;
          if (touchesV && o >= 0 && keep[o] && !fanOf.has(o)) { fanOf.set(o, fan); fan.push(o); }
        }
      }
      fans.push(fan);
    }
    if (fans.length < 2) continue;
    fans.sort((a, b) => b.length - a.length);
    for (let f = 1; f < fans.length; f++) for (const t of fans[f]) keep[t] = 0;
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------------------
// Geometry helpers

function polygonArea(poly) {
  let a = 0;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += poly[2 * j] * poly[2 * i + 1] - poly[2 * i] * poly[2 * j + 1];
  return a / 2;
}

function isSimplePolygon(poly) {
  const n = poly.length / 2, xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = poly[2 * i]; ys[i] = poly[2 * i + 1]; }
  return crossingEdges(xs, ys, n, true).length === 0;
}

// Indices of closed-polygon edges that touch or cross a non-adjacent edge (sweep over x).
function crossingEdges(xs, ys, n, firstOnly) {
  const lo = new Float64Array(n), hi = new Float64Array(n), order = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    lo[i] = Math.min(xs[i], xs[j]); hi[i] = Math.max(xs[i], xs[j]);
    order[i] = i;
  }
  order.sort((a, b) => lo[a] - lo[b]);
  const orient = (a, b, c) => (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
  const bad = new Set();
  for (let p = 0; p < n; p++) {
    const i = order[p], i2 = (i + 1) % n;
    for (let q = p + 1; q < n && lo[order[q]] <= hi[i]; q++) {
      const j = order[q], j2 = (j + 1) % n;
      if (j === i2 || j2 === i) continue;
      if (Math.max(ys[i], ys[i2]) < Math.min(ys[j], ys[j2]) || Math.max(ys[j], ys[j2]) < Math.min(ys[i], ys[i2])) continue;
      if (orient(j, j2, i) * orient(j, j2, i2) <= 0 && orient(i, i2, j) * orient(i, i2, j2) <= 0) {
        bad.add(i).add(j);
        if (firstOnly) return [...bad];
      }
    }
  }
  return [...bad];
}

function insidePolygon(px, py, xs, ys, n) {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ys[i], yj = ys[j];
    if (yi > py !== yj > py && px < ((xs[j] - xs[i]) * (py - yi)) / (yj - yi) + xs[i]) inside = !inside;
  }
  return inside;
}

// Squared distance from a point to a closed polygon; stops early once below `stopBelow`.
function distSqToPolygon(px, py, xs, ys, n, stopBelow) {
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = segDistSq(px, py, xs[j], ys[j], xs[i], ys[i]);
    if (d < best) { best = d; if (best < stopBelow) return best; }
  }
  return best;
}

function segDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

// First index i in [0, n) with arr[i] > value (n if none); arr sorted ascending.
function upperBound(arr, n, value) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] > value) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Deterministic hash → [0, 1), used for tiny Delaunay tie-breaking jitter.
function hash01(i, salt) {
  let x = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca77);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}
