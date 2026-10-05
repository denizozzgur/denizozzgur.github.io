// Pointer input → jelly world. Every pointerId is independent, so two fingers can
// grab one jelly and stretch it, or one hand can hold while the other slaps.
//   down on a jelly   → grab; move → drag; up → throw with the last ~80 ms of velocity
//   quick tap on one  → poke: a small slap toward its centre
//   down on empty space, then a fast swipe through jellies → slap along the swipe
//   right mouse button on a jelly → strong slap
//   two fingers on the same jelly → pinch: it grows / shrinks with the finger spread (it is let go
//     while it resizes, so it can swell against the floor and walls; the finger that stays on it
//     afterwards picks it up again)
//   mouse wheel (or a trackpad pinch) over a jelly → grow / shrink it
// The stage fills the viewport at (0,0), so clientX/Y are world coordinates.

const TAP_MS = 170;
const TAP_PX = 6;
const THROW_WINDOW_MS = 80;
const SWIPE_WINDOW_MS = 50;
const TRAIL_MS = 160;
const SWIPE_MIN_SPEED = 900;    // px/s
const SWIPE_FULL_SPEED = 3200;  // px/s for strength 1
const SLAP_COOLDOWN_MS = 140;   // per jelly, per pointer
const PROBE_STEP = 6;           // px between pick() probes along a swipe segment
const POKE_STRENGTH = 0.5;
const RIGHT_SLAP_STRENGTH = 1.25;
const PINCH_MIN_SPAN = 24;      // px: closer fingers are treated as this far apart (no runaway ratios)
const WHEEL_GAIN = 0.0015;      // size change per px of wheel delta (a mouse notch ≈ 100 px → ×1.16)
const WHEEL_PINCH_GAIN = 0.01;  // trackpad pinch (ctrl + wheel) sends small deltas

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * hooks: {
 *   interact(),                        any pointer down on the stage
 *   grab(body),                        a hold or drag began (not for a quick tap, which pokes)
 *   release(body, speed),              thrown (speed in px/s, may be ~0)
 *   slap(result, dx, dy, kind),        result from world.slap; kind: 'swipe' | 'poke' | 'strong'
 *   pinchStart(body),                  a second finger landed on a jelly that is already held
 *   pinch(body, ratio),                finger spread / spread at pinch start
 *   pinchEnd(body),                    one of the two fingers let go
 *   wheel(body, factor),               wheel / trackpad pinch over a jelly: multiply its size by factor
 * }
 */
