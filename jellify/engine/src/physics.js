// Jellymama soft-body physics (DOM-free, runs in Node for tests).
//
// Every jelly is a triangle mesh of particles simulated with small-step XPBD: a fixed-rate
// substep loop (PHYSICS_TUNING.substepHz) where each substep predicts positions, runs ONE
// pass over the constraints and derives velocities from the position change. Per body:
//   - edge lengths (+ edge dashpots) → local jelly texture, stretch, dents, strain damping
//   - triangle areas                 → near-incompressible, no collapse / inversion
//   - boundary polygon area          → whole-body volume ("pressure")
//   - global shape matching          → springs back to the rest shape and wobbles around it
//     (Müller et al. 2005: centroid + best-fit rotation, pull towards the goal shape)
// Damping acts on the DEFORMATION only (velocity minus the body's rigid linear + angular
// velocity, and strain rate along edges), so throws fly and spin freely.
//
// Game posing (Squeeze Out!): body.setTarget() softly attaches the particles to a pose the game
// moves (lag, overshoot, wobble), body.setRestShape() morphs the rest shape (squeezing through a
// gate), body.kinematic pins the body to its target exactly (solid mode), body.restLocal() gives
// the rest shape to pose, world.collisions switches jelly–jelly contacts. body.setSize() grows or
// shrinks a body for good (Free mode's pinch-to-resize), keeping its density and feel.
//
// Sleep (battery): with world.autoSleep = true, a world whose every particle has been still
// (< PHYSICS_TUNING.sleepSpeed) for sleepDelay s, with no grab and every target pose unchanged,
// skips its substeps entirely (world.asleep). Anything that can move a body wakes it at once: a
// grab, slap, shake, kick, added/removed body, resize, a changed target / rest shape / size /
// gravity / jiggle, or any velocity written from outside (checked every step). Off by default,
// so the solver tests see the plain integrator.

import { materialFor } from './materials.js';

// Key constants of the feel. Read every step, so live tweaks apply immediately.
// [a, b] pairs are interpolated (geometrically) from firm/damped (a) to wobbly (b).
export const PHYSICS_TUNING = {
  substepHz: 720,            // fixed solver rate: 12 substeps per 60 Hz frame
  maxFrameDt: 1 / 30,        // longer frames are clamped (the world slows down instead of exploding)
  maxSpeed: 8000,            // px/s, hard per-particle velocity clamp
  sleepSpeed: 0.5,           // px/s: autoSleep worlds sleep once every particle is slower than this …
  sleepDelay: 0.3,           // … for this long (s)
  massArea: 400,             // px² of jelly per unit of particle mass

  // Elasticity (Hz), picked by the effective softness: world.jiggle nudged by material.softness.
  shapeHz: [6, 1.8],         // global shape matching: spring-back towards the rest shape
  edgeHz: [12, 3],           // edge network (scaled internally by mesh resolution)
  areaHz: [40, 25],          // triangle areas: keeps the jelly near-incompressible
  pressureHz: 9,             // whole-body area
  invertedArea: 0.2,         // triangles squashed below this fraction of rest area push back 20× harder
  softnessInfluence: 0.6,    // how far material.softness shifts world.jiggle
  sizeRadius: 150,           // px: bodies of this radius use the frequencies above as given;
  sizeExponent: 0.5,         // others scale by (sizeRadius / radius)^exp, so small jellies jiggle faster

  // Damping, picked by material.wobble (nudged by world.jiggle). Rigid motion only gets air drag.
  strainDamping: [0.008, 0.0025], // s, edge dashpots (strain-rate damping), ζ ≈ β·ω/2 per mode
  deformDamping: [8, 1.2],    // 1/s, on velocity relative to the body's rigid motion
  wobbleJiggleInfluence: 0.6,
  airDrag: 0.08,             // 1/s
  restDamping: 6,            // 1/s, settles slow rigid motion of touching bodies (no creeping/rocking)
  restSpeed: 45,             // px/s, rigid speed below which rest damping is active
  heldDrag: 5,               // 1/s, damps a held body's swing relative to the hand
  contactDamping: 5,         // 1/s, squelch: damps rigid motion into/out of a wall or floor being touched

  // Healing: a crush can fold a jelly over itself (its outline self-intersects, triangles
  // invert) or leave it tangled far from its rest shape. Such a body gets a strong spring-back
  // and lets go of the walls (glue / static friction would lock the fold) until it is clean.
  healError: 0.12,           // mean distance from the rest shape (× radius) of a still body that counts as tangled
  healDelay: 0.2,            // s a body must stay tangled before healing starts
  healHz: 14,                // shape-matching stiffness while healing

  // Contacts
  wallStaticFriction: 1.1,   // sticky jelly: grips the floor when pressed
  wallFriction: 0.8,
  jellyStaticFriction: 0.6,
  jellyFriction: 0.45,
  // Wet adhesion: particles pressing on a surface stay stuck to it for a moment, so a landing
  // rebounds into a tall stretch instead of a rubber-ball hop, and a resting jelly peels off
  // the floor when lifted. Strength scales with material.juiciness.
  glueTime: 0.25,            // s the glue lasts after a particle stops pressing on the surface
  glueRange: 6,              // px from the surface within which the glue holds (farther = torn off),
                             // at most half an edge so tiny jellies aren't crushed by it
  glueAccel: [150000, 1500000], // px/s², pull back to the surface (dry → juicy)

  // Grabbing
  grabRadiusMin: 22,
  grabRadiusFactor: 0.28,    // × body radius
  grabHz: 24,                // stiffness of the soft pointer constraint
  grabDamping: 30,           // 1/s, grabbed particles' velocity follows the pointer velocity
  grabPivot: 0.6,            // 0 = rigid grip keeps orientation, 1 = free pivot (swings freely)
  throwBlend: 0.9,           // how much of the release velocity replaces the body's own
  throwMax: 6000,            // px/s

  // Targets (body.setTarget): every particle is softly attached (XPBD, compliance from the
  // frequency) to its spot in a posed shape the game moves around, e.g. a puzzle piece following
  // the finger. The attachment is firmest at the anchor (the finger's grip point, else the
  // centre) and looser away from it, so the far side trails on a start (stretch), runs on at a
  // stop (squash, bend) and wobbles back, while the body as a whole lags, overshoots and settles.
  // Measured on 60 px cells at hz 10 (tests/physics-target.test.mjs): a 3×1 bar gripped at one
  // end and stopped dead from 700 px/s overshoots ~8 px, stretches/squashes ±10 px, settles to
  // < 1 px in ~0.25–0.4 s; a normal 2-cell drag lags ~4 px and wobbles 3–9 px.
  targetHz: 10,              // default follow frequency (setTarget's `hz`) of the body as a whole
  targetRim: 0.3,            // attachment frequency at the far side (relative to the anchor's) …
  targetCurve: 2,            // … falling as (1 − distance/maxDistance)^curve; per-particle frequencies are
                             //   normalized so the whole-body follow frequency is exactly hz
  targetDamping: 26,         // 1/s, damps the body's motion relative to the target's (setTarget's `damping`)
  targetWobbleDamping: 7,    // 1/s, damps the wobble (deformation) relative to the target's motion

  // Slap / shake
  slapSpeed: 2600,           // hand speed (px/s) at strength 1
  slapDent: 1.4,             // local dent kick (× hand speed) around the hit point
  slapSqueeze: 0.45,         // whole-body squeeze along the hit (× hand speed): the big wobble
  slapTransfer: 0.3,         // fraction of hand speed given to the whole body
  slapSpin: 0.35,            // fraction of the full rigid-body spin from an off-centre hit
  slapRadius: 0.6,           // dent falloff radius (× body radius)
  slapReach: 20,             // px: a slap next to (not on) a body still hits it
  shakeSpeed: 1300,          // px/s at strength 1

  // Events & feedback
  impactSpeedRef: 1800,      // normal speed (px/s) that maps to intensity 1
  eventThreshold: 0.04,
  eventDebounce: 0.07,       // s, per body per surface (per pair for jelly-jelly)
  jiggleSpeedRef: 320,       // RMS deformation speed (px/s) that maps to body.jiggle = 1
  jiggleRelease: 0.18,       // s, decay time constant of body.jiggle
  strainSmoothing: 0.04,     // s, time constant of body.strain smoothing
};

const TAU = Math.PI * 2;
const FLOOR = 0, CEILING = 1, LEFT = 2, RIGHT = 3;
const SURFACE_NORMALS = [[0, -1], [0, 1], [1, 0], [-1, 0]];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerpGeo = (range, t) => range[0] * Math.pow(range[1] / range[0], t);
// Per-substep correction fraction of a constraint with angular frequency w (rad/s).
const stepFraction = (w, h) => { const k = w * h * w * h; return k / (1 + k); };

// Greedy colouring order for constraints over `arity` particles each: consecutive constraints
// in a sweep share no particle, so the CPU can overlap them (a Gauss-Seidel sweep in mesh
// order is latency-bound; this is ~5× faster). It also spreads the sweep over the whole mesh:
// a sweep in mesh (ring/row) order makes the material subtly chiral, so a resting jelly
// would start rolling by itself.
function sweepOrder(idx, arity, count, n) {
  const order = new Int32Array(count), done = new Uint8Array(count), mark = new Int32Array(n).fill(-1);
  let filled = 0;
  for (let color = 0; filled < count; color++) {
    for (let k = 0; k < count; k++) {
      if (done[k]) continue;
      let free = true;
      for (let a = 0; a < arity && free; a++) free = mark[idx[k * arity + a]] !== color;
      if (!free) continue;
      for (let a = 0; a < arity; a++) mark[idx[k * arity + a]] = color;
      done[k] = 1;
      order[filled++] = k;
    }
  }
  return order;
}

let bodyCounter = 0;
let grabCounter = 0;

// Scratch result of closestOnBoundary() (avoids allocations in hot paths).
const near = { d2: 0, x: 0, y: 0 };