export class JellyInput {
  constructor(stage, world, hooks) {
    this.stage = stage;
    this.world = world;
    this.hooks = hooks;
    this.pointers = new Map();
    this.pinches = new Map(); // body → { a, b: pointerIds, span0 }
    this.hover = null;      // last mouse position over the stage, or null
    this.mouseTrail = [];   // recent mouse samples (right-click slap direction)
    this._cursor = '';

    stage.addEventListener('pointerdown', (e) => this._down(e));
    stage.addEventListener('pointermove', (e) => this._move(e));
    stage.addEventListener('pointerup', (e) => this._up(e, false));
    stage.addEventListener('pointercancel', (e) => this._up(e, true));
    stage.addEventListener('lostpointercapture', (e) => this._up(e, true));
    stage.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.hover = null;
    });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
  }

  /** Per frame: announces holds and keeps the cursor right while jellies move under a still mouse. */
  update() {
    const now = performance.now();
    let cursor = '';
    for (const p of this.pointers.values()) {
      if (!p.handle) continue;
      if (now - p.t0 >= TAP_MS) this._announce(p);
      if (p.type === 'mouse') cursor = 'grabbing';
    }
    if (!cursor && this.hover && this.world.pick(this.hover.x, this.hover.y)) cursor = 'grab';
    if (cursor !== this._cursor) this.stage.style.cursor = this._cursor = cursor;
  }

  /** The jelly under the mouse (for Delete), or null. */
  hovered() {
    return this.hover ? this.world.pick(this.hover.x, this.hover.y) : null;
  }

  /** Forget pointers holding a jelly that was removed from the world. */
  forget(body) {
    for (const [id, p] of this.pointers) if (p.body === body) this.pointers.delete(id);
    this.pinches.delete(body);
  }

  reset() {
    this.pointers.clear();
    this.pinches.clear();
  }

  /** The two pointers pinching `body`, or null. */
  pinching(body) {
    return this.pinches.get(body) || null;
  }

  // --- events -----------------------------------------------------------------------

  _down(e) {
    this.hooks.interact();
    if (e.pointerType === 'mouse' && e.button === 2) {
      this._strongSlap(e);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone (or synthetic): events still arrive while over the stage
    }

    const x = e.clientX, y = e.clientY, t = e.timeStamp;
    const p = {
      type: e.pointerType, handle: null, body: null, announced: false,
      x0: x, y0: y, t0: t, travel: 0, x, y,
      trail: [{ t, x, y }],
      lastSlap: new Map(), // body.id → time
    };
    p.handle = this.world.grab(x, y, e.pointerId);
    if (p.handle) p.body = p.handle.body;
    this.pointers.set(e.pointerId, p);
    if (p.body && !this.pinches.has(p.body)) {
      // A second finger on a held jelly: pinch to resize. Both grips let go (a jelly pinned at two
      // points can't grow without crumpling against the floor); the fingers only measure the spread.
      for (const [id, o] of this.pointers) {
        if (id === e.pointerId || o.body !== p.body || !o.handle) continue;
        this._announce(o);
        const v = p.body.velocity();
        for (const q of [o, p]) { this.world.releaseGrab(q.handle, v.x, v.y); q.handle = null; q.pinch = true; }
        this.pinches.set(p.body, { a: id, b: e.pointerId, span0: Math.max(PINCH_MIN_SPAN, Math.hypot(x - o.x, y - o.y)) });
        this.hooks.pinchStart?.(p.body);
        break;
      }
    }
  }

  // The grab sound waits until the press is clearly a hold or a drag, so a tap is a clean smack.
  _announce(p) {
    if (p.announced) return;
    p.announced = true;
    this.hooks.grab(p.body);
  }

  _move(e) {
    if (e.pointerType === 'mouse') {
      this.hover = { x: e.clientX, y: e.clientY };
      pushTrail(this.mouseTrail, e.timeStamp, e.clientX, e.clientY);
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    // Coalesced samples give a denser swipe path and a better throw velocity.
    const samples = e.getCoalescedEvents?.() ?? [];
    for (const s of samples.length ? samples : [e]) {
      const x = s.clientX, y = s.clientY, t = s.timeStamp;
      const prev = p.trail[p.trail.length - 1];
      pushTrail(p.trail, t, x, y);
      p.travel = Math.max(p.travel, Math.hypot(x - p.x0, y - p.y0));
      if (!p.handle && !p.pinch) this._swipe(p, prev, x, y, t);
    }
    p.x = e.clientX; p.y = e.clientY;
    if (p.pinch) {
      const pinch = this.pinches.get(p.body);
      const o = pinch && this.pointers.get(pinch.a === e.pointerId ? pinch.b : pinch.a);
      if (o) this.hooks.pinch?.(p.body, Math.max(PINCH_MIN_SPAN, Math.hypot(p.x - o.x, p.y - o.y)) / pinch.span0);
      return;
    }
    if (!p.handle) return;
    if (p.travel >= TAP_PX) this._announce(p);
    this.world.moveGrab(p.handle, e.clientX, e.clientY);
  }

  _up(e, cancelled) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.pinch) {
      // One finger up ends the pinch; the other one picks the jelly up again where it now is.
      const pinch = this.pinches.get(p.body);
      if (!pinch) return;
      this.pinches.delete(p.body);
      this.hooks.pinchEnd?.(p.body);
      const id = pinch.a === e.pointerId ? pinch.b : pinch.a, o = this.pointers.get(id);
      if (o) {
        o.pinch = false;
        o.handle = this.world.grab(o.x, o.y, id);
        o.body = o.handle ? o.handle.body : null;
        o.trail = [{ t: e.timeStamp, x: o.x, y: o.y }];
      }
      return;
    }
    if (!p.handle) return;

    const x = e.clientX, y = e.clientY, t = e.timeStamp;
    if (!cancelled && t - p.t0 < TAP_MS && p.travel < TAP_PX) {
      // Let go without changing how the jelly moves, then poke it.
      const v0 = p.body.velocity();
      this.world.releaseGrab(p.handle, v0.x, v0.y);
      const c = p.body.center();
      const [dx, dy] = unit(c.x - x, c.y - y, 0, 1);
      const result = this.world.slap(x, y, dx, dy, POKE_STRENGTH);
      if (result.hit) this.hooks.slap(result, dx, dy, 'poke');
      return;
    }
    const v = cancelled ? { x: 0, y: 0 } : velocity(p.trail, t, x, y, THROW_WINDOW_MS);
    this.world.releaseGrab(p.handle, v.x, v.y);
    this.hooks.release(p.body, Math.hypot(v.x, v.y));
  }

  /** Wheel / trackpad pinch over a jelly resizes it; elsewhere the wheel is left alone. */
  _wheel(e) {
    const body = this.world.pick(e.clientX, e.clientY);
    if (!body || !this.hooks.wheel) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const d = clamp((Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit, -400, 400);
    if (!d) return;
    this.hooks.interact();
    this.hooks.wheel(body, Math.exp(-d * (e.ctrlKey ? WHEEL_PINCH_GAIN : WHEEL_GAIN)));
  }

  // --- slaps --------------------------------------------------------------------------

  /** Fast swipe from empty space: probe the segment prev→(x,y) and slap every jelly it crosses. */
  _swipe(p, prev, x, y, t) {
    const v = velocity(p.trail, t, x, y, SWIPE_WINDOW_MS);
    const speed = Math.hypot(v.x, v.y);
    const dx = x - prev.x, dy = y - prev.y;
    const len = Math.hypot(dx, dy);
    if (speed < SWIPE_MIN_SPEED || len < 0.5) return;
    const ux = dx / len, uy = dy / len;
    const strength = clamp(speed / SWIPE_FULL_SPEED, 0.25, 1.3);
    const steps = Math.ceil(len / PROBE_STEP);
    for (let k = 1; k <= steps; k++) {
      const sx = prev.x + (dx * k) / steps, sy = prev.y + (dy * k) / steps;
      const body = this.world.pick(sx, sy);
      if (!body || t - (p.lastSlap.get(body.id) ?? -Infinity) < SLAP_COOLDOWN_MS) continue;
      p.lastSlap.set(body.id, t);
      const result = this.world.slap(sx, sy, ux, uy, strength);
      if (result.hit) this.hooks.slap(result, ux, uy, 'swipe');
    }
  }

  /** Right click: hit along the mouse's recent motion, or into the jelly if it was still. */
  _strongSlap(e) {
    const x = e.clientX, y = e.clientY;
    const body = this.world.pick(x, y);
    if (!body) return;
    const v = velocity(this.mouseTrail, e.timeStamp, x, y, THROW_WINDOW_MS);
    const c = body.center();
    const [dx, dy] = Math.hypot(v.x, v.y) > 250 ? unit(v.x, v.y) : unit(c.x - x, c.y - y, 0, 1);
    const result = this.world.slap(x, y, dx, dy, RIGHT_SLAP_STRENGTH);
    if (result.hit) this.hooks.slap(result, dx, dy, 'strong');
  }
}

function pushTrail(trail, t, x, y) {
  trail.push({ t, x, y });
  while (trail.length > 2 && t - trail[0].t > TRAIL_MS) trail.shift();
}

/**
 * Velocity (px/s) of the pointer arriving at (x, y) at time t, measured from the newest
 * trail sample that is at least `windowMs` old (or the oldest one there is). A pointer
 * that rested before release therefore reports ~0 instead of its last flick.
 */
function velocity(trail, t, x, y, windowMs) {
  let ref = null;
  for (let i = trail.length - 1; i >= 0; i--) {
    ref = trail[i];
    if (t - trail[i].t > windowMs) break;
  }
  if (!ref) return { x: 0, y: 0 };
  const dt = Math.max(t - ref.t, 16) / 1000;
  return { x: (x - ref.x) / dt, y: (y - ref.y) / dt };
}

function unit(x, y, fx = 1, fy = 0) {
  const len = Math.hypot(x, y);
  return len > 1e-6 ? [x / len, y / len] : [fx, fy];
}