export class JellyBody {
  constructor(mesh, { x = 0, y = 0, scale = 1, material = null, vx = 0, vy = 0, angle = 0, spin = 0 } = {}) {
    this.id = ++bodyCounter;
    this.mesh = mesh;
    this.material = typeof material === 'string' ? materialFor(material) : material || materialFor('jelly');
    this.scale = scale;
    const n = mesh.rest.length >> 1;
    this.n = n;
    this.positions = new Float32Array(2 * n);
    this.strain = new Float32Array(n);
    this.jiggle = 0;
    this.grabbed = false;
    this.angle = angle; // continuous body rotation (rad) from shape matching

    const rest = mesh.rest, s2 = scale * scale;

    // Valid triangles (forced to positive winding) and lumped (incident-area) masses.
    const tri = [];
    const incident = new Float64Array(n);
    let area = 0;
    for (let t = 0; t + 2 < mesh.tris.length; t += 3) {
      const a = mesh.tris[t];
      let b = mesh.tris[t + 1], c = mesh.tris[t + 2];
      if (a >= n || b >= n || c >= n) continue;
      const ar = 0.5 * s2 * ((rest[2 * b] - rest[2 * a]) * (rest[2 * c + 1] - rest[2 * a + 1]) -
                             (rest[2 * c] - rest[2 * a]) * (rest[2 * b + 1] - rest[2 * a + 1]));
      if (Math.abs(ar) < 1e-6) continue;
      if (ar < 0) { const tmp = b; b = c; c = tmp; }
      tri.push(a, b, c);
      const A = Math.abs(ar);
      area += A;
      incident[a] += A; incident[b] += A; incident[c] += A;
    }
    let meanIncident = 0, used = 0;
    for (let i = 0; i < n; i++) if (incident[i] > 0) { meanIncident += incident[i]; used++; }
    meanIncident = used ? meanIncident / used : 1;
    for (let i = 0; i < n; i++) if (!(incident[i] > 0)) incident[i] = meanIncident;

    const m = new Float64Array(n), w = new Float64Array(n);
    let M = 0, cx0 = 0, cy0 = 0;
    for (let i = 0; i < n; i++) {
      m[i] = incident[i] / 3 / PHYSICS_TUNING.massArea;
      w[i] = 1 / m[i];
      M += m[i];
      cx0 += m[i] * rest[2 * i];
      cy0 += m[i] * rest[2 * i + 1];
    }
    cx0 /= M; cy0 /= M;
    this.m = m; this.w = w; this.mass = M;
    this.restIncident = incident;
    this.restArea = area;
    this._radius = Math.sqrt(area / Math.PI);

    // Rest shape relative to the mass centroid, in world scale (shape-matching q_i).
    const q = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      q[2 * i] = (rest[2 * i] - cx0) * scale;
      q[2 * i + 1] = (rest[2 * i + 1] - cy0) * scale;
    }
    this.q = q;

    // Triangle constraints in sweep order: pre-doubled indices, rest areas, rest norms G0.
    const nt = tri.length / 3;
    const tOrder = sweepOrder(tri, 3, nt, n);
    this.tri = new Int32Array(nt * 3);
    this.triArea = new Float64Array(nt);
    this.triG0 = new Float64Array(nt);
    for (let t = 0; t < nt; t++) {
      const s = tOrder[t], a = tri[3 * s], b = tri[3 * s + 1], c = tri[3 * s + 2];
      this.tri[3 * t] = 2 * a; this.tri[3 * t + 1] = 2 * b; this.tri[3 * t + 2] = 2 * c;
      const x0 = q[2 * a], y0 = q[2 * a + 1], x1 = q[2 * b], y1 = q[2 * b + 1], x2 = q[2 * c], y2 = q[2 * c + 1];
      this.triArea[t] = 0.5 * ((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0));
      this.triG0[t] = 0.25 * (w[a] * ((y1 - y2) ** 2 + (x2 - x1) ** 2) +
                              w[b] * ((y2 - y0) ** 2 + (x0 - x2) ** 2) +
                              w[c] * ((y0 - y1) ** 2 + (x1 - x0) ** 2));
    }

    // Edge constraints (from the mesh, or derived from the triangles) in sweep order.
    let edgeSrc = mesh.edges;
    if (!edgeSrc || edgeSrc.length < 2) {
      const seen = new Set();
      edgeSrc = [];
      for (let k = 0; k < tri.length; k += 3) {
        for (let e = 0; e < 3; e++) {
          const a = tri[k + e], b = tri[k + (e + 1) % 3];
          const key = a < b ? a * 65536 + b : b * 65536 + a;
          if (!seen.has(key)) { seen.add(key); edgeSrc.push(a, b); }
        }
      }
    }
    const edge = [];
    for (let k = 0; k + 1 < edgeSrc.length; k += 2) {
      const a = edgeSrc[k], b = edgeSrc[k + 1];
      if (a < n && b < n && a !== b && Math.hypot(q[2 * b] - q[2 * a], q[2 * b + 1] - q[2 * a + 1]) > 1e-6) edge.push(a, b);
    }
    const ne = edge.length / 2;
    const eOrder = sweepOrder(edge, 2, ne, n);
    this.edge = new Int32Array(2 * ne);
    this.edgeLen = new Float64Array(ne);
    this.edgeRatio = new Float64Array(2 * ne);
    let lenSum = 0;
    for (let k = 0; k < ne; k++) {
      const s = eOrder[k], a = edge[2 * s], b = edge[2 * s + 1];
      this.edge[2 * k] = 2 * a; this.edge[2 * k + 1] = 2 * b;
      this.edgeLen[k] = Math.hypot(q[2 * b] - q[2 * a], q[2 * b + 1] - q[2 * a + 1]);
      this.edgeRatio[2 * k] = w[a] / (w[a] + w[b]);
      this.edgeRatio[2 * k + 1] = w[b] / (w[a] + w[b]);
      lenSum += this.edgeLen[k];
    }
    this.edgeMean = ne ? lenSum / ne : this._radius / 8;

    // Boundary loop (positive winding) for pressure, collisions and picking.
    let bnd = Array.from(mesh.boundary || []).filter(i => i < n);
    let pa = 0;
    for (let k = 0; k < bnd.length; k++) {
      const i = bnd[k], j = bnd[(k + 1) % bnd.length];
      pa += q[2 * i] * q[2 * j + 1] - q[2 * j] * q[2 * i + 1];
    }
    if (pa < 0) bnd = bnd.reverse();
    const nb = bnd.length;
    this.bnd = Int32Array.from(bnd, i => 2 * i);
    this.polyArea = Math.abs(pa) * 0.5;
    let g0 = 0;
    for (let k = 0; k < nb; k++) {
      const prev = bnd[(k + nb - 1) % nb], next = bnd[(k + 1) % nb];
      g0 += w[bnd[k]] * 0.25 * ((q[2 * next + 1] - q[2 * prev + 1]) ** 2 + (q[2 * prev] - q[2 * next]) ** 2);
    }
    this.polyG0 = g0;

    // Simulation state: positions, previous positions, velocities (interleaved x,y).
    this.x = new Float64Array(2 * n);
    this.px = new Float64Array(2 * n);
    this.v = new Float64Array(2 * n);
    const co = Math.cos(angle), si = Math.sin(angle);
    for (let i = 0; i < n; i++) {
      const rx = co * q[2 * i] - si * q[2 * i + 1], ry = si * q[2 * i] + co * q[2 * i + 1];
      this.x[2 * i] = x + rx;
      this.x[2 * i + 1] = y + ry;
      this.v[2 * i] = vx - spin * ry;
      this.v[2 * i + 1] = vy + spin * rx;
    }
    this.px.set(this.x);
    // Rigid motion (centroid, linear & angular velocity) as of the last substep.
    this._rc = { x, y, vx, vy, om: spin };

    // Scratch & bookkeeping.
    this._grad = new Float64Array(2 * nb);
    this._scratch = new Float64Array(n);
    this._glue = new Float32Array(n);                 // remaining wet-adhesion time per particle
    this._bb = new Float64Array(4);
    this._imp = new Float64Array(16);                 // per surface: maxSpeed, sumX, sumY, count
    this._lastImp = new Float64Array(4).fill(-1e9);
    this._grabs = 0;
    this._holdVx = 0; this._holdVy = 0;
    this._touch = false;
    this._defKE = 0;
    this._tangledFor = 0;
    this._healing = false;
    this._folded = false;   // outline self-intersects (updated by the world, round-robin)
    this._good = { x, y, angle };
    // Per-step solver coefficients (see _setParams).
    this._sEdge = 0; this._dashpot = 0; this._kArea = 0; this._kPress = 0; this._beta = 0;
    this._damp = 1; this._air = 1; this._rest = 0; this._squelch = 1; this._held = 1;
    this._glueRange = 0; this._gluePull = 0;

    // Targets & kinematic posing (see setTarget / kinematic). Buffers are allocated on first use.
    this.kinematic = false;   // true: positions follow the target exactly, no dynamics
    this._target = null;      // caller's Float32Array(2n), read at the start of every step
    this._tFresh = false;     // target just (re)activated: start without interpolation
    this._tPrev = null;       // Float64Array(2n): target at the start of the current step
    this._tNext = null;       // Float64Array(2n): target at the end of the current step
    this._tMult = null;       // Float64Array(n): per-particle attachment frequency multiplier (by distance from the anchor)
    this._tFrac = null;       // Float64Array(n): per-substep correction fraction
    this._tHz = PHYSICS_TUNING.targetHz;
    this._tDamping = null;    // 1/s, null → PHYSICS_TUNING.targetDamping
    this._tInvSpan = 0;       // 1 / duration of the current step (target velocity)
    this._tKr = 1; this._tKd = 1;
    this._tAnchor = null;     // [x, y] rest-local grip point, null = centre
    this._tDirty = true;      // attachment weights need recomputing
    this._tRim = -1; this._tCurve = -1;
    this._origRest = null;    // original rest data while setRestShape() is active
    this._restMorphed = false;
    this._size = 1;           // setSize(): multiple of the creation size
    this._syncPositions();
  }

  // --- targets, rest shape, kinematic posing ---------------------------------

  /**
   * Softly attach every particle to `targets` (Float32Array(2n), world coords, same vertex order
   * as mesh.rest — e.g. restLocal() posed by the game) with an XPBD attachment: the body follows
   * like a spring of frequency `hz`, with `damping` (1/s, default PHYSICS_TUNING.targetDamping)
   * of its motion relative to the target's motion. The array is copied at the start of every
   * world.step, so it may be mutated in place or replaced each frame; target motion is
   * interpolated across the substeps. null releases the body (it keeps its velocity).
   * `anchor` ({x, y} or [x, y], world coords): where the jelly is held (e.g. the finger's grip
   * point at drag start); it is firmest there and looser away from it. Sticky: omit it to keep the
   * current anchor, pass null for the centre. It is stored relative to the target pose.
   */
  setTarget(targets, { hz = PHYSICS_TUNING.targetHz, damping, anchor } = {}) {
    if (!targets || targets.length < 2 * this.n) {
      this._target = null;
      if (this._tAnchor) { this._tAnchor = null; this._tDirty = true; }
      return;
    }
    const n = this.n;
    if (!this._tPrev) {
      this._tPrev = new Float64Array(2 * n);
      this._tNext = new Float64Array(2 * n);
      this._tFrac = new Float64Array(n);
      this._tMult = new Float64Array(n);
      this._tDirty = true;
    }
    if (!this._target) this._tFresh = true;
    if (targets !== this._target) this._woken = true;
    this._target = targets;
    this._tHz = Number.isFinite(hz) && hz > 0 ? hz : PHYSICS_TUNING.targetHz;
    this._tDamping = Number.isFinite(damping) && damping >= 0 ? damping : null;
    if (anchor !== undefined) this._setAnchor(anchor, targets);
  }

  // World anchor point → rest-local coords (relative to the target pose's centroid, unrotated
  // by the pose's best-fit rotation). Recomputes the attachment weights when it moved.
  _setAnchor(anchor, targets) {
    let local = null;
    if (anchor) {
      const X = anchor.x ?? anchor[0], Y = anchor.y ?? anchor[1];
      if (!Number.isFinite(X) || !Number.isFinite(Y)) return;
      const q = this._restMorphed ? this._origRest.q : this.q, m = this.m, n = this.n;
      let cx = 0, cy = 0;
      for (let i = 0, i2 = 0; i < n; i++, i2 += 2) { cx += m[i] * targets[i2]; cy += m[i] * targets[i2 + 1]; }
      cx /= this.mass; cy /= this.mass;
      let a00 = 0, a01 = 0, a10 = 0, a11 = 0;
      for (let i = 0, i2 = 0; i < n; i++, i2 += 2) {
        const px = m[i] * (targets[i2] - cx), py = m[i] * (targets[i2 + 1] - cy);
        a00 += px * q[i2]; a01 += px * q[i2 + 1]; a10 += py * q[i2]; a11 += py * q[i2 + 1];
      }
      const th = Math.atan2(a10 - a01, a00 + a11), co = Math.cos(th), si = Math.sin(th);
      const dx = X - cx, dy = Y - cy;
      local = [co * dx + si * dy, -si * dx + co * dy];
      if (!Number.isFinite(local[0]) || !Number.isFinite(local[1])) return;
    }
    const old = this._tAnchor;
    if (!old && !local) return;
    if (old && local && Math.abs(old[0] - local[0]) < 0.5 && Math.abs(old[1] - local[1]) < 0.5) return;
    this._tAnchor = local;
    this._tDirty = true;
  }

  // Attachment frequency multiplier per particle: 1 at the anchor (default: the rest centroid)
  // falling to targetRim at the farthest particle, then normalized so the mass-weighted mean of
  // mult² is 1 (the whole-body follow frequency is exactly hz). Uses the mesh rest shape.
  _updateTargetWeights() {
    const T = PHYSICS_TUNING, mult = this._tMult, m = this.m, n = this.n;
    const rim = clamp(T.targetRim, 0, 1), curve = Math.max(0.1, T.targetCurve);
    const q = this._restMorphed ? this._origRest.q : this.q;
    const ax = this._tAnchor ? this._tAnchor[0] : 0, ay = this._tAnchor ? this._tAnchor[1] : 0;
    let rmax = 0;
    for (let i2 = 0; i2 < 2 * n; i2 += 2) rmax = Math.max(rmax, Math.hypot(q[i2] - ax, q[i2 + 1] - ay));
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const d = rmax > 0 ? 1 - Math.hypot(q[2 * i] - ax, q[2 * i + 1] - ay) / rmax : 1;
      mult[i] = rim + (1 - rim) * Math.pow(clamp(d, 0, 1), curve);
      s2 += m[i] * mult[i] * mult[i];
    }
    const k = s2 > 1e-12 ? Math.sqrt(this.mass / s2) : 1;
    for (let i = 0; i < n; i++) mult[i] *= k;
    this._tRim = T.targetRim; this._tCurve = T.targetCurve;
    this._tDirty = false;
  }

  get target() { return this._target; }

  /**
   * Temporarily re-target the body's rest shape (edge lengths, triangle areas, polygon area and
   * shape matching) to `local`: Float32Array(2n) in world-scale px, any origin (e.g. a morph of
   * restLocal()). O(E + T), allocation-free after the first call, fine to call every frame.
   * null restores the mesh rest shape. body.strain stays relative to the mesh rest shape.
   */
  setRestShape(local) {
    this._woken = true;
    const n = this.n, q = this.q;
    if (!local) {
      if (!this._restMorphed) return;
      const o = this._origRest;
      q.set(o.q); this.edgeLen.set(o.edgeLen); this.triArea.set(o.triArea); this.triG0.set(o.triG0);
      this.polyArea = o.polyArea; this.polyG0 = o.polyG0;
      this._restMorphed = false;
      return;
    }
    if (local.length < 2 * n) return;
    const m = this.m, w = this.w, M = this.mass;
    let cx = 0, cy = 0;
    for (let i = 0, i2 = 0; i < n; i++, i2 += 2) { cx += m[i] * local[i2]; cy += m[i] * local[i2 + 1]; }
    cx /= M; cy /= M;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
    if (!this._origRest) {
      this._origRest = {
        q: new Float64Array(q.length), edgeLen: new Float64Array(this.edgeLen.length),
        triArea: new Float64Array(this.triArea.length), triG0: new Float64Array(this.triG0.length), polyArea: 0, polyG0: 0,
      };
    }
    const o = this._origRest;
    if (!this._restMorphed) { // snapshot the current mesh rest shape (it may have been restored)
      o.q.set(q); o.edgeLen.set(this.edgeLen); o.triArea.set(this.triArea); o.triG0.set(this.triG0);
      o.polyArea = this.polyArea; o.polyG0 = this.polyG0;
    }
    for (let i2 = 0; i2 < 2 * n; i2 += 2) { q[i2] = local[i2] - cx; q[i2 + 1] = local[i2 + 1] - cy; }

    const E = this.edge, L = this.edgeLen;
    for (let k = 0; k < L.length; k++) {
      const i = E[2 * k], j = E[2 * k + 1];
      L[k] = Math.hypot(q[j] - q[i], q[j + 1] - q[i + 1]);
    }

    // Triangles: a morph that flattens or flips one must not ask the solver to invert it.
    const TR = this.tri, A0 = this.triArea, G0 = this.triG0, oA = o.triArea;
    for (let t = 0; t < A0.length; t++) {
      const a = TR[3 * t], b = TR[3 * t + 1], c = TR[3 * t + 2];
      const x0 = q[a], y0 = q[a + 1], x1 = q[b], y1 = q[b + 1], x2 = q[c], y2 = q[c + 1];
      const area = 0.5 * ((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0));
      A0[t] = Math.max(area, 0.05 * oA[t]);
      G0[t] = 0.25 * (w[a >> 1] * ((y1 - y2) ** 2 + (x2 - x1) ** 2) +
                      w[b >> 1] * ((y2 - y0) ** 2 + (x0 - x2) ** 2) +
                      w[c >> 1] * ((y0 - y1) ** 2 + (x1 - x0) ** 2));
    }

    const B = this.bnd, nb = B.length;
    let pa = 0, g0 = 0;
    for (let k = 0; k < nb; k++) {
      const i = B[k], prev = B[k === 0 ? nb - 1 : k - 1], next = B[k === nb - 1 ? 0 : k + 1];
      pa += q[i] * q[next + 1] - q[next] * q[i + 1];
      g0 += w[i >> 1] * 0.25 * ((q[next + 1] - q[prev + 1]) ** 2 + (q[prev] - q[next]) ** 2);
    }
    this.polyArea = Math.max(0.5 * pa, 0.05 * o.polyArea);
    this.polyG0 = g0;
    this._restMorphed = true;
  }

  get restMorphed() { return this._restMorphed; }

  /** Current size as a multiple of the size the body was created at (setSize). */
  get size() { return this._size; }

  /**
   * Grow or shrink the body for good: `s` is the new size as a multiple of the size it was created
   * at (clamped to 0.2–5). Everything that defines its rest shape scales with it — rest positions,
   * edge lengths, triangle and polygon areas — and so do the particle masses (constant density: a
   * bigger jelly is heavier in collisions), the radius that sets its wobble frequencies (bigger =
   * slower, exactly like a jelly spawned at that size), body.scale (renderer) and the strain
   * reference. The particles are NOT moved: the solver eases the body into its new shape over the
   * next frames, so a step reads as a springy swell/shrink. Callers should change it gradually
   * (a few % per frame) and keep the result inside the walls. Works while setRestShape() is active.
   */
  setSize(s) {
    this._woken = true;
    s = clamp(Number(s), 0.2, 5);
    if (!Number.isFinite(s)) return;
    const r = s / this._size;
    if (Math.abs(r - 1) < 1e-6) return;
    const r2 = r * r, n = this.n;
    const scaleRest = (d) => {
      for (let i = 0; i < d.q.length; i++) d.q[i] *= r;
      for (let k = 0; k < d.edgeLen.length; k++) d.edgeLen[k] *= r;
      for (let t = 0; t < d.triArea.length; t++) d.triArea[t] *= r2;
      d.polyArea *= r2;
      // triG0 / polyG0 are Σ w·|∇C|² with w ∝ 1/r² and |∇C|² ∝ r²: unchanged.
    };
    const live = { q: this.q, edgeLen: this.edgeLen, triArea: this.triArea, polyArea: this.polyArea };
    scaleRest(live);
    this.polyArea = live.polyArea;
    if (this._origRest) scaleRest(this._origRest);
    for (let i = 0; i < n; i++) { this.m[i] *= r2; this.w[i] /= r2; this.restIncident[i] *= r2; }
    this.mass *= r2;
    this.restArea *= r2;
    this._radius *= r;
    this.edgeMean *= r;
    this.scale *= r;
    if (this._tAnchor) { this._tAnchor[0] *= r; this._tAnchor[1] *= r; }
    this._tDirty = true;
    this._size = s;
  }

  /**
   * Mesh rest positions × scale, centred on the rest (mass) centroid — the shape the body
   * returns to, in world px. Pose it (add a position) to build setTarget() targets.
   * Always the mesh rest shape, also while setRestShape() is active. Pass `out` to reuse an array.
   */
  restLocal(out) {
    const src = this._restMorphed ? this._origRest.q : this.q, n2 = 2 * this.n;
    const r = out && out.length >= n2 ? out : new Float32Array(n2);
    for (let i = 0; i < n2; i++) r[i] = src[i];
    return r;
  }

  // Start of a world step: target at the start (previous end) and end of this step.
  _beginTarget(span) {
    const src = this._target, A = this._tPrev, B = this._tNext, n2 = 2 * this.n;
    if (this._tFresh) {
      for (let i = 0; i < n2; i++) B[i] = src[i];
      if (!B.every(Number.isFinite)) { this._target = null; return; }
      A.set(B);
      this._tFresh = false;
    } else {
      A.set(B);
      let ok = true;
      for (let i = 0; i < n2; i++) { const v = src[i]; if (Number.isFinite(v)) B[i] = v; else ok = false; }
      if (!ok) B.set(A); // ignore a broken target frame
    }
    this._tInvSpan = 1 / span;
  }

  // Per-step coefficients of the target attachment and damping.
  _setTargetParams(h) {
    const T = PHYSICS_TUNING;
    if (this._tDirty || this._tRim !== T.targetRim || this._tCurve !== T.targetCurve) this._updateTargetWeights();
    const wh = TAU * this._tHz * h, mult = this._tMult, frac = this._tFrac;
    for (let i = 0; i < this.n; i++) { const k = wh * mult[i]; frac[i] = (k * k) / (1 + k * k); } // stepFraction
    this._tKr = Math.exp(-(this._tDamping ?? T.targetDamping) * h);
    this._tKd = Math.exp(-T.targetWobbleDamping * h);
  }

  // Soft attachment to the target interpolated at `alpha` (0..1) through the step.
  _applyTarget(alpha) {
    const x = this.x, A = this._tPrev, B = this._tNext, frac = this._tFrac;
    for (let i = 0, i2 = 0; i < this.n; i++, i2 += 2) {
      const f = frac[i];
      x[i2] += (A[i2] + (B[i2] - A[i2]) * alpha - x[i2]) * f;
      x[i2 + 1] += (A[i2 + 1] + (B[i2 + 1] - A[i2 + 1]) * alpha - x[i2 + 1]) * f;
    }
  }

  // Damping of the velocity relative to the target's: the mean (follow motion) and the
  // deviation from it (wobble) separately.
  _dampTarget() {
    const v = this.v, m = this.m, A = this._tPrev, B = this._tNext, s = this._tInvSpan, n = this.n;
    let mx = 0, my = 0;
    for (let i = 0, i2 = 0; i < n; i++, i2 += 2) {
      mx += m[i] * (v[i2] - (B[i2] - A[i2]) * s);
      my += m[i] * (v[i2 + 1] - (B[i2 + 1] - A[i2 + 1]) * s);
    }
    mx /= this.mass; my /= this.mass;
    const kr = this._tKr, kd = this._tKd, ex = mx * kr, ey = my * kr;
    for (let i2 = 0, n2 = 2 * n; i2 < n2; i2 += 2) {
      const tvx = (B[i2] - A[i2]) * s, tvy = (B[i2 + 1] - A[i2 + 1]) * s;
      v[i2] = tvx + ex + (v[i2] - tvx - mx) * kd;
      v[i2 + 1] = tvy + ey + (v[i2 + 1] - tvy - my) * kd;
    }
  }

  // Kinematic substep: positions = target (interpolated), velocities derived from the motion.
  _kinematicStep(alpha, h) {
    const x = this.x, px = this.px, v = this.v, m = this.m, n = this.n, invH = 1 / h;
    const A = this._target ? this._tPrev : null, B = this._tNext;
    const vmax = PHYSICS_TUNING.maxSpeed, vmax2 = vmax * vmax;
    let Sx = 0, Sy = 0, Px = 0, Py = 0, Lo = 0, Io = 0;
    for (let i = 0, i2 = 0; i < n; i++, i2 += 2) {
      const X0 = x[i2], Y0 = x[i2 + 1];
      px[i2] = X0; px[i2 + 1] = Y0;
      let X = X0, Y = Y0, vx = 0, vy = 0;
      if (A) {
        X = A[i2] + (B[i2] - A[i2]) * alpha; Y = A[i2 + 1] + (B[i2 + 1] - A[i2 + 1]) * alpha;
        vx = (X - X0) * invH; vy = (Y - Y0) * invH;
        const s2 = vx * vx + vy * vy;
        if (s2 > vmax2) { const k = vmax / Math.sqrt(s2); vx *= k; vy *= k; }
      }
      x[i2] = X; x[i2 + 1] = Y; v[i2] = vx; v[i2 + 1] = vy;
      const mi = m[i];
      Sx += mi * X; Sy += mi * Y; Px += mi * vx; Py += mi * vy;
      Lo += mi * (X * vy - Y * vx); Io += mi * (X * X + Y * Y);
    }
    // Rigid motion for contacts and events (as in _finish).
    const M = this.mass, cx = Sx / M, cy = Sy / M, I = Io - M * (cx * cx + cy * cy);
    const rc = this._rc;
    rc.x = cx; rc.y = cy; rc.vx = Px / M; rc.vy = Py / M;
    rc.om = I > 1e-9 ? (Lo - (cx * Py - cy * Px)) / I : 0;
    this._touch = false;
  }

  // --- public helpers -------------------------------------------------------

  center() {
    const x = this.x, m = this.m;
    let sx = 0, sy = 0;
    for (let i = 0, i2 = 0; i < this.n; i++, i2 += 2) { sx += m[i] * x[i2]; sy += m[i] * x[i2 + 1]; }
    return { x: sx / this.mass, y: sy / this.mass };
  }

  velocity() {
    const v = this.v, m = this.m;
    let sx = 0, sy = 0;
    for (let i = 0, i2 = 0; i < this.n; i++, i2 += 2) { sx += m[i] * v[i2]; sy += m[i] * v[i2 + 1]; }
    return { x: sx / this.mass, y: sy / this.mass };
  }

  // Area-equivalent radius in world px.
  radius() { return this._radius; }

  // --- solver internals -----------------------------------------------------

  _setParams(world, h) {
    const T = PHYSICS_TUNING, mat = this.material;
    const soft = clamp(world.jiggle + ((mat.softness ?? 0.5) - 0.5) * T.softnessInfluence, 0, 1);
    const ring = clamp((mat.wobble ?? 0.6) + (world.jiggle - 0.6) * T.wobbleJiggleInfluence, 0, 1);
    // Frequencies scale mildly with size (damping along with them, keeping the damping ratio);
    // local constraints are also stiffened with mesh resolution so the global feel stays the same.
    const fs = Math.pow(T.sizeRadius / this._radius, T.sizeExponent);
    const cells = this._radius / this.edgeMean;
    const we = TAU * fs * lerpGeo(T.edgeHz, soft) * cells;
    this._sEdge = stepFraction(we, h);
    // Implicit edge dashpot with coefficient β·k_edge: removes D/(1+D) of the stretch rate.
    const D = (lerpGeo(T.strainDamping, ring) / fs) * we * we * h;
    this._dashpot = D / (1 + D);
    const wa = TAU * fs * lerpGeo(T.areaHz, soft) * cells * h;
    this._kArea = 1 / (wa * wa);
    const wp = TAU * fs * T.pressureHz * h;
    this._kPress = 1 / (wp * wp);
    this._beta = stepFraction(TAU * (this._healing ? T.healHz : fs * lerpGeo(T.shapeHz, soft)), h);
    this._damp = Math.exp(-fs * lerpGeo(T.deformDamping, ring) * h);
    this._air = Math.exp(-T.airDrag * h);
    this._rest = T.restDamping * h;
    this._squelch = Math.exp(-T.contactDamping * h);
    this._held = this._grabs > 0 ? Math.exp(-T.heldDrag * h) : 1;
    this._glueRange = Math.min(T.glueRange, 0.5 * this.edgeMean);
    this._gluePull = Math.min(lerpGeo(T.glueAccel, clamp(mat.juiciness ?? 0.5, 0, 1)) * h * h, 0.25 * this.edgeMean);
  }

  _integrate(h, g) {
    const x = this.x, px = this.px, v = this.v, n2 = this.n * 2;
    const dvy = g * h;
    for (let i = 0; i < n2; i += 2) {
      v[i + 1] += dvy;
      px[i] = x[i]; px[i + 1] = x[i + 1];
      x[i] += v[i] * h; x[i + 1] += v[i + 1] * h;
    }
  }

  // One XPBD pass per substep (λ starts at 0 each substep): Δλ = −C / (α̃ + ∇C·W·∇C).
  _solve() {
    const x = this.x, px = this.px, w = this.w;

    // Edge lengths + dashpots on the stretch rate of this substep.
    const E = this.edge, L = this.edgeLen, ER = this.edgeRatio, sE = this._sEdge, kd = this._dashpot;
    const ne = L.length;
    for (let k = 0; k < ne; k++) {
      const e2 = k << 1, i = E[e2], j = E[e2 + 1];
      const xi = x[i], yi = x[i + 1], xj = x[j], yj = x[j + 1];
      const dx = xj - xi, dy = yj - yi, d2 = dx * dx + dy * dy;
      if (d2 < 1e-18) continue;
      const rate = (xj - px[j] - xi + px[i]) * dx + (yj - px[j + 1] - yi + px[i + 1]) * dy;
      const c = (1 - L[k] / Math.sqrt(d2)) * sE + (kd * rate) / d2;
      const ci = ER[e2] * c, cj = ER[e2 + 1] * c;
      x[i] = xi + dx * ci; x[i + 1] = yi + dy * ci;
      x[j] = xj - dx * cj; x[j + 1] = yj - dy * cj;
    }

    // Triangle areas (signed, so inverted triangles are pushed back out).
    const TR = this.tri, A0 = this.triArea, G0 = this.triG0, kA = this._kArea, inv = PHYSICS_TUNING.invertedArea;
    const nt = A0.length;
    for (let t = 0; t < nt; t++) {
      const t3 = 3 * t, a = TR[t3], b = TR[t3 + 1], c = TR[t3 + 2];
      const x0 = x[a], y0 = x[a + 1], x1 = x[b], y1 = x[b + 1], x2 = x[c], y2 = x[c + 1];
      const area = 0.5 * ((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0));
      const g0x = 0.5 * (y1 - y2), g0y = 0.5 * (x2 - x1);
      const g1x = 0.5 * (y2 - y0), g1y = 0.5 * (x0 - x2);
      const g2x = 0.5 * (y0 - y1), g2y = 0.5 * (x1 - x0);
      const wa = w[a >> 1], wb = w[b >> 1], wc = w[c >> 1];
      const G = wa * (g0x * g0x + g0y * g0y) + wb * (g1x * g1x + g1y * g1y) + wc * (g2x * g2x + g2y * g2y);
      const denom = G0[t] * kA * (area < inv * A0[t] ? 0.05 : 1) + G;
      if (denom < 1e-12) continue;
      const dl = (A0[t] - area) / denom;
      x[a] = x0 + wa * dl * g0x; x[a + 1] = y0 + wa * dl * g0y;
      x[b] = x1 + wb * dl * g1x; x[b + 1] = y1 + wb * dl * g1y;
      x[c] = x2 + wc * dl * g2x; x[c + 1] = y2 + wc * dl * g2y;
    }

    // Global shape matching: best-fit rotation of the rest shape about the centroid.
    const m = this.m, q = this.q, n = this.n, M = this.mass;
    let sx = 0, sy = 0, a00 = 0, a01 = 0, a10 = 0, a11 = 0;
    for (let i = 0, i2 = 0; i < n; i++, i2 += 2) {
      const X = x[i2] * m[i], Y = x[i2 + 1] * m[i], qx = q[i2], qy = q[i2 + 1];
      sx += X; sy += Y;
      a00 += X * qx; a01 += X * qy; a10 += Y * qx; a11 += Y * qy;
    }
    // Σ m q = 0, so Σ m (x − c) qᵀ = Σ m x qᵀ.
    const cx = sx / M, cy = sy / M;
    const rc = a00 + a11, rs = a10 - a01, rl = Math.sqrt(rc * rc + rs * rs);
    if (rl > 1e-12) {
      const co = rc / rl, si = rs / rl, beta = this._beta;
      for (let i2 = 0, n2 = 2 * n; i2 < n2; i2 += 2) {
        const qx = q[i2], qy = q[i2 + 1];
        x[i2] += (cx + co * qx - si * qy - x[i2]) * beta;
        x[i2 + 1] += (cy + si * qx + co * qy - x[i2 + 1]) * beta;
      }
      // Keep the rotation continuous (unwrapped) for grab pivots and consumers.
      let d = Math.atan2(si, co) - this.angle;
      d -= TAU * Math.round(d / TAU);
      this.angle += d;
    }

    // Whole-body area on the boundary polygon.
    const B = this.bnd, nb = B.length;
    if (nb >= 3) {
      const gr = this._grad;
      let area = 0, G = 0;
      for (let k = 0; k < nb; k++) {
        const i = B[k], prev = B[k === 0 ? nb - 1 : k - 1], next = B[k === nb - 1 ? 0 : k + 1];
        area += x[i] * x[next + 1] - x[next] * x[i + 1];
        const gx = 0.5 * (x[next + 1] - x[prev + 1]), gy = 0.5 * (x[prev] - x[next]);
        gr[2 * k] = gx; gr[2 * k + 1] = gy;
        G += w[i >> 1] * (gx * gx + gy * gy);
      }
      const denom = G + this.polyG0 * this._kPress;
      if (denom > 1e-12) {
        const dl = (this.polyArea - 0.5 * area) / denom;
        for (let k = 0; k < nb; k++) {
          const i = B[k], s = w[i >> 1] * dl;
          x[i] += s * gr[2 * k]; x[i + 1] += s * gr[2 * k + 1];
        }
      }
    }
  }

  // Bounding box of the boundary loop (all particles lie inside it).
  _bbox() {
    const x = this.x, B = this.bnd, bb = this._bb;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < B.length; k++) {
      const X = x[B[k]], Y = x[B[k] + 1];
      if (X < x0) x0 = X;
      if (X > x1) x1 = X;
      if (Y < y0) y0 = Y;
      if (Y > y1) y1 = Y;
    }
    bb[0] = x0; bb[1] = y0; bb[2] = x1; bb[3] = y1;
  }

  // Walls (clamp, Coulomb friction, wet adhesion), velocity update, then damping of the
  // deformation and of slow rigid motion.
  _finish(h, W, H) {
    const T = PHYSICS_TUNING;
    const x = this.x, px = this.px, v = this.v, m = this.m, n = this.n, imp = this._imp, glue = this._glue;
    const heal = this._healing;
    const invH = 1 / h, muK = heal ? 0.3 * T.wallFriction : T.wallFriction;
    // Static friction (never below the kinetic one, so kinetic friction can't push a particle
    // past where it started the substep, e.g. back out through the ceiling in a corner).
    const muS = Math.max(heal ? 0 : T.wallStaticFriction, muK);
    const glueTime = T.glueTime, range = this._glueRange, pull = this._gluePull;
    const vmax = T.maxSpeed, vmax2 = vmax * vmax, top = -H;
    let M = 0, Sx = 0, Sy = 0, Px = 0, Py = 0, Lo = 0, Io = 0;
    let touch = this._touch, touchX = false, touchY = false;

    for (let i = 0, i2 = 0; i < n; i++, i2 += 2) {
      let X = x[i2], Y = x[i2 + 1];
      if (glue[i] > 0 && !heal) { // wet contact: a limited pull back to the surface it pressed on
        glue[i] -= h;
        let held = false;
        if (Y > H - range) { Y += Math.min(Math.max(H - Y, 0), pull); held = true; }
        else if (Y < top + range) { Y -= Math.min(Math.max(Y - top, 0), pull); held = true; }
        if (X < range) { X -= Math.min(Math.max(X, 0), pull); held = true; }
        else if (X > W - range) { X += Math.min(Math.max(W - X, 0), pull); held = true; }
        if (!held) glue[i] = 0; // torn off
      }
      if (Y > H || Y < top) {
        const floor = Y > H, depth = floor ? Y - H : top - Y;
        Y = floor ? H : top;
        touch = touchY = true;
        const dt = X - px[i2];
        if (Math.abs(dt) <= muS * depth) X = px[i2];
        else X -= (dt > 0 ? muK : -muK) * depth;
        const vn = floor ? v[i2 + 1] : -v[i2 + 1]; // pre-solve speed into the surface
        if (vn > 0) {
          glue[i] = glueTime;
          const s = floor ? FLOOR * 4 : CEILING * 4;
          if (vn > imp[s]) imp[s] = vn;
          imp[s + 1] += X; imp[s + 2] += Y; imp[s + 3]++;
        }
      }
      if (X < 0 || X > W) {
        const left = X < 0, depth = left ? -X : X - W;
        X = left ? 0 : W;
        touch = touchX = true;
        const dt = Y - px[i2 + 1];
        if (Math.abs(dt) <= muS * depth) Y = px[i2 + 1];
        else Y -= (dt > 0 ? muK : -muK) * depth;
        const vn = left ? -v[i2] : v[i2];
        if (vn > 0) {
          glue[i] = glueTime;
          const s = left ? LEFT * 4 : RIGHT * 4;
          if (vn > imp[s]) imp[s] = vn;
          imp[s + 1] += X; imp[s + 2] += Y; imp[s + 3]++;
        }
      }
      let nvx = (X - px[i2]) * invH, nvy = (Y - px[i2 + 1]) * invH;
      const s2 = nvx * nvx + nvy * nvy;
      if (s2 > vmax2) { const k = vmax / Math.sqrt(s2); nvx *= k; nvy *= k; }
      x[i2] = X; x[i2 + 1] = Y; v[i2] = nvx; v[i2 + 1] = nvy;
      const mi = m[i];
      M += mi; Sx += mi * X; Sy += mi * Y; Px += mi * nvx; Py += mi * nvy;
      Lo += mi * (X * nvy - Y * nvx); Io += mi * (X * X + Y * Y);
    }

    // Split velocity into rigid (linear + angular about the centroid) and deformation parts.
    const cx = Sx / M, cy = Sy / M;
    const vcx0 = Px / M, vcy0 = Py / M;
    const I = Io - M * (cx * cx + cy * cy);
    const om0 = I > 1e-9 ? (Lo - (cx * Py - cy * Px)) / I : 0;
    const rc = this._rc;
    rc.x = cx; rc.y = cy; rc.vx = vcx0; rc.vy = vcy0; rc.om = om0;
    let vcx = vcx0, vcy = vcy0, om = om0;
    if (touchX) vcx *= this._squelch;
    if (touchY) vcy *= this._squelch;
    if (this._held < 1) { // a held body's swing settles relative to the hand
      const kh = this._held;
      vcx = this._holdVx + (vcx - this._holdVx) * kh;
      vcy = this._holdVy + (vcy - this._holdVy) * kh;
      om *= kh;
    } else if (touch && !this._target) { // a slowly moving body in contact settles instead of creeping or rocking
      const speed = Math.sqrt(vcx * vcx + vcy * vcy) + Math.abs(om) * this._radius;
      if (speed < T.restSpeed) {
        const k = Math.exp(-this._rest * Math.min(1, 2 - (2 * speed) / T.restSpeed));
        vcx *= k; vcy *= k; om *= k;
      }
    }
    this._touch = false;
    const kd = this._damp, ka = this._air;
    for (let i2 = 0, n2 = 2 * n; i2 < n2; i2 += 2) {
      const rx = x[i2] - cx, ry = x[i2 + 1] - cy;
      const dx = v[i2] - vcx0 + om0 * ry, dy = v[i2 + 1] - vcy0 - om0 * rx;
      v[i2] = (vcx - om * ry + dx * kd) * ka;
      v[i2 + 1] = (vcy + om * rx + dy * kd) * ka;
    }
  }

  // Once per step(): NaN guard, jiggle, render copies and strain.
  _finalize(dt) {
    const x = this.x, n = this.n, P = this.positions, m = this.m, M = this.mass;
    let sum = 0;
    for (let i = 0; i < 2 * n; i++) sum += x[i];
    if (!Number.isFinite(sum)) this._reset();

    // Jiggle: peak follower of the RMS deformation speed over this frame (displacement since
    // the last render copy, minus rigid motion); frame-level, so sub-pixel solver chatter is ignored.
    let cx = 0, cy = 0, vx = 0, vy = 0;
    for (let i = 0, i2 = 0; i < n; i++, i2 += 2) {
      cx += m[i] * x[i2]; cy += m[i] * x[i2 + 1];
      vx += m[i] * (x[i2] - P[i2]); vy += m[i] * (x[i2 + 1] - P[i2 + 1]);
    }
    cx /= M; cy /= M; vx /= M; vy /= M;
    this._good.x = cx; this._good.y = cy; this._good.angle = this.angle;
    let L = 0, I = 0;
    for (let i = 0, i2 = 0; i < n; i++, i2 += 2) {
      const rx = x[i2] - cx, ry = x[i2 + 1] - cy;
      L += m[i] * (rx * (x[i2 + 1] - P[i2 + 1] - vy) - ry * (x[i2] - P[i2] - vx));
      I += m[i] * (rx * rx + ry * ry);
    }
    const om = I > 1e-9 ? L / I : 0;
    let E = 0;
    for (let i = 0, i2 = 0; i < n; i++, i2 += 2) {
      const rx = x[i2] - cx, ry = x[i2 + 1] - cy;
      const dx = x[i2] - P[i2] - vx + om * ry, dy = x[i2 + 1] - P[i2 + 1] - vy - om * rx;
      E += m[i] * (dx * dx + dy * dy);
    }
    this._defKE = E / M / (dt * dt);
    const target = clamp(Math.sqrt(this._defKE) / PHYSICS_TUNING.jiggleSpeedRef, 0, 1);
    const decayed = this.jiggle * Math.exp(-dt / PHYSICS_TUNING.jiggleRelease);
    this.jiggle = Number.isFinite(target) && target > decayed ? target : decayed;
    this._syncPositions();

    // Strain: incident deformed area / incident rest area − 1, smoothed.
    const acc = this._scratch, TR = this.tri, RI = this.restIncident, strain = this.strain;
    acc.fill(0);
    let inverted = 0;
    for (let t3 = 0; t3 < TR.length; t3 += 3) {
      const a = TR[t3], b = TR[t3 + 1], c = TR[t3 + 2];
      const area = 0.5 * ((x[b] - x[a]) * (x[c + 1] - x[a + 1]) - (x[c] - x[a]) * (x[b + 1] - x[a + 1]));
      if (area < 0) inverted++;
      acc[a >> 1] += area; acc[b >> 1] += area; acc[c >> 1] += area;
    }
    const ks = 1 - Math.exp(-dt / PHYSICS_TUNING.strainSmoothing);
    for (let i = 0; i < n; i++) strain[i] += (clamp(acc[i] / RI[i] - 1, -0.95, 3) - strain[i]) * ks;
    if (this.kinematic) { this._healing = false; this._tangledFor = 0; }
    else this._updateHealing(dt, cx, cy, inverted);
  }

  // Tangled = folded outline, inverted triangles, or (when still) far from the rest shape.
  _updateHealing(dt, cx, cy, inverted) {
    const T = PHYSICS_TUNING, x = this.x, q = this.q, n = this.n;
    const co = Math.cos(this.angle), si = Math.sin(this.angle);
    let e = 0;
    for (let i2 = 0; i2 < 2 * n; i2 += 2) {
      e += Math.hypot(x[i2] - cx - co * q[i2] + si * q[i2 + 1], x[i2 + 1] - cy - si * q[i2] - co * q[i2 + 1]);
    }
    e /= n * this._radius;
    // A targeted body is held in its pose by the target, which may differ from the rest shape.
    const still = this._grabs === 0 && this.jiggle < 0.15 && !this._target;
    // A crossing outline only counts when the body is also off its rest shape: shapes with
    // narrow crevices touch themselves harmlessly with sub-pixel wiggles.
    const tangled = (this._folded && e > 0.4 * T.healError) || inverted > 0 || (still && e > T.healError);
    this._tangledFor = tangled ? this._tangledFor + dt : 0;
    if (this._tangledFor > T.healDelay) this._healing = true;
    else if (this._healing && !tangled && (e < 0.5 * T.healError || !still)) this._healing = false;
  }

  _syncPositions() {
    const x = this.x, P = this.positions;
    for (let i = 0; i < P.length; i++) P[i] = x[i];
  }

  // Last-resort recovery: rebuild the rest shape at the last good pose, at rest.
  _reset() {
    const g = this._good, q = this.q, x = this.x;
    const co = Math.cos(g.angle), si = Math.sin(g.angle);
    for (let i2 = 0; i2 < q.length; i2 += 2) {
      x[i2] = g.x + co * q[i2] - si * q[i2 + 1];
      x[i2 + 1] = g.y + si * q[i2] + co * q[i2 + 1];
    }
    this.px.set(x);
    this.positions.set(x);
    this.v.fill(0);
    this.angle = g.angle;
    this.strain.fill(0);
    this.jiggle = 0;
    this._glue.fill(0);
    this._healing = false;
    this._tangledFor = 0;
  }

  // Velocity kick along unit (dx,dy): a local gaussian dent + a whole-body squeeze along the
  // direction (both momentum-free), a rigid push and spin from the hit offset.
  _kick(hx, hy, dx, dy, dentSpeed, dentRadius, squeezeSpeed, pushSpeed, spinGain) {
    this._woken = true;
    this._glue.fill(0);
    const x = this.x, v = this.v, m = this.m, n = this.n, M = this.mass, g = this._scratch;
    const c = this.center();
    const inv = 1 / (dentRadius * dentRadius);
    let P = 0, I = 0;
    for (let i = 0, i2 = 0; i < n; i++, i2 += 2) {
      const ex = x[i2] - hx, ey = x[i2 + 1] - hy;
      g[i] = Math.exp(-(ex * ex + ey * ey) * inv);
      P += m[i] * g[i];
      const rx = x[i2] - c.x, ry = x[i2 + 1] - c.y;
      I += m[i] * (rx * rx + ry * ry);
    }
    const mean = P / M, sq = squeezeSpeed / this._radius;
    const dw = I > 1e-9 ? (spinGain * ((hx - c.x) * dy - (hy - c.y) * dx) * M * pushSpeed) / I : 0;
    const vmax = PHYSICS_TUNING.maxSpeed;
    for (let i = 0, i2 = 0; i < n; i++, i2 += 2) {
      const along = (x[i2] - c.x) * dx + (x[i2 + 1] - c.y) * dy;
      const k = dentSpeed * (g[i] - mean) - sq * along + pushSpeed;
      let vx = v[i2] + dx * k - dw * (x[i2 + 1] - c.y);
      let vy = v[i2 + 1] + dy * k + dw * (x[i2] - c.x);
      const s = Math.hypot(vx, vy);
      if (s > vmax) { vx *= vmax / s; vy *= vmax / s; }
      v[i2] = vx; v[i2 + 1] = vy;
    }
  }

  // Uniform velocity change of every particle (keeps the internal wobble).
  _addVelocity(dvx, dvy) {
    this._woken = true;
    this._glue.fill(0);
    const v = this.v;
    for (let i2 = 0; i2 < v.length; i2 += 2) { v[i2] += dvx; v[i2 + 1] += dvy; }
  }
}

// Does a body's boundary loop cross itself (the jelly is folded over)?
function outlineCrosses(body) {
  const x = body.x, B = body.bnd, nb = B.length;
  for (let i = 0; i < nb; i++) {
    const a = B[i], b = B[i + 1 === nb ? 0 : i + 1];
    const ax = x[a], ay = x[a + 1], bx = x[b], by = x[b + 1];
    const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minY = Math.min(ay, by), maxY = Math.max(ay, by);
    for (let j = i + 2; j < nb; j++) {
      if (i === 0 && j === nb - 1) continue; // adjacent through the wrap-around
      const c = B[j], d = B[j + 1 === nb ? 0 : j + 1];
      const cx = x[c], cy = x[c + 1], dx = x[d], dy = x[d + 1];
      if (Math.max(cx, dx) < minX || Math.min(cx, dx) > maxX || Math.max(cy, dy) < minY || Math.min(cy, dy) > maxY) continue;
      const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
      const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

// Ray-casting point-in-polygon on a body's boundary loop.
function containsPoint(body, X, Y) {
  const x = body.x, B = body.bnd, nb = B.length;
  let inside = false;
  for (let k = 0, j = B[nb - 1]; k < nb; k++) {
    const i = B[k], yi = x[i + 1], yj = x[j + 1];
    if ((yi > Y) !== (yj > Y) && X < ((x[j] - x[i]) * (Y - yi)) / (yj - yi) + x[i]) inside = !inside;
    j = i;
  }
  return inside;
}

// Closest point on a body's boundary loop → module scratch `near`.
function closestOnBoundary(body, X, Y) {
  const x = body.x, B = body.bnd, nb = B.length;
  near.d2 = Infinity;
  for (let k = 0, j = B[nb - 1]; k < nb; k++) {
    const i = B[k];
    const ax = x[j], ay = x[j + 1], ex = x[i] - ax, ey = x[i + 1] - ay;
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? clamp(((X - ax) * ex + (Y - ay) * ey) / l2, 0, 1) : 0;
    const qx = ax + ex * t, qy = ay + ey * t;
    const d2 = (qx - X) ** 2 + (qy - Y) ** 2;
    if (d2 < near.d2) { near.d2 = d2; near.x = qx; near.y = qy; }
    j = i;
  }
  return near;
}

export class JellyWorld {
  constructor({ width = 800, height = 600, gravity = 2400 } = {}) {
    this.width = width;
    this.height = height;
    this.gravity = gravity;
    this.bodies = [];
    this.jiggle = 0.6;
    this.gravityOn = true;
    this.collisions = true;  // jelly–jelly contacts (walls always collide)
    this.time = 0;
    this._acc = 0;
    this._foldCheck = 0;
    this._grabs = [];
    this._events = [];
    this._pairs = new Map(); // jelly-jelly contact accumulators + debounce, keyed by id pair
    this.autoSleep = false;  // see "Sleep" at the top of this file
    this.asleep = false;
    this._calm = 0;          // s every body has been still
    this._sleepKey = '';
  }

  /** Leave sleep now (autoSleep worlds; harmless otherwise). */
  wake() {
    this._calm = 0;
    this.asleep = false;
  }

  // autoSleep: true when this step can be skipped (everything still for sleepDelay s).
  _sleeps(dt) {
    const T = PHYSICS_TUNING;
    const key = `${this.gravityOn}|${this.gravity}|${this.jiggle}|${this.collisions}|${this.width}|${this.height}|${this.bodies.length}`;
    let calm = !this._grabs.length && key === this._sleepKey;
    this._sleepKey = key;
    const lim = T.sleepSpeed * T.sleepSpeed;
    for (const b of this.bodies) {
      if (b._woken) { b._woken = false; calm = false; }
      if (!calm) continue;
      if (b._healing || b._tFresh || b.grabbed) { calm = false; continue; }
      const v = b.v;
      for (let i = 0; i < v.length; i += 2) if (v[i] * v[i] + v[i + 1] * v[i + 1] > lim) { calm = false; break; }
      if (!calm || !b._target) continue;
      // A posed body sleeps only while its target pose stands still (it may be edited in place).
      const src = b._target, B = b._tNext;
      for (let i = 0, n2 = 2 * b.n; i < n2; i++) if (Math.abs(src[i] - B[i]) > 1e-3) { calm = false; break; }
    }
    if (!calm) { this._calm = 0; this.asleep = false; return false; }
    this._calm += Math.min(dt, T.maxFrameDt);
    this.asleep = this._calm >= T.sleepDelay;
    return this.asleep;
  }

  resize(width, height) {
    this.wake();
    this.width = width;
    this.height = height;
    // Shift bodies rigidly back inside instead of letting the walls crush them.
    for (const b of this.bodies) {
      b._bbox();
      const [x0, , x1, y1] = b._bb;
      let dx = 0, dy = 0;
      if (x1 > width) dx = width - x1;
      if (x0 + dx < 0) dx = -x0;
      if (y1 > height) dy = height - y1;
      if (dx || dy) {
        for (let i2 = 0; i2 < b.x.length; i2 += 2) {
          b.x[i2] += dx; b.x[i2 + 1] += dy; b.px[i2] += dx; b.px[i2 + 1] += dy;
        }
        b._syncPositions();
      }
    }
  }

  addBody(mesh, opts = {}) {
    const body = new JellyBody(mesh, opts);
    this.bodies.push(body);
    this.wake();
    return body;
  }

  removeBody(body) {
    const k = this.bodies.indexOf(body);
    if (k < 0) return;
    this.wake();
    this.bodies.splice(k, 1);
    for (const g of this._grabs.filter(g => g.body === body)) this._detach(g);
    for (const [key, p] of this._pairs) if (p.a === body || p.b === body) this._pairs.delete(key);
  }

  clear() {
    this.wake();
    for (const g of this._grabs) this._detach(g, false);
    this._grabs.length = 0;
    this.bodies.length = 0;
    this._pairs.clear();
  }

  bringToFront(body) {
    const k = this.bodies.indexOf(body);
    if (k >= 0 && k !== this.bodies.length - 1) {
      this.bodies.splice(k, 1);
      this.bodies.push(body);
    }
  }

  // --- simulation -------------------------------------------------------------

  step(dt) {
    const T = PHYSICS_TUNING;
    if (!(dt > 0)) return;
    if (this.autoSleep && this._sleeps(dt)) {
      this.time += Math.min(dt, T.maxFrameDt);
      this._acc = 0;
      return;
    }
    const h = 1 / T.substepHz;
    this._acc += Math.min(dt, T.maxFrameDt);
    const steps = Math.floor(this._acc / h + 1e-6);
    if (steps <= 0) return;
    this._acc = Math.max(0, this._acc - steps * h);
    const span = steps * h;
    const bodies = this.bodies;

    // Pointer velocity per grab (targets are interpolated across this step's substeps).
    for (const b of bodies) { b._holdVx = 0; b._holdVy = 0; b._imp.fill(0); }
    for (const g of this._grabs) {
      g.vx = (g.x - g.sx) / span;
      g.vy = (g.y - g.sy) / span;
      g.body._holdVx += g.vx / g.body._grabs;
      g.body._holdVy += g.vy / g.body._grabs;
    }
    for (const b of bodies) {
      b._setParams(this, h);
      if (b._target) {
        b._beginTarget(span);
        if (b._target) b._setTargetParams(h);
      }
    }
    for (const p of this._pairs.values()) { p.max = 0; p.sx = 0; p.sy = 0; p.cnt = 0; }

    const grav = this.gravityOn ? this.gravity : 0;
    const beta = stepFraction(TAU * T.grabHz, h);
    const grabVel = 1 - Math.exp(-T.grabDamping * h);
    const collide = this.collisions !== false;
    for (let s = 1; s <= steps; s++) {
      const alpha = s / steps;
      for (let k = 0; k < bodies.length; k++) if (!bodies[k].kinematic) bodies[k]._integrate(h, grav);
      for (let k = 0; k < bodies.length; k++) if (!bodies[k].kinematic) bodies[k]._solve();
      this._applyGrabs(alpha, beta);
      for (let k = 0; k < bodies.length; k++) {
        const b = bodies[k];
        if (b.kinematic) b._kinematicStep(alpha, h);
        else if (b._target) b._applyTarget(alpha);
      }
      if (collide) this._collideAll();
      for (let k = 0; k < bodies.length; k++) if (!bodies[k].kinematic) bodies[k]._finish(h, this.width, this.height);
      this._dampGrabs(grabVel);
      for (let k = 0; k < bodies.length; k++) {
        const b = bodies[k];
        if (b._target && !b.kinematic) b._dampTarget();
      }
      this.time += h;
    }

    for (const g of this._grabs) { g.sx = g.x; g.sy = g.y; }
    // Fold check: one body per step round-robin, healing bodies every step.
    if (bodies.length) this._foldCheck = (this._foldCheck + 1) % bodies.length;
    for (let k = 0; k < bodies.length; k++) {
      if (k === this._foldCheck || bodies[k]._healing) bodies[k]._folded = outlineCrosses(bodies[k]);
    }
    for (const b of bodies) b._finalize(span);
    this._emitEvents();
  }

  _applyGrabs(alpha, beta) {
    const pivot = PHYSICS_TUNING.grabPivot;
    for (const g of this._grabs) {
      if (g.body.kinematic) continue;
      const x = g.body.x, idx = g.idx, wt = g.wt, off = g.off;
      const tx = g.sx + (g.x - g.sx) * alpha, ty = g.sy + (g.y - g.sy) * alpha;
      const da = (g.body.angle - g.angle0) * pivot;
      const co = Math.cos(da), si = Math.sin(da);
      for (let k = 0; k < idx.length; k++) {
        const i2 = idx[k], ox = off[2 * k], oy = off[2 * k + 1], f = beta * wt[k];
        x[i2] += (tx + co * ox - si * oy - x[i2]) * f;
        x[i2 + 1] += (ty + si * ox + co * oy - x[i2 + 1]) * f;
      }
    }
  }

  _dampGrabs(k) {
    for (const g of this._grabs) {
      if (g.body.kinematic) continue;
      const v = g.body.v, idx = g.idx, wt = g.wt;
      for (let j = 0; j < idx.length; j++) {
        const i2 = idx[j], f = k * wt[j];
        v[i2] += (g.vx - v[i2]) * f;
        v[i2 + 1] += (g.vy - v[i2 + 1]) * f;
      }
    }
  }

  _collideAll() {
    const bodies = this.bodies, nb = bodies.length;
    if (nb < 2) return;
    for (let k = 0; k < nb; k++) bodies[k]._bbox();
    for (let i = 0; i < nb; i++) {
      const A = bodies[i], ba = A._bb;
      for (let j = i + 1; j < nb; j++) {
        const B = bodies[j], bb = B._bb;
        if (ba[0] > bb[2] || bb[0] > ba[2] || ba[1] > bb[3] || bb[1] > ba[3]) continue;
        if (A.kinematic && B.kinematic) continue;
        const pair = this._pair(A, B);
        this._collideInto(A, B, pair);
        this._collideInto(B, A, pair);
      }
    }
  }

  _pair(A, B) {
    const key = A.id < B.id ? A.id * 1048576 + B.id : B.id * 1048576 + A.id;
    let p = this._pairs.get(key);
    if (!p) {
      p = { a: A, b: B, max: 0, sx: 0, sy: 0, cnt: 0, last: -1e9 };
      this._pairs.set(key, p);
    }
    return p;
  }

  // Pushes A's boundary particles out of B's polygon (point vs nearest edge, split by
  // inverse mass) with Coulomb friction on the relative tangential motion. Kinematic bodies
  // have infinite mass (they push, but are never pushed).
  _collideInto(A, B, pair) {
    const T = PHYSICS_TUNING, muS = T.jellyStaticFriction, muK = T.jellyFriction;
    const ax = A.x, apx = A.px, aw = A.w, AB = A.bnd, ra = A._rc, ka = A.kinematic ? 0 : 1;
    const bx = B.x, bpx = B.px, bw = B.w, BB = B.bnd, nb = BB.length, rb = B._rc, kb = B.kinematic ? 0 : 1;
    const box = B._bb, x0 = box[0], y0 = box[1], x1 = box[2], y1 = box[3];

    for (let k = 0; k < AB.length; k++) {
      const p = AB[k], X = ax[p], Y = ax[p + 1];
      if (X < x0 || X > x1 || Y < y0 || Y > y1) continue;

      // One sweep: point-in-polygon parity + nearest boundary edge.
      let inside = false, best = Infinity, be = 0, bt = 0;
      for (let e = 0, j = BB[nb - 1]; e < nb; e++) {
        const i = BB[e];
        const xj = bx[j], yj = bx[j + 1], xi = bx[i], yi = bx[i + 1];
        if ((yi > Y) !== (yj > Y) && X < ((xj - xi) * (Y - yi)) / (yj - yi) + xi) inside = !inside;
        const ex = xi - xj, ey = yi - yj, l2 = ex * ex + ey * ey;
        let t = l2 > 0 ? ((X - xj) * ex + (Y - yj) * ey) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = xj + ex * t - X, qy = yj + ey * t - Y, d2 = qx * qx + qy * qy;
        if (d2 < best) { best = d2; be = e; bt = t; }
        j = i;
      }
      if (!inside) continue;

      const ia = BB[be === 0 ? nb - 1 : be - 1], ib = BB[be];
      const t = bt, s = 1 - t, d = Math.sqrt(best);
      let nx, ny;
      if (d > 1e-7) {
        nx = (bx[ia] * s + bx[ib] * t - X) / d;
        ny = (bx[ia + 1] * s + bx[ib + 1] * t - Y) / d;
      } else { // exactly on the edge: use its outward normal
        const ex = bx[ib] - bx[ia], ey = bx[ib + 1] - bx[ia + 1], el = Math.hypot(ex, ey) || 1;
        nx = ey / el; ny = -ex / el;
      }
      const wp = ka * aw[p >> 1], wa = kb * bw[ia >> 1], wb = kb * bw[ib >> 1];
      const denom = wp + s * s * wa + t * t * wb;
      if (!(denom > 1e-12)) continue;
      A._touch = B._touch = true;

      // Approach speed of the two bodies' rigid motions at the contact → collide event
      // (particle velocities would also report sub-pixel contact chatter and wobble).
      const vn = -((ra.vx - ra.om * (Y - ra.y) - rb.vx + rb.om * (Y - rb.y)) * nx +
                   (ra.vy + ra.om * (X - ra.x) - rb.vy - rb.om * (X - rb.x)) * ny);
      if (vn > 0) {
        if (vn > pair.max) pair.max = vn;
        pair.sx += X; pair.sy += Y; pair.cnt++;
      }

      // Normal projection.
      const dl = d / denom;
      ax[p] += wp * dl * nx; ax[p + 1] += wp * dl * ny;
      bx[ia] -= s * wa * dl * nx; bx[ia + 1] -= s * wa * dl * ny;
      bx[ib] -= t * wb * dl * nx; bx[ib + 1] -= t * wb * dl * ny;

      // Friction on the relative tangential displacement of this substep.
      const rx = (ax[p] - apx[p]) - (bx[ia] - bpx[ia]) * s - (bx[ib] - bpx[ib]) * t;
      const ry = (ax[p + 1] - apx[p + 1]) - (bx[ia + 1] - bpx[ia + 1]) * s - (bx[ib + 1] - bpx[ib + 1]) * t;
      const rn = rx * nx + ry * ny;
      const tx = rx - rn * nx, ty = ry - rn * ny, tl = Math.sqrt(tx * tx + ty * ty);
      if (tl > 1e-9) {
        const corr = tl <= muS * d ? tl : Math.min(tl, muK * d);
        const f = corr / (denom * tl);
        ax[p] -= wp * f * tx; ax[p + 1] -= wp * f * ty;
        bx[ia] += s * wa * f * tx; bx[ia + 1] += s * wa * f * ty;
        bx[ib] += t * wb * f * tx; bx[ib + 1] += t * wb * f * ty;
      }
    }
  }

  _emitEvents() {
    const T = PHYSICS_TUNING, now = this.time;
    for (const b of this.bodies) {
      const imp = b._imp;
      for (let s = 0; s < 4; s++) {
        const cnt = imp[4 * s + 3];
        if (!cnt) continue;
        const intensity = clamp(imp[4 * s] / T.impactSpeedRef, 0, 1);
        if (intensity < T.eventThreshold || now - b._lastImp[s] < T.eventDebounce) continue;
        b._lastImp[s] = now;
        const nrm = SURFACE_NORMALS[s];
        this._events.push({
          type: 'impact', body: b, x: imp[4 * s + 1] / cnt, y: imp[4 * s + 2] / cnt,
          nx: nrm[0], ny: nrm[1], intensity,
        });
      }
    }
    for (const p of this._pairs.values()) {
      if (!p.cnt) continue;
      const intensity = clamp(p.max / T.impactSpeedRef, 0, 1);
      if (intensity < T.eventThreshold || now - p.last < T.eventDebounce) continue;
      p.last = now;
      this._events.push({ type: 'collide', a: p.a, b: p.b, x: p.sx / p.cnt, y: p.sy / p.cnt, intensity });
    }
  }

  drainEvents() {
    const ev = this._events;
    this._events = [];
    return ev;
  }

  // --- interaction --------------------------------------------------------------

  pick(x, y) {
    for (let k = this.bodies.length - 1; k >= 0; k--) {
      const b = this.bodies[k];
      if (this._near(b, x, y, 10)) return b;
    }
    return null;
  }

  // True when (x,y) is inside the body or within `reach` px of its outline.
  _near(b, x, y, reach) {
    b._bbox();
    const bb = b._bb;
    if (x < bb[0] - reach || x > bb[2] + reach || y < bb[1] - reach || y > bb[3] + reach) return false;
    return containsPoint(b, x, y) || (reach > 0 && closestOnBoundary(b, x, y).d2 <= reach * reach);
  }

  grab(x, y, pointerId) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const body = this.pick(x, y);
    if (!body) return null;
    const T = PHYSICS_TUNING;
    this.bringToFront(body);

    // Attach the particles around the point with a smooth falloff.
    const r = Math.max(T.grabRadiusMin, T.grabRadiusFactor * body.radius());
    const bx = body.x, n = body.n;
    let idx = [], wt = [];
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(bx[2 * i] - x, bx[2 * i + 1] - y);
      if (d < r) { idx.push(i); const f = 1 - (d / r) ** 2; wt.push(f * f); }
    }
    if (idx.length < 3) { // sparse spot: take the nearest few particles
      const dist = i => Math.hypot(bx[2 * i] - x, bx[2 * i + 1] - y);
      idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => dist(a) - dist(b)).slice(0, Math.min(3, n));
      wt = idx.map((_, k) => 1 - 0.2 * k);
    }
    const maxW = Math.max(...wt);
    const handle = {
      id: ++grabCounter, pointerId, body, active: true,
      x, y, sx: x, sy: y, vx: 0, vy: 0, angle0: body.angle,
      idx: Int32Array.from(idx, i => 2 * i),
      wt: Float64Array.from(wt, v => v / maxW),
      off: new Float64Array(2 * idx.length),
    };
    idx.forEach((i, k) => { handle.off[2 * k] = bx[2 * i] - x; handle.off[2 * k + 1] = bx[2 * i + 1] - y; });
    this._grabs.push(handle);
    this.wake();
    body._grabs++;
    body.grabbed = true;
    return handle;
  }

  moveGrab(handle, x, y) {
    if (!handle || !handle.active || !Number.isFinite(x) || !Number.isFinite(y)) return;
    handle.x = clamp(x, 0, this.width);
    handle.y = clamp(y, -this.height, this.height);
  }

  releaseGrab(handle, vx = 0, vy = 0) {
    if (!handle || !handle.active) return;
    const body = handle.body;
    this._detach(handle);
    if (body._grabs > 0 || !Number.isFinite(vx) || !Number.isFinite(vy)) return;
    // Throw: blend the rigid velocity towards the flick, keep the internal wobble.
    const T = PHYSICS_TUNING;
    const s = Math.hypot(vx, vy);
    if (s > T.throwMax) { vx *= T.throwMax / s; vy *= T.throwMax / s; }
    const v = body.velocity();
    body._addVelocity((vx - v.x) * T.throwBlend, (vy - v.y) * T.throwBlend);
  }

  _detach(handle, unlist = true) {
    handle.active = false;
    if (unlist) {
      const k = this._grabs.indexOf(handle);
      if (k >= 0) this._grabs.splice(k, 1);
    }
    const body = handle.body;
    body._grabs = Math.max(0, body._grabs - 1);
    body.grabbed = body._grabs > 0;
  }

  slap(x, y, dx, dy, strength) {
    const T = PHYSICS_TUNING;
    const miss = { hit: false, body: null, intensity: 0, x, y };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return miss;
    // Topmost body containing the point, else the nearest outline within reach.
    let body = null, hx = x, hy = y;
    for (let k = this.bodies.length - 1; k >= 0 && !body; k--) {
      if (this._near(this.bodies[k], x, y, 0)) body = this.bodies[k];
    }
    if (!body) {
      let best = T.slapReach * T.slapReach;
      for (let k = this.bodies.length - 1; k >= 0; k--) {
        const b = this.bodies[k];
        if (!this._near(b, x, y, T.slapReach)) continue;
        const c = closestOnBoundary(b, x, y);
        if (c.d2 < best) { best = c.d2; body = b; hx = c.x; hy = c.y; }
      }
    }
    if (!body) return miss;

    const c = body.center();
    let len = Math.hypot(dx, dy);
    if (!(len > 1e-9) || !Number.isFinite(len)) { dx = c.x - hx; dy = c.y - hy; len = Math.hypot(dx, dy) || 1; }
    dx /= len; dy /= len;
    strength = clamp(Number.isFinite(strength) ? strength : 1, 0, 1.5);

    // A body already moving away along the swipe takes less of the hit.
    const hand = T.slapSpeed * strength;
    const v = body.velocity();
    const eff = hand > 0 ? clamp(1 - (v.x * dx + v.y * dy) / hand, 0, 1) : 0;
    const speed = hand * eff;
    body._kick(hx, hy, dx, dy, speed * T.slapDent, T.slapRadius * body.radius(), speed * T.slapSqueeze,
      speed * T.slapTransfer, T.slapSpin);
    const intensity = clamp(strength * eff * 0.8, 0, 1);
    body.jiggle = Math.max(body.jiggle, intensity);
    return { hit: true, body, intensity, x: hx, y: hy };
  }

  shake(strength = 1) {
    this.wake();
    const T = PHYSICS_TUNING;
    strength = clamp(Number.isFinite(strength) ? strength : 1, 0, 2);
    for (const b of this.bodies) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6; // mostly upwards
      const dx = Math.cos(a), dy = Math.sin(a);
      const speed = T.shakeSpeed * strength * (0.55 + 0.45 * Math.random());
      const k = b.bnd[Math.floor(Math.random() * b.bnd.length)] ?? 0;
      b._kick(b.x[k], b.x[k + 1], dx, dy, speed * 0.9, T.slapRadius * b.radius(), speed * T.slapSqueeze, speed,
        (Math.random() - 0.5) * 0.6);
      b.jiggle = Math.max(b.jiggle, clamp(strength * 0.7, 0, 1));
    }
  }
}
