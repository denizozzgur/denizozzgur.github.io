// Procedural WebAudio sound effects for Jellymama.
//
// Nothing is sampled: every sound is layered noise, oscillators, filters and envelopes,
// re-randomized on each call so repeats never sound identical. Signal flow:
//
//   voice → voice gain → StereoPanner → bus → 30 Hz high-pass ─┬→ saturation → compressor → master → soft clip → out
//                                                              └→ room send → convolver ──┘
//
// Voices are plain functions (ctx, dest, params) → duration in seconds, so they render the same
// way into an OfflineAudioContext (tests/audio-test.js uses that for level checks).
//
// Squeeze Out! (the jam puzzle built on the jelly) adds its own voices further down: land,
// slide, bump, squeezeThrough, squeezeFail, exit, iceCrack, tick, win, lose (soft falling chime), uiTap, reveal.
// `audio.mode = 'solid'` swaps the material voices for dry plastic ones (the A/B control).
//
// Progression (docs/build-contracts.md §8) adds the 12 mechanics' voices (peel, mouldSet, snore,
// yawn, taffyStretch, tear, bloop, breathe, strain, rail, sizzle, melt, gloop, dye, pop, padlock,
// gulp, ding, plip), the meta ceremonies (chest, unlock({ rarity })) and the character voices
// (voice({ type, pitch }), VOICE_TYPES). Levels are balanced against exit() with the offline check
// in tests/audio-test.html ("Offline check · Progression").

import { MATERIALS } from './materials.js';
import { JellyMusic } from './music.js';

const MAX_VOICES = 16;
const TYPE_CAP = {
  slap: 5, impact: 6, collide: 4, grab: 2, release: 3, squish: 4, spawn: 3,
  land: 6, slide: 4, bump: 3, squeezeThrough: 2, squeezeFail: 2, exit: 3, iceCrack: 2,
  tick: 2, win: 1, lose: 1, uiTap: 3, reveal: 1,
  // progression (contract §8)
  peel: 2, mouldSet: 2, snore: 1, yawn: 2, taffyStretch: 3, tear: 2, bloop: 3, breathe: 3, strain: 2,
  rail: 3, sizzle: 2, melt: 1, gloop: 2, dye: 2, pop: 2, padlock: 2, gulp: 2, ding: 3, plip: 3,
  chest: 1, unlock: 1, voice: 3,
};
const MIN_GAP = {
  slap: 0.025, impact: 0.03, collide: 0.05, grab: 0.08, release: 0.1, squish: 0.045, spawn: 0.06,
  land: 0.03, slide: 0.03, bump: 0.06, squeezeThrough: 0.08, squeezeFail: 0.12, exit: 0.05, iceCrack: 0.05,
  tick: 0.2, win: 0.5, lose: 0.5, uiTap: 0.04, reveal: 0.5,
  peel: 0.06, mouldSet: 0.06, snore: 0.35, yawn: 0.3, taffyStretch: 0.03, tear: 0.08, bloop: 0.05,
  breathe: 0.08, strain: 0.25, rail: 0.03, sizzle: 0.12, melt: 0.5, gloop: 0.08, dye: 0.08, pop: 0.04,
  padlock: 0.15, gulp: 0.08, ding: 0.05, plip: 0.06, chest: 0.4, unlock: 0.5, voice: 0.06,
};
// How rapid repeats duck each other: `self` per recent trigger of the same type, `all` per recent
// trigger of any type; `feed: false` keeps a type out of the any-type count. Unlisted → default.
const DUCK_DEFAULT = { self: 0.2, all: 0.06 };
const DUCK = {
  slide: { self: 0.05, all: 0, feed: false },  // background texture: never ducks the real events
  tick: { self: 0, all: 0, feed: false },
  uiTap: { self: 0.1, all: 0, feed: false },
  win: { self: 0, all: 0 }, lose: { self: 0, all: 0 }, reveal: { self: 0, all: 0 },
  taffyStretch: { self: 0.05, all: 0, feed: false }, rail: { self: 0.05, all: 0, feed: false },
  chest: { self: 0, all: 0 }, unlock: { self: 0, all: 0 }, melt: { self: 0, all: 0 },
};
// When all voices are busy these are never the first to be stolen.
const PROTECTED = new Set(['win', 'lose', 'reveal', 'squeezeThrough', 'chest', 'unlock', 'melt']);
const MAKEUP = 1.1;                   // gain after the compressor, tuned with the offline checks
export const RELEASE_MIN_SPEED = 450; // px/s; slower drops make no whoosh
export const SQUEEZE_TIME = 0.3;      // s from squeezeThrough() to its pop (default `duration`)
export const SLIDE_MIN_SPEED = 25;    // px/s; slower drags are silent

// ---------------------------------------------------------------- helpers

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = v => clamp(Number.isFinite(v) ? v : 0, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const vary = (v, amount) => v * (1 + (Math.random() * 2 - 1) * amount);
const dbToGain = db => Math.pow(10, db / 20);
const matOf = m => ({ ...MATERIALS.jelly, ...m });

/** Perceptual level curve: intensity 0..1 → amplitude from −34 dB to 0 dB. */
export function loudness(intensity, rangeDb = 34) {
  return dbToGain(-rangeDb * (1 - Math.pow(clamp01(intensity), 0.55)));
}

/** Throw speed (px/s) → whoosh strength 0..1 (0 at RELEASE_MIN_SPEED). */
export function whooshStrength(speed) {
  return clamp01((speed - RELEASE_MIN_SPEED) / 2500);
}

/** Drag speed (px/s) → slither strength 0..1 (0 below SLIDE_MIN_SPEED, 1 at ≈ 1100 px/s). */
export function slideStrength(speed) {
  return clamp01((speed - SLIDE_MIN_SPEED) / 1100);
}

/** How much a material squeaks instead of squelching: gummy ≈ 0.8, juicy fruit ≈ 0. */
function squeakiness(m) {
  return clamp01((1 - m.juiciness) * (m.pitch - 0.7) * 1.8);
}

function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

function gainNode(ctx, value = 0) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function filter(ctx, type, freq, Q = 0.707) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  return f;
}

function sweep(param, t, from, to, dur) {
  param.setValueAtTime(from, t);
  param.exponentialRampToValueAtTime(to, t + dur);
}

// Linear attack, optional hold, exponential decay to −60 dB.
function envelope(param, t, peak, attack, decay, hold = 0) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  if (hold > 0) param.setValueAtTime(peak, t + attack + hold);
  param.exponentialRampToValueAtTime(peak * 0.001 + 1e-7, t + attack + hold + decay);
}

function makeCurve(fn, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}

// Transparent below 0.75, bends smoothly into a 0.92 ceiling.
function softClip(x) {
  const a = Math.abs(x);
  return a < 0.75 ? x : Math.sign(x) * (0.75 + 0.2 * Math.tanh((a - 0.75) / 0.2));
}

// ---------------------------------------------------------------- per-context resources

const perContext = new WeakMap();

function cacheFor(ctx) {
  let c = perContext.get(ctx);
  if (!c) {
    c = {
      noise: makeNoise(ctx),
      // Fundamental plus a little 2nd/3rd harmonic: stays audible on phone/laptop speakers.
      warm: ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.35, 0.12])),
      cosine: ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])),
    };
    perContext.set(ctx, c);
  }
  return c;
}

// Two seconds each of white, pink and brown noise, all normalised to RMS 0.3.
function makeNoise(ctx) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 2);
  const make = fill => {
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    fill(d);
    let e = 0;
    for (let i = 0; i < len; i++) e += d[i] * d[i];
    const s = 0.3 / Math.sqrt(e / len);
    for (let i = 0; i < len; i++) d[i] *= s;
    return buf;
  };
  return {
    white: make(d => { for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; }),
    pink: make(d => { // Paul Kellet's economy pinking filter
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = b0 + b1 + b2 + w * 0.1848;
      }
    }),
    brown: make(d => {
      let v = 0;
      for (let i = 0; i < len; i++) { v = (v + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = v; }
    }),
  };
}

// Small bright room: pre-delay, a few early reflections, a tail that darkens as it decays.
function roomImpulse(ctx, seconds) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const pre = Math.floor(sr * 0.004);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const x = (i - pre) / (len - pre);
      lp += (Math.random() * 2 - 1 - lp) * (0.75 - 0.6 * x);
      d[i] = lp * Math.exp(-6.9 * x);
    }
    for (let k = 0; k < 7; k++) d[pre + Math.floor(sr * rand(0.002, 0.03))] += rand(-0.6, 0.6);
    let e = 0;
    for (let i = 0; i < len; i++) e += d[i] * d[i];
    const s = 1 / Math.sqrt(e); // unit energy → wet level is set by the send gain alone
    for (let i = 0; i < len; i++) d[i] *= s;
  }
  return buf;
}

/**
 * Master chain shared by the live player and offline tests.
 * Returns { input, master, comp }: voices connect to `input`; `master.gain` is the output level;
 * `comp` is the mix before the user volume (a fixed-level tap, e.g. for clip recording).
 */
export function createMasterChain(ctx, destination = ctx.destination) {
  // Headroom: a single voice peaks near 1.0 at full intensity. Measured end to end the chain
  // is ≈ 0.8× linear up to that and limits above it with a ceiling ≈ 0.88 (the compressor
  // adds its own automatic make-up gain, ≈ +3 dB for these settings).
  const input = gainNode(ctx, 0.5);
  const rumble = filter(ctx, 'highpass', 30);
  // Pre-gain 0.5 into a tanh curve with small-signal gain 2: unity for quiet sounds,
  // gently rounding the peaks of stacked voices.
  const drive = gainNode(ctx, 0.5);
  const sat = ctx.createWaveShaper();
  sat.curve = makeCurve(x => Math.tanh(2.2 * x) / 1.1);
  sat.oversample = '2x';
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -6;
  comp.knee.value = 3;
  comp.ratio.value = 20;
  comp.attack.value = 0.001;
  comp.release.value = 0.12;
  const send = gainNode(ctx, 0.14);
  const room = ctx.createConvolver();
  room.normalize = false;
  room.buffer = roomImpulse(ctx, 0.4);
  const master = gainNode(ctx, MAKEUP);
  const safety = ctx.createWaveShaper();
  safety.curve = makeCurve(softClip);

  chain(input, rumble, drive, sat, comp, master, safety, destination);
  chain(rumble, send, room, comp);
  return { input, master, comp };
}

// ---------------------------------------------------------------- building blocks

function noiseSrc(ctx, kind, t, dur, rate = 1) {
  const src = ctx.createBufferSource();
  src.buffer = cacheFor(ctx).noise[kind];
  src.loop = true;
  src.playbackRate.value = rate;
  src.start(t, Math.random() * src.buffer.duration);
  src.stop(t + dur + 0.02);
  return src;
}

// Gain that brings white noise through a band-pass (centre f, quality Q) back to its broadband
// RMS, so band levels read as "≈ peak" whatever the bandwidth.
function bandNorm(ctx, f, Q) {
  return Math.min(24, Math.sqrt((ctx.sampleRate / 2) / (1.57 * f / Q)));
}

// Noise through optional high/low-pass filters with a percussive envelope. Returns end time.
function noiseHit(ctx, out, t, { kind = 'white', dur, level, attack = 0.002, hp, lp, lpTo, lpQ = 0.707, rate = 1 }) {
  if (level < 1e-4) return t;
  const nodes = [noiseSrc(ctx, kind, t, attack + dur, rate)];
  if (hp) nodes.push(filter(ctx, 'highpass', hp));
  if (lp) {
    const f = filter(ctx, 'lowpass', lp, lpQ);
    if (lpTo) sweep(f.frequency, t, lp, lpTo, attack + dur);
    nodes.push(f);
  }
  const g = ctx.createGain();
  envelope(g.gain, t, level, attack, dur);
  chain(...nodes, g, out);
  return t + attack + dur;
}

// White noise through a (sweeping) resonant band-pass: squelches, suction, formant grains.
function bandHit(ctx, out, t, { dur, from, to = from, Q, level, attack = 0.002, rate = 1 }) {
  if (level < 1e-4) return t;
  const src = noiseSrc(ctx, 'white', t, attack + dur, rate);
  const bp = filter(ctx, 'bandpass', from, Q);
  if (to !== from) sweep(bp.frequency, t, from, to, attack + dur);
  const g = ctx.createGain();
  envelope(g.gain, t, level * bandNorm(ctx, Math.sqrt(from * to), Q), attack, dur);
  chain(src, bp, g, out);
  return t + attack + dur;
}

// Oscillator following a pitch contour [[timeOffset, freq], …] with a percussive envelope.
function toneHit(ctx, out, t, { wave = 'sine', freqs, dur, level, attack = 0.002, hold = 0 }) {
  if (level < 1e-4) return t;
  const o = ctx.createOscillator();
  if (wave === 'warm') o.setPeriodicWave(cacheFor(ctx).warm);
  else o.type = wave;
  o.frequency.setValueAtTime(freqs[0][1], t);
  for (let k = 1; k < freqs.length; k++) o.frequency.exponentialRampToValueAtTime(freqs[k][1], t + freqs[k][0]);
  const g = ctx.createGain();
  envelope(g.gain, t, level, attack, dur, hold);
  const end = t + attack + hold + dur;
  o.start(t);
  o.stop(end + 0.01);
  chain(o, g, out);
  return end;
}

// The audible wobble of jelly after a hit: a low resonance (warm tone + resonant noise) whose
// loudness and pitch swing at the jiggle rate while it dies away. `dur` is roughly how long
// the wobble stays clearly audible; the envelope reaches −60 dB at 1.3 × dur.
function jiggleTail(ctx, out, t, { level, dur, freq, rate, depth = 0.45 }) {
  if (level < 1e-4) return t;
  const { warm, cosine } = cacheFor(ctx);
  const end = t + 0.015 + dur * 1.3;

  const lfo = ctx.createOscillator();
  lfo.setPeriodicWave(cosine); // starts at full deformation
  lfo.frequency.setValueAtTime(rate, t);
  lfo.frequency.linearRampToValueAtTime(rate * 0.82, end);
  const am = gainNode(ctx, 1 - depth);
  const amDepth = gainNode(ctx, depth);
  const fm = gainNode(ctx, freq * 0.045);
  chain(lfo, amDepth, am.gain);
  lfo.connect(fm);

  const tone = ctx.createOscillator();
  tone.setPeriodicWave(warm);
  sweep(tone.frequency, t, freq, freq * 0.9, end - t);
  fm.connect(tone.frequency);
  chain(tone, gainNode(ctx, 0.75), am);

  const Q = 8;
  const bp = filter(ctx, 'bandpass', freq, Q);
  fm.connect(bp.frequency);
  chain(noiseSrc(ctx, 'white', t, end - t), bp, gainNode(ctx, 0.5 * bandNorm(ctx, freq, Q)), am);

  const env = ctx.createGain();
  envelope(env.gain, t, level, 0.015, dur * 1.3);
  chain(am, env, out);
  for (const o of [lfo, tone]) { o.start(t); o.stop(end + 0.02); }
  return end;
}

// Seed clicks: 1–3 ms bursts of bright noise with a tiny pitched tick, denser near the start.
// Rendered straight into one buffer (far cheaper than a node chain per click).
function seeds(ctx, out, t, count, level, spread = 0.09) {
  count = Math.round(count);
  if (count < 1 || level < 1e-4) return t;
  const sr = ctx.sampleRate;
  const len = Math.ceil(sr * (spread + 0.006));
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let c = 0; c < count; c++) {
    const start = Math.floor(Math.pow(Math.random(), 1.2) * spread * sr);
    const n = Math.max(8, Math.floor(sr * rand(0.001, 0.003)));
    const amp = rand(0.3, 1);
    const w = (2 * Math.PI * rand(2500, 6000)) / sr;
    const decay = Math.exp(-5 / n);
    let prev = 0, e = amp;
    for (let k = 0; k < n && start + k < len; k++) {
      const white = Math.random() * 2 - 1;
      const bright = white - 0.85 * prev;
      prev = white;
      d[start + k] += e * (0.6 * bright + 0.5 * Math.sin(w * k));
      e *= decay;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  chain(src, filter(ctx, 'highpass', 2200), gainNode(ctx, level), out);
  src.start(t);
  return t + buf.duration;
}

// Juice droplets: short upward sine chirps (a drop's bubble resonance rising), each with its
// own stereo position, scattered `from`..`to` seconds after `t`.
function droplets(ctx, out, t, count, level, { from = 0.04, to = 0.35, fLo = 1500, fHi = 4000 } = {}) {
  count = Math.round(count);
  if (count < 1 || level < 1e-4) return t;
  const sr = ctx.sampleRate;
  const len = Math.ceil(sr * (to + 0.05));
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const attack = sr * 0.001;
  for (let k = 0; k < count; k++) {
    const at = from + Math.pow(Math.random(), 1.3) * (to - from);
    const start = Math.floor(at * sr);
    const n = Math.floor(sr * rand(0.012, 0.035));
    const f0 = rand(fLo, fHi), f1 = f0 * rand(1.25, 1.7);
    const amp = rand(0.3, 1) * (1 - (0.5 * (at - from)) / (to - from));
    const angle = ((rand(-0.8, 0.8) + 1) * Math.PI) / 4;
    const gl = Math.cos(angle), gr = Math.sin(angle);
    // exponential chirp and decay, stepped per sample
    const chirp = Math.pow(f1 / f0, 1 / n), decay = Math.exp(-5 / n);
    let phase = 0, step = (2 * Math.PI * f0) / sr, e = amp;
    for (let i = 0; i < n && start + i < len; i++) {
      const s = Math.sin(phase) * e * Math.min(1, i / attack);
      L[start + i] += s * gl;
      R[start + i] += s * gr;
      phase += step;
      step *= chirp;
      e *= decay;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  chain(src, gainNode(ctx, level), out);
  src.start(t);
  return t + buf.duration;
}

// A few tiny resonant grains: the crackle of liquid being squeezed out.
function squelchGrains(ctx, out, t, count, spread, level, pitch) {
  let end = t;
  for (let k = 0; k < Math.round(count); k++) {
    const f = rand(500, 1500) * pitch;
    end = Math.max(end, bandHit(ctx, out, t + Math.random() * spread, {
      dur: rand(0.015, 0.035), from: f, to: f * rand(0.6, 1.5), Q: rand(5, 9), level: level * rand(0.5, 1),
    }));
  }
  return end;
}

// Rubbery stick-slip squeak: a soft triangle with a gliding pitch and fast vibrato.
function squeak(ctx, out, t, level, pitch) {
  if (level < 1e-4) return t;
  const dur = rand(0.05, 0.1);
  const f = rand(650, 1300) * pitch;
  const o = ctx.createOscillator();
  o.type = 'triangle';
  sweep(o.frequency, t, f, f * rand(0.8, 1.35), dur);
  const vib = ctx.createOscillator();
  vib.frequency.value = rand(22, 38);
  chain(vib, gainNode(ctx, f * 0.04), o.frequency);
  const g = ctx.createGain();
  envelope(g.gain, t, level, 0.008, dur);
  chain(o, filter(ctx, 'lowpass', 3500), g, out);
  for (const osc of [o, vib]) { osc.start(t); osc.stop(t + dur + 0.02); }
  return t + dur + 0.008;
}

// Jiggle tail shape for a material: longer for harder hits and wobblier materials, lower and
// slower for softer ones. `scale` shortens it, `tune` shifts its pitch.
function tailParams(m, i, scale = 1, tune = 1) {
  return {
    dur: vary(lerp(0.3, 0.6, i) * (0.75 + 0.5 * m.wobble), 0.1) * scale,
    freq: vary(lerp(300, 170, m.softness), 0.1) * m.pitch * tune,
    rate: vary(lerp(14, 8, m.softness), 0.12),
  };
}

// ---------------------------------------------------------------- voices
// Each voice: (ctx, dest, { t, intensity, material, … }) → duration (s) from t.

function slapVoice(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.6), m = matOf(p.material);
  const A = loudness(i), J = m.juiciness, pitch = m.pitch * vary(1, 0.08);
  const smackF = vary(lerp(1000, 1700, i), 0.15) * Math.sqrt(pitch);
  const thumpF = vary(lerp(115, 150, i), 0.1) * pitch;
  const ends = [
    // skin-contact crack
    noiseHit(ctx, out, t, {
      dur: vary(lerp(0.004, 0.012, i), 0.25), level: 0.35 * A, attack: 0.0005,
      hp: vary(lerp(1800, 3200, i), 0.15), lp: lerp(7000, 12000, i),
    }),
    // wet smack: a band of noise whose formant drops quickly ("thwap")
    bandHit(ctx, out, t, {
      dur: vary(lerp(0.07, 0.12, i) * (0.85 + 0.3 * J), 0.15),
      from: smackF * 1.35, to: smackF * 0.65, Q: vary(1.5, 0.3), level: 0.8 * A, attack: 0.002,
    }),
    // thump: the weight behind the hand
    toneHit(ctx, out, t, {
      freqs: [[0, thumpF], [0.07, thumpF * 0.55]], dur: vary(0.13, 0.2), level: 0.7 * A * (0.5 + 0.5 * i),
    }),
    // juicy squelch
    bandHit(ctx, out, t + rand(0.004, 0.012), {
      dur: vary(0.09, 0.2), from: vary(1600, 0.15) * pitch, to: vary(450, 0.15) * pitch,
      Q: lerp(4, 9, J), level: 0.4 * A * J,
    }),
    // jiggle tail: the jelly keeps wobbling
    jiggleTail(ctx, out, t + rand(0.008, 0.02), { level: 0.4 * A * (0.6 + 0.4 * m.wobble), ...tailParams(m, i) }),
    droplets(ctx, out, t, J * Math.max(0, i - 0.35) * 7, 0.2 * A),
    seeds(ctx, out, t + 0.004, m.seeds * lerp(3, 12, i) * vary(1, 0.3), 0.7 * A),
  ];
  return Math.max(...ends) - t;
}

function impactVoice(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.5), m = matOf(p.material);
  const A = loudness(i), J = m.juiciness, pitch = m.pitch * vary(1, 0.08);
  const f0 = vary(95, 0.1) * Math.sqrt(pitch);
  const ends = [
    // low thud with a fast pitch drop
    toneHit(ctx, out, t, {
      wave: 'warm', freqs: [[0, f0], [0.09, f0 * vary(0.58, 0.08)]],
      dur: lerp(0.14, 0.26, i), level: 0.85 * A, attack: 0.003,
    }),
    // splat: pink noise through a low-pass that snaps shut
    noiseHit(ctx, out, t, {
      kind: 'pink', dur: vary(lerp(0.09, 0.17, i) * (0.8 + 0.4 * J), 0.15), level: 0.8 * A, attack: 0.0015,
      lp: vary(lerp(1800, 5500, i), 0.15), lpTo: vary(280, 0.2), lpQ: vary(2, 0.3), rate: vary(1, 0.15),
    }),
    // heavier hits slump
    noiseHit(ctx, out, t, { kind: 'brown', dur: vary(0.12, 0.2), level: 0.5 * A * i, lp: 500, lpTo: 150 }),
    // squelch: resonant band sweeping down, the wet "blop"
    bandHit(ctx, out, t + rand(0.006, 0.02), {
      dur: vary(lerp(0.09, 0.16, J), 0.15), from: vary(1300, 0.15) * pitch, to: vary(300, 0.15) * pitch,
      Q: vary(lerp(6, 10, J), 0.15), level: 0.55 * A * (0.3 + 0.7 * J), attack: 0.004,
    }),
    squelchGrains(ctx, out, t + 0.01, J * lerp(1, 4, i) * vary(1, 0.4), 0.07, 0.3 * A, pitch),
    // the landed jelly wobbles too, a little lower and shorter than after a slap
    jiggleTail(ctx, out, t + rand(0.015, 0.03), { level: 0.3 * A * (0.6 + 0.4 * m.wobble), ...tailParams(m, i, 0.8, 0.85) }),
    droplets(ctx, out, t, J * lerp(1, 8, i) * vary(1, 0.3), 0.25 * A),
    seeds(ctx, out, t + 0.004, m.seeds * lerp(2, 10, i) * vary(1, 0.3), 0.6 * A),
  ];
  return Math.max(...ends) - t;
}

function collideVoice(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.5), m = matOf(p.material);
  const A = loudness(i) * 1.4, J = m.juiciness, pitch = m.pitch * vary(1, 0.08);
  const f = vary(130, 0.1) * pitch;
  const ends = [
    // round body, no crack
    noiseHit(ctx, out, t, {
      kind: 'pink', dur: vary(lerp(0.07, 0.12, i), 0.15), level: 0.7 * A, attack: 0.004,
      lp: vary(lerp(700, 1500, i), 0.15), lpTo: 250, lpQ: 1.5,
    }),
    bandHit(ctx, out, t + rand(0, 0.012), {
      dur: vary(0.1, 0.15), from: vary(900, 0.15) * pitch, to: vary(380, 0.15) * pitch,
      Q: lerp(5, 7, J), level: 0.55 * A * (0.4 + 0.6 * J), attack: 0.005,
    }),
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, f], [0.08, f * 0.65]], dur: 0.1, level: 0.35 * A, attack: 0.004 }),
    jiggleTail(ctx, out, t + 0.01, { level: 0.28 * A, ...tailParams(m, i, 0.6) }),
    seeds(ctx, out, t + 0.004, m.seeds * lerp(1, 5, i), 0.45 * A),
  ];
  return Math.max(...ends) - t;
}

function grabVoice(ctx, out, p) {
  const t = p.t, m = matOf(p.material), A = loudness(p.intensity ?? 0.6) * 3.2;
  const J = m.juiciness, pitch = m.pitch * vary(1, 0.08);
  const suck = vary(0.12, 0.15);
  const tp = t + suck * rand(0.55, 0.8);
  const pf = vary(420, 0.15) * pitch;
  const sq = squeakiness(m);
  const ends = [
    // suction: resonant band sweeping up as the jelly is pulled
    bandHit(ctx, out, t, {
      dur: suck, from: vary(300, 0.15) * pitch, to: vary(1000, 0.15) * pitch, Q: vary(8, 0.2), level: 0.5 * A, attack: 0.03,
    }),
    noiseHit(ctx, out, t, { kind: 'pink', dur: 0.07, level: 0.25 * A * (0.3 + 0.7 * J), attack: 0.01, lp: 1200, lpTo: 500, lpQ: 2 }),
    // small wet pop as it comes free
    toneHit(ctx, out, tp, { freqs: [[0, pf], [0.02, pf * 2.2]], dur: 0.035, level: 0.4 * A, attack: 0.001 }),
    noiseHit(ctx, out, tp, { dur: 0.003, level: 0.25 * A, attack: 0.0004, hp: 1500 }),
    Math.random() < sq ? squeak(ctx, out, t + 0.02, 0.3 * A * sq, pitch) : t,
    seeds(ctx, out, t + 0.01, m.seeds * rand(1, 4), 0.4 * A),
  ];
  return Math.max(...ends) - t;
}

function releaseVoice(ctx, out, p) {
  const t = p.t, m = matOf(p.material), s = whooshStrength(p.speed ?? 1500);
  const A = loudness(0.2 + 0.8 * s) * 0.84, pitch = m.pitch * vary(1, 0.08);
  const dur = vary(lerp(0.16, 0.38, s), 0.12);
  const peak = vary(lerp(1100, 3000, s), 0.15) * Math.sqrt(pitch);
  const tp = t + dur * rand(0.3, 0.42);

  // whoosh: band-passed noise swelling up in pitch and level, then falling away
  const bp = filter(ctx, 'bandpass', peak * 0.35, vary(1.3, 0.25));
  bp.frequency.setValueAtTime(peak * 0.35, t);
  bp.frequency.exponentialRampToValueAtTime(peak, tp);
  bp.frequency.exponentialRampToValueAtTime(peak * 0.4, t + dur);
  const g = ctx.createGain();
  const lvl = A * bandNorm(ctx, peak * 0.6, bp.Q.value);
  g.gain.setValueAtTime(lvl * 0.01, t);
  g.gain.exponentialRampToValueAtTime(lvl, tp);
  g.gain.exponentialRampToValueAtTime(lvl * 0.001, t + dur);
  chain(noiseSrc(ctx, 'white', t, dur), bp, g, out);

  // wet unstick from the fingers
  const unstick = bandHit(ctx, out, t, {
    dur: 0.045, from: vary(650, 0.15) * pitch, to: vary(1200, 0.15) * pitch, Q: 6, level: 0.25 * A * m.juiciness,
  });
  return Math.max(t + dur, unstick) - t;
}

function squishVoice(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.4), m = matOf(p.material);
  const A = loudness(i, 26) * 1.5, J = m.juiciness, pitch = m.pitch * vary(1, 0.1);
  const stretch = clamp01(p.stretch ?? 0.3), rising = (p.dir ?? 1) > 0;
  const f = rand(300, 1200) * pitch * (1 + 0.3 * stretch);
  const dur = vary(lerp(0.035, 0.07, J), 0.25);
  const sq = squeakiness(m);
  const ends = [
    // formant grain: rises while stretching, falls while relaxing
    bandHit(ctx, out, t, {
      dur, from: f, to: f * (rising ? rand(1.2, 1.5) : rand(0.6, 0.8)),
      Q: lerp(9, 4, J) * vary(1, 0.2), level: 0.6 * A, attack: 0.004,
    }),
    // fruit sloshes
    noiseHit(ctx, out, t, { kind: 'pink', dur: dur * 1.2, level: 0.35 * A * J, attack: 0.006, lp: vary(900, 0.2), lpTo: 400, lpQ: 1.5 }),
    // gummy squeaks
    Math.random() < sq * 0.7 ? squeak(ctx, out, t, 0.35 * A * sq, pitch * (1 + 0.2 * stretch)) : t,
    seeds(ctx, out, t, m.seeds * rand(0, 2.5), 0.5 * A, 0.05),
  ];
  return Math.max(...ends) - t;
}

function spawnVoice(ctx, out, p) {
  const t = p.t, m = matOf(p.material), A = loudness(p.intensity ?? 0.7) * 0.8;
  const pitch = m.pitch * vary(1, 0.1);
  const f = vary(380, 0.1) * pitch;

  // blorp: warm tone that dips then rises, softened by a low-pass
  const o = ctx.createOscillator();
  o.setPeriodicWave(cacheFor(ctx).warm);
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(f * 0.58, t + 0.05);
  o.frequency.exponentialRampToValueAtTime(f * 1.45, t + 0.17);
  const g = ctx.createGain();
  const blorpEnd = t + 0.01 + 0.1 + 0.2;
  envelope(g.gain, t, 0.55 * A, 0.01, 0.2, 0.1);
  chain(o, filter(ctx, 'lowpass', 2200, 1), g, out);
  o.start(t);
  o.stop(blorpEnd + 0.01);

  const ends = [
    blorpEnd,
    // bubble pops off the top
    droplets(ctx, out, t + 0.1, 1, 0.35 * A, { from: 0, to: 0.03, fLo: 700 * pitch, fHi: 1100 * pitch }),
    noiseHit(ctx, out, t, { kind: 'pink', dur: 0.06, level: 0.15 * A, attack: 0.005, lp: 1500 }),
    jiggleTail(ctx, out, t + 0.05, { level: 0.2 * A, ...tailParams(m, 0.3, 0.6) }),
  ];
  return Math.max(...ends) - t;
}

// ================================================================ Squeeze Out!
// Material voices come in two flavours: jelly (wet, squelchy, wobbly) and solid (dry plastic
// click/clack/tock — the A/B control; clean and satisfying, just not wet). p.mode picks one.
// Musical cues (sparkle, tick, win, lose, uiTap) are shared so the A/B differs only in material.

const semis = n => Math.pow(2, n / 12);
/**
 * Combo ladder (studio playbook §2.5): a 6-step major-pentatonic rise in the jingle's key,
 * combo 0 → 0, 1 → +2, 2 → +4, 3 → +7, 4 → +9, 5+ → +12 semitones (then it holds).
 * The sweetener (sparkle) climbs the whole ladder; the wet body/plop only half of it, so a long
 * streak sings without the jelly turning into a chipmunk.
 */
export const COMBO_LADDER = Object.freeze([0, 2, 4, 7, 9, 12]);
export const comboStep = c => clamp(Math.floor(Number.isFinite(c) ? c : 0), 0, COMBO_LADDER.length - 1);
export const comboSemitones = c => COMBO_LADDER[comboStep(c)];
const comboRatio = c => semis(comboSemitones(c));
const comboBodyRatio = c => semis(comboSemitones(c) * 0.5);
// Sparkle notes per combo step: 3 → 4 from combo 3 (the ladder gets a top note).
const comboNotes = c => (comboStep(c) >= 3 ? 4 : 3);
const C5 = 523.25;
const SPARKLE = [16, 19, 24, 28].map(s => C5 * semis(s)); // E6 G6 C7 E7 (C major, like the jingle)

// ---------------------------------------------------------------- Squeeze Out! building blocks

// Glockenspiel-like bar: fundamental plus the bar's 2.76× and 5.4× partials (skipped when too high).
function bell(ctx, out, t, f, level, decay = 0.4) {
  if (level < 1e-4) return t;
  const ends = [toneHit(ctx, out, t, { freqs: [[0, f]], dur: decay, level, attack: 0.001 })];
  if (f * 2.76 < 11000) ends.push(toneHit(ctx, out, t, { freqs: [[0, f * 2.76]], dur: decay * 0.3, level: level * 0.26, attack: 0.0006 }));
  if (f * 5.4 < 11000) ends.push(toneHit(ctx, out, t, { freqs: [[0, f * 5.4]], dur: decay * 0.1, level: level * 0.1, attack: 0.0005 }));
  return Math.max(...ends);
}

// Soft marimba note: fundamental, the tuned 4× overtone dying fast, and a felt-mallet contact.
function mallet(ctx, out, t, f, level, decay = 0.35) {
  if (level < 1e-4) return t;
  return Math.max(
    toneHit(ctx, out, t, { freqs: [[0, f]], dur: decay, level, attack: 0.0025 }),
    toneHit(ctx, out, t, { freqs: [[0, f * 3.93]], dur: decay * 0.16, level: level * 0.2, attack: 0.0012 }),
    noiseHit(ctx, out, t, { dur: 0.006, level: level * 0.1, attack: 0.0006, hp: 1200, lp: 4500 }),
  );
}

// Reward sparkle: a quick upward arpeggio of little bells plus a breath of high glitter.
// `ratio` transposes it (combo semitones).
function sparkle(ctx, out, t, { level, ratio = 1, count = 3, gap = 0.038, first = 0 }) {
  if (level < 1e-4) return t;
  const ends = [];
  for (let k = 0; k < count; k++) {
    const f = SPARKLE[Math.min(SPARKLE.length - 1, first + k)] * ratio;
    const accent = count > 1 ? k / (count - 1) : 1;
    ends.push(bell(ctx, out, t + k * gap * vary(1, 0.12), f, level * (0.6 + 0.4 * accent), vary(0.34, 0.12)));
  }
  ends.push(noiseHit(ctx, out, t + 0.01, { dur: 0.2, level: 0.1 * level, attack: 0.02, hp: 6500, lp: 14000 }));
  ends.push(bubbles(ctx, out, t + 0.03, {
    count: 3, level: 0.22 * level, from: 0, to: 0.16, fLo: 4200 * ratio, fHi: 7000 * ratio,
    rise: [1, 1.04], len: [0.02, 0.05],
  }));
  return Math.max(...ends);
}

// Tiny sine bursts rendered into one stereo buffer, each with its own pitch, chirp and position:
// slime crackle (short, rising), ice shards (longer, steady, with an inharmonic overtone),
// glitter. bias < 1 crowds them toward `to`, > 1 toward `from`; amp ramps from amp[0] to amp[1].
function bubbles(ctx, out, t, {
  count, level, from = 0, to = 0.3, bias = 1, fLo = 1000, fHi = 3000, rise = [1.2, 1.7],
  len = [0.004, 0.012], amp = [1, 1], width = 0.8, overtone = 0,
}) {
  count = Math.round(count);
  if (count < 1 || level < 1e-4) return t;
  const sr = ctx.sampleRate;
  const total = Math.ceil(sr * (to + len[1] + 0.005));
  const buf = ctx.createBuffer(2, total, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const att = Math.max(1, Math.floor(sr * 0.0004));
  for (let k = 0; k < count; k++) {
    const u = Math.pow(Math.random(), bias);
    const start = Math.floor((from + u * (to - from)) * sr);
    const n = Math.max(8, Math.floor(sr * rand(len[0], len[1])));
    const f0 = rand(fLo, fHi), f1 = f0 * rand(rise[0], rise[1]);
    const a = rand(0.35, 1) * lerp(amp[0], amp[1], u);
    const angle = ((rand(-width, width) + 1) * Math.PI) / 4;
    const gl = Math.cos(angle), gr = Math.sin(angle);
    const chirp = Math.pow(f1 / f0, 1 / n), decay = Math.exp(-6 / n), decay2 = decay * decay;
    let ph = 0, step = (2 * Math.PI * f0) / sr, e = a, e2 = a * overtone;
    for (let i = 0; i < n && start + i < total; i++) {
      const s = (Math.sin(ph) * e + (e2 > 1e-6 ? Math.sin(ph * 2.76) * e2 : 0)) * Math.min(1, i / att);
      L[start + i] += s * gl;
      R[start + i] += s * gr;
      ph += step;
      step *= chirp;
      e *= decay;
      e2 *= decay2;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  chain(src, gainNode(ctx, level), out);
  src.start(t);
  return t + buf.duration;
}

// The viscous body of a squeeze. Stick-slip pulses (the jelly catching and slipping on the gate's
// lips, faster and faster) excite two resonant formants that rise as the opening forces the
// jelly through; a voiced buzz rides the same pulses well below them. Rendered sample by
// sample into one buffer: cheap, and every pulse gets its own colour. Envelope: swells, pinches
// just before the end (the suction moment) so the pop that follows lands with contrast.
function squelchBody(ctx, out, t, { dur, f0, f1, rate0, rate1, level, voice = 0.3, q = 7 }) {
  if (level < 1e-4) return t;
  const sr = ctx.sampleRate;
  const n = Math.ceil(sr * dur);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const coef = (F, Q) => {
    const w = (2 * Math.PI * Math.min(F, sr * 0.45)) / sr;
    const r = Math.exp((-Math.PI * F) / (Q * sr));
    // input gain giving ≈ unity gain at the resonance
    return [2 * r * Math.cos(w), -r * r, (1 - r) * Math.sqrt(1 + r * r - 2 * r * Math.cos(2 * w))];
  };
  const vRatio = vary(0.4, 0.06);
  let c1 = 0, e1 = 0, g1 = 0, c2 = 0, e2 = 0, g2 = 0, F = f0;
  let a1 = 0, b1 = 0, a2 = 0, b2 = 0, ph = 0, peak = 0;
  let next = 0, pStart = 0, pLen = 1, pAmp = 0, pTone = 1;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    if ((i & 15) === 0) {
      F = f0 * Math.pow(f1 / f0, Math.pow(u, 1.3));
      [c1, e1, g1] = coef(F, q);
      [c2, e2, g2] = coef(F * 2.35, q * 1.3);
    }
    if (i >= next) {
      const rate = rate0 * Math.pow(rate1 / rate0, u) * rand(0.8, 1.2);
      pStart = i;
      pLen = Math.max(8, Math.floor(sr / rate));
      pAmp = rand(0.45, 1);
      pTone = rand(0.9, 1.1);      // each slip rings a hair higher or lower
      next = i + pLen;
    }
    const k = (i - pStart) / pLen;
    const pe = pAmp * (k < 0.12 ? k / 0.12 : Math.exp(-(k - 0.12) * 5));
    const white = Math.random() * 2 - 1;
    ph += (2 * Math.PI * F * vRatio * pTone) / sr;
    const buzz = Math.tanh(2.5 * Math.sin(ph));
    const exc = pe * (0.8 * white + voice * buzz) + 0.07 * white;
    const y1 = g1 * exc + c1 * a1 + e1 * b1; b1 = a1; a1 = y1;
    const y2 = g2 * exc + c2 * a2 + e2 * b2; b2 = a2; a2 = y2;
    // crescendo: the low, slow start stays soft (so it reads as squelch, never as a raspberry),
    // the bright fast end carries it, then the pinch
    const env = u < 0.1 ? (0.4 * u) / 0.1 : u < 0.84 ? 0.4 + (0.6 * (u - 0.1)) / 0.74 : 1 - (0.55 * (u - 0.84)) / 0.16;
    const s = (y1 + 0.4 * y2 + 0.12 * voice * pe * buzz) * env;
    d[i] = s;
    peak = Math.max(peak, Math.abs(s));
  }
  const fade = Math.min(n, Math.floor(sr * 0.004));
  const norm = peak > 0 ? 1 / peak : 0;
  for (let i = 0; i < n; i++) d[i] *= norm * (i >= n - fade ? (n - i) / fade : 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  chain(src, filter(ctx, 'highpass', 130), filter(ctx, 'lowpass', 7500), gainNode(ctx, level), out);
  src.start(t);
  return t + dur;
}

// Sustained rubber-on-rubber squeak gliding up: triangle with a fast stick-slip vibrato.
function squeakGlide(ctx, out, t, { dur, f0, f1, level }) {
  if (level < 1e-4) return t;
  const o = ctx.createOscillator();
  o.type = 'triangle';
  sweep(o.frequency, t, f0, f1, dur);
  const vib = ctx.createOscillator();
  vib.frequency.setValueAtTime(rand(24, 30), t);
  vib.frequency.linearRampToValueAtTime(rand(36, 44), t + dur);
  chain(vib, gainNode(ctx, f0 * 0.035), o.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + dur * 0.3);
  g.gain.setValueAtTime(level, t + dur * 0.75);
  g.gain.exponentialRampToValueAtTime(level * 0.001, t + dur);
  chain(o, filter(ctx, 'lowpass', 3500), g, out);
  for (const osc of [o, vib]) { osc.start(t); osc.stop(t + dur + 0.02); }
  return t + dur;
}

// Hard plastic contact: a bright click, a hollow resonant band, a few short inharmonic modes and
// the low knock of the block's mass. Dry and short: no squelch, no wobble. `bright` 0..1 opens
// up the click and upper modes (harder hits), `decay` scales the ring, `knock` the low end,
// `body` adds the hollow box resonance of a toy block / tray (fuller "tock").
function plastic(ctx, out, t, { f, level, bright = 0.5, decay = 1, knock = 0.5, body = 0 }) {
  if (level < 1e-4) return t;
  return Math.max(
    body > 0 ? bandHit(ctx, out, t, { dur: 0.09 * decay, from: f * 0.8, to: f * 0.74, Q: 4, level: level * body, attack: 0.001 }) : t,
    noiseHit(ctx, out, t, {
      dur: 0.0015 + 0.002 * bright, level: level * (0.3 + 0.4 * bright), attack: 0.0002, hp: 1800 + 2000 * bright, lp: 12000,
    }),
    bandHit(ctx, out, t, { dur: 0.028 * decay, from: f * 1.62, Q: 9, level: level * 0.3, attack: 0.0004 }),
    toneHit(ctx, out, t, { freqs: [[0, f]], dur: 0.065 * decay, level: level * 0.55, attack: 0.0005 }),
    toneHit(ctx, out, t, { freqs: [[0, f * 2.32]], dur: 0.032 * decay, level: level * (0.12 + 0.28 * bright), attack: 0.0004 }),
    toneHit(ctx, out, t, { freqs: [[0, f * 4.13]], dur: 0.015 * decay, level: level * (0.04 + 0.18 * bright), attack: 0.0003 }),
    knock > 0 ? toneHit(ctx, out, t, {
      freqs: [[0, f * 0.24], [0.03, f * 0.19]], dur: 0.05 * decay, level: level * knock, attack: 0.001,
    }) : t,
  );
}

// ---------------------------------------------------------------- Squeeze Out! voices: jelly

// A gummy dropping into its socket: soft splat, wet blop, a little suction "plip" as it seals,
// then a settle wobble.
function landJelly(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.6), m = matOf(p.material);
  const A = loudness(i, 28) * 0.8, J = m.juiciness, pitch = m.pitch * vary(1, 0.07), sp = Math.sqrt(pitch);
  const f0 = vary(118, 0.08) * sp;
  const tp = t + vary(0.035, 0.2);
  const ends = [
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, f0], [0.08, f0 * 0.6]], dur: lerp(0.12, 0.2, i), level: 0.75 * A, attack: 0.003 }),
    noiseHit(ctx, out, t, {
      kind: 'pink', dur: vary(lerp(0.07, 0.13, i), 0.15), level: 0.65 * A, attack: 0.002,
      lp: vary(lerp(1600, 4200, i), 0.12), lpTo: 260, lpQ: 1.8,
    }),
    bandHit(ctx, out, t + rand(0.004, 0.012), {
      dur: vary(0.1, 0.15), from: vary(1250, 0.12) * pitch, to: vary(330, 0.12) * pitch,
      Q: lerp(5, 9, J), level: 0.5 * A * (0.4 + 0.6 * J), attack: 0.003,
    }),
    toneHit(ctx, out, tp, { freqs: [[0, vary(260, 0.08) * sp], [0.03, vary(560, 0.08) * sp]], dur: 0.05, level: 0.22 * A, attack: 0.002 }),
    squelchGrains(ctx, out, t + 0.012, J * lerp(0, 3, i), 0.05, 0.25 * A, pitch),
    jiggleTail(ctx, out, t + rand(0.012, 0.025), { level: 0.3 * A * (0.6 + 0.4 * m.wobble), ...tailParams(m, i, 0.75, 0.95) }),
    droplets(ctx, out, t, J * Math.max(0, i - 0.3) * 6, 0.18 * A),
  ];
  return Math.max(...ends) - t;
}

// One grain of the wet slither while a piece is dragged (the player calls this ~6–24×/s).
function slideJelly(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.5), m = matOf(p.material);
  const A = loudness(i, 24) * 0.66, J = m.juiciness, pitch = m.pitch * vary(1, 0.1);
  const f = rand(380, 950) * pitch;
  const dur = vary(lerp(0.05, 0.08, J), 0.25);
  const sq = squeakiness(m);
  const ends = [
    bandHit(ctx, out, t, { dur, from: f, to: f * rand(0.75, 1.3), Q: lerp(6, 3.5, J) * vary(1, 0.2), level: 0.6 * A, attack: 0.012 }),
    noiseHit(ctx, out, t, { kind: 'pink', dur: dur * 1.3, level: 0.3 * A, attack: 0.015, lp: vary(1400, 0.2) }),
    Math.random() < 0.15 + 0.3 * J ? bubbles(ctx, out, t + rand(0.005, 0.03), {
      count: 1, level: 0.35 * A, from: 0, to: 0.001, fLo: 900 * pitch, fHi: 2200 * pitch, rise: [1.3, 1.8], len: [0.004, 0.009],
    }) : t,
    Math.random() < sq * 0.25 * i ? squeak(ctx, out, t, 0.22 * A * sq, pitch) : t,
  ];
  return Math.max(...ends) - t;
}

// Stopped by a wall or another piece mid-drag: a soft squishy thud and a short wobble.
function bumpJelly(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.5), m = matOf(p.material);
  const A = loudness(i, 30) * 1.15, J = m.juiciness, pitch = m.pitch * vary(1, 0.08);
  const f = vary(150, 0.08) * Math.sqrt(pitch);
  const sq = squeakiness(m);
  const ends = [
    noiseHit(ctx, out, t, {
      kind: 'pink', dur: vary(lerp(0.07, 0.11, i), 0.15), level: 0.7 * A, attack: 0.004,
      lp: vary(lerp(700, 1400, i), 0.15), lpTo: 240, lpQ: 1.5,
    }),
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, f], [0.07, f * 0.63]], dur: 0.1, level: 0.45 * A, attack: 0.004 }),
    bandHit(ctx, out, t + rand(0, 0.01), {
      dur: vary(0.09, 0.15), from: vary(850, 0.15) * pitch, to: vary(340, 0.15) * pitch,
      Q: lerp(5, 7, J), level: 0.45 * A * (0.4 + 0.6 * J), attack: 0.005,
    }),
    jiggleTail(ctx, out, t + 0.01, { level: 0.24 * A * (0.6 + 0.4 * m.wobble), ...tailParams(m, i, 0.55) }),
    Math.random() < sq * 0.5 ? squeak(ctx, out, t + 0.01, 0.2 * A * sq, pitch) : t,
  ];
  return Math.max(...ends) - t;
}

// THE signature sound: the jelly forced through a gate one cell too narrow. A rising, wet,
// stick-slip "schlorrrp" (formants and pitch climb as it's squeezed), slime crackle crowding
// toward the exit, a friction squeak on gummy materials, then a clean wet POP with droplets, a
// release wobble and the exit sparkle. `duration` = time to the pop (default SQUEEZE_TIME).
function squeezeJelly(ctx, out, p) {
  const t = p.t, m = matOf(p.material), J = m.juiciness;
  const pitch = m.pitch * vary(1, 0.06), sp = Math.sqrt(pitch);
  const D = clamp(Number.isFinite(p.duration) ? p.duration : SQUEEZE_TIME, 0.15, 0.8);
  const sq = squeakiness(m);
  const tp = t + D;
  const ends = [
    squelchBody(ctx, out, t, {
      dur: D, f0: vary(300, 0.08) * pitch, f1: vary(1350, 0.08) * pitch,
      rate0: vary(17, 0.15), rate1: vary(46, 0.12), voice: lerp(0.34, 0.18, J), q: lerp(8, 5, J), level: 0.62,
    }),
    bubbles(ctx, out, t + 0.02, {
      count: lerp(5, 13, J) * vary(1, 0.25), level: 0.3, from: 0, to: Math.max(0.05, D - 0.04), bias: 0.55,
      fLo: 900 * pitch, fHi: 3000 * pitch, rise: [1.3, 2.1], len: [0.003, 0.01], amp: [0.5, 1],
    }),
    sq > 0.12 ? squeakGlide(ctx, out, t + D * 0.22, { dur: D * 0.66, f0: vary(760, 0.08) * pitch, f1: vary(1450, 0.08) * pitch, level: 0.26 * sq }) : t,
    // POP: the suction lets go
    toneHit(ctx, out, tp, { freqs: [[0, vary(360, 0.06) * sp], [0.016, vary(1050, 0.06) * sp]], dur: 0.055, level: 0.8, attack: 0.0006 }),
    noiseHit(ctx, out, tp, { dur: 0.0025, level: 0.32, attack: 0.0002, hp: 1600, lp: 9000 }),
    toneHit(ctx, out, tp, { wave: 'warm', freqs: [[0, vary(200, 0.06) * sp], [0.07, vary(118, 0.06) * sp]], dur: 0.12, level: 0.5, attack: 0.002 }),
    bandHit(ctx, out, tp + 0.004, {
      dur: 0.08, from: vary(1700, 0.1) * pitch, to: vary(480, 0.1) * pitch, Q: 6, level: 0.3 * (0.4 + 0.6 * J), attack: 0.003,
    }),
    droplets(ctx, out, tp, lerp(2, 7, J) * vary(1, 0.3), 0.22, { from: 0.015, to: 0.24 }),
    jiggleTail(ctx, out, tp + 0.012, { level: 0.2 * (0.6 + 0.4 * m.wobble), ...tailParams(m, 0.5, 0.55, 1.15) }),
    sparkle(ctx, out, tp + 0.05, { level: 0.3, ratio: comboRatio(p.combo), count: comboNotes(p.combo) }),
  ];
  return Math.max(...ends) - t;
}

// Too wide: the jelly bulges into the opening ("bw-") and sags back ("-omp"), then the
// spring-back wobble. The tone and formant swing up then down together.
function squeezeFailJelly(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.7), m = matOf(p.material);
  const A = loudness(i, 18) * 0.8, J = m.juiciness, pitch = m.pitch * vary(1, 0.06), sp = Math.sqrt(pitch);
  const sq = squeakiness(m);
  const up = vary(0.1, 0.1), down = vary(0.19, 0.1), end = t + up + down;
  const f = vary(135, 0.06) * sp;

  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(f * 1.5, t + up);
  o.frequency.exponentialRampToValueAtTime(f * 0.78, end);
  const lp = filter(ctx, 'lowpass', 320 * pitch, 4.5);
  lp.frequency.setValueAtTime(320 * pitch, t);
  lp.frequency.exponentialRampToValueAtTime(1500 * pitch, t + up);
  lp.frequency.exponentialRampToValueAtTime(260 * pitch, end);
  const g = ctx.createGain();
  envelope(g.gain, t, 0.36 * A, 0.018, down, up * 0.8);
  chain(o, lp, g, out);
  o.start(t);
  o.stop(end + 0.04);

  // wet formant riding the bulge
  const bp = filter(ctx, 'bandpass', 380 * pitch, 6);
  bp.frequency.setValueAtTime(380 * pitch, t);
  bp.frequency.exponentialRampToValueAtTime(1150 * pitch, t + up);
  bp.frequency.exponentialRampToValueAtTime(320 * pitch, end);
  const g2 = ctx.createGain();
  envelope(g2.gain, t, 0.32 * A * (0.3 + 0.7 * J) * bandNorm(ctx, 650 * pitch, 6), 0.02, down, up * 0.7);
  chain(noiseSrc(ctx, 'white', t, up + down + 0.05), bp, g2, out);

  const ends = [
    end + 0.04,
    toneHit(ctx, out, t, { freqs: [[0, f], [up, f * 1.5], [up + down, f * 0.78]], dur: down, hold: up * 0.8, level: 0.3 * A, attack: 0.018 }),
    noiseHit(ctx, out, t, { kind: 'pink', dur: 0.07, level: 0.4 * A, attack: 0.003, lp: 900, lpTo: 260, lpQ: 1.5 }),
    sq > 0.12 ? squeakGlide(ctx, out, t + 0.015, { dur: up * 1.1, f0: 650 * pitch, f1: 1100 * pitch, level: 0.2 * A * sq }) : t,
    jiggleTail(ctx, out, t + up + down * 0.35, {
      level: 0.42 * A * (0.6 + 0.4 * m.wobble), dur: vary(0.36, 0.1) * (0.8 + 0.4 * m.wobble),
      freq: vary(200, 0.08) * pitch, rate: vary(11, 0.1), depth: 0.6,
    }),
  ];
  return Math.max(...ends) - t;
}

// Out through a gate: a wet bubble "plop" (the pitch jumps as it leaves the opening), the lip of
// the gate letting go, a few droplets, then the sparkle. combo 0..6 → up that many semitones.
function exitJelly(ctx, out, p) {
  const t = p.t, m = matOf(p.material), J = m.juiciness, r = comboRatio(p.combo), rb = comboBodyRatio(p.combo);
  const pitch = m.pitch * vary(1, 0.05) * rb;
  const pf = vary(300, 0.05) * Math.sqrt(m.pitch) * rb;
  const ends = [
    toneHit(ctx, out, t, { freqs: [[0, pf], [0.035, pf * 2.4]], dur: 0.075, level: 0.62, attack: 0.0015 }),
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, pf * 0.55], [0.06, pf * 0.4]], dur: 0.1, level: 0.32, attack: 0.002 }),
    bandHit(ctx, out, t, {
      dur: vary(0.06, 0.15), from: vary(700, 0.1) * pitch, to: vary(1700, 0.1) * pitch, Q: 7, level: 0.28 * (0.4 + 0.6 * J), attack: 0.004,
    }),
    noiseHit(ctx, out, t, { dur: 0.002, level: 0.14, attack: 0.0003, hp: 2000 }),
    droplets(ctx, out, t, lerp(1, 5, J) * vary(1, 0.3), 0.16, { from: 0.03, to: 0.22 }),
    jiggleTail(ctx, out, t + 0.02, { level: 0.13 * (0.6 + 0.4 * m.wobble), ...tailParams(m, 0.4, 0.5, 1.2) }),
    sparkle(ctx, out, t + 0.045, { level: 0.38, ratio: r, count: comboNotes(p.combo) }),
  ];
  return Math.max(...ends) - t;
}

// ---------------------------------------------------------------- Squeeze Out! voices: solid

// A toy block dropping into its tray: a round hollow "tock", then two little bounces that come
// quicker and quieter.
function landSolid(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.6), A = loudness(i, 28) * 1.15;
  const f = vary(560, 0.06);
  const g1 = vary(0.055, 0.15) * (0.6 + 0.6 * i), g2 = g1 * vary(0.62, 0.1), b = 0.4 + 0.6 * i;
  return Math.max(
    plastic(ctx, out, t, { f, level: 0.9 * A, bright: 0.25 + 0.4 * i, knock: 0.75, decay: 1.5, body: 0.7 }),
    plastic(ctx, out, t + g1, { f: f * 1.04, level: 0.7 * A * b, bright: 0.3, knock: 0.55, decay: 1.1, body: 0.55 }),
    plastic(ctx, out, t + g1 + g2, { f: f * 1.07, level: 0.45 * A * b, bright: 0.3, knock: 0.35, decay: 0.9, body: 0.35 }),
  ) - t;
}

// One grain of plastic gliding on plastic: a dry, airy "tsss" with frequent micro-ticks (the
// block's edges skipping over the tray's grain).
function slideSolid(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.5), A = loudness(i, 24) * 0.75;
  const f = rand(2400, 4200);
  return Math.max(
    bandHit(ctx, out, t, { dur: vary(0.04, 0.25), from: f, to: f * rand(0.9, 1.1), Q: 1.6, level: 0.45 * A, attack: 0.006 }),
    bandHit(ctx, out, t, { dur: vary(0.04, 0.25), from: rand(700, 1100), Q: 3, level: 0.25 * A, attack: 0.008 }),
    Math.random() < 0.6 ? plastic(ctx, out, t + rand(0, 0.02), { f: rand(1800, 2600), level: 0.3 * A, bright: 0.8, knock: 0, decay: 0.35 }) : t,
  ) - t;
}

// Stopped mid-drag: a clean "cl-ack" (two contacts a few ms apart).
function bumpSolid(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.5), A = loudness(i, 30) * 1.05;
  const f = vary(1150, 0.05);
  return Math.max(
    plastic(ctx, out, t, { f, level: 0.8 * A, bright: 0.35 + 0.5 * i, knock: 0.45, decay: 0.8 }),
    plastic(ctx, out, t + rand(0.006, 0.012), { f: f * 1.07, level: 0.3 * A, bright: 0.5, knock: 0.1, decay: 0.5 }),
  ) - t;
}

// Too wide: the block jams against the narrow frame with a dull "dunk", then rattles back,
// "tok-tk-tk-tk", quicker and quieter.
function squeezeFailSolid(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.7), A = loudness(i, 18) * 1.15;
  const f = vary(600, 0.05);
  return Math.max(
    plastic(ctx, out, t, { f, level: 0.85 * A, bright: 0.35, knock: 0.8, decay: 1.4, body: 0.7 }),
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, vary(150, 0.05)], [0.1, vary(112, 0.05)]], dur: 0.2, level: 0.38 * A, attack: 0.002 }),
    ...[0.07, 0.115, 0.15].map((dt, k) => plastic(ctx, out, t + vary(dt, 0.08), {
      f: f * (0.97 + 0.03 * k), level: [0.8, 0.64, 0.48][k] * A, bright: 0.3, knock: 0.45, decay: 1, body: 0.45,
    })),
  ) - t;
}

// Out through a gate: a bright pop-clack, an airy "fwip" as it whips out of the slot, the same
// sparkle as jelly mode. Also used for squeezeThrough in solid mode (there it is a normal exit).
function exitSolid(ctx, out, p) {
  const t = p.t, r = comboRatio(p.combo), rb = comboBodyRatio(p.combo);
  const f = vary(880, 0.04) * rb;
  return Math.max(
    plastic(ctx, out, t, { f, level: 0.72, bright: 0.6, knock: 0.5 }),
    bandHit(ctx, out, t + 0.005, { dur: 0.07, from: 900 * rb, to: 3800 * rb, Q: 1.4, level: 0.16, attack: 0.012 }),
    sparkle(ctx, out, t + 0.045, { level: 0.38, ratio: r, count: comboNotes(p.combo) }),
  ) - t;
}

// ---------------------------------------------------------------- Squeeze Out! voices: shared

// Slapping a frozen gummy. Stage 1: a crisp crack (snap, splinter clicks, a short icy ring).
// Stage 2: the crust shatters (shards tinkling) and melts into slush (wet, sloppy, bubbly).
function iceCrackVoice(ctx, out, p) {
  const t = p.t, shatter = (p.stage ?? 1) >= 2;
  // p.tap: a light icy tick (a frozen piece pressed or refused) — quieter, no crack yet.
  const A = shatter ? 1 : p.tap ? 0.38 : 0.85;
  const fi = rand(2600, 3200);
  const ends = [
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, vary(260, 0.08)], [0.05, vary(150, 0.08)]], dur: 0.07, level: 0.42 * A, attack: 0.001 }),
    noiseHit(ctx, out, t, { dur: shatter ? 0.012 : 0.006, level: 0.75 * A, attack: 0.0002, hp: shatter ? 1200 : 1800, lp: 14000 }),
    seeds(ctx, out, t + 0.003, rand(5, 9) * (shatter ? 1.6 : 1), 0.55 * A, shatter ? 0.1 : 0.07),
    toneHit(ctx, out, t, { freqs: [[0, fi]], dur: 0.06, level: 0.22 * A, attack: 0.0004 }),
    toneHit(ctx, out, t, { freqs: [[0, fi * 1.53]], dur: 0.04, level: 0.14 * A, attack: 0.0004 }),
    toneHit(ctx, out, t, { freqs: [[0, fi * 2.37]], dur: 0.025, level: 0.1 * A, attack: 0.0004 }),
  ];
  if (shatter) {
    ends.push(
      bubbles(ctx, out, t + 0.004, {
        count: rand(18, 26), level: 0.42, from: 0, to: 0.32, bias: 1.6, fLo: 2500, fHi: 7500,
        rise: [0.97, 1.03], len: [0.015, 0.07], width: 0.9, overtone: 0.35,
      }),
      noiseHit(ctx, out, t, { dur: 0.16, level: 0.3, attack: 0.002, hp: 3500 }),
      // slush
      noiseHit(ctx, out, t + 0.1, { kind: 'pink', dur: 0.38, level: 0.42, attack: 0.05, lp: 1800, lpTo: 350, lpQ: 1.2 }),
      bandHit(ctx, out, t + 0.14, { dur: 0.22, from: 900, to: 280, Q: 6, level: 0.32, attack: 0.02 }),
      droplets(ctx, out, t + 0.12, 4, 0.14, { from: 0, to: 0.3, fLo: 600, fHi: 1400 }),
      toneHit(ctx, out, t + 0.16, { wave: 'warm', freqs: [[0, 280], [0.18, 170]], dur: 0.2, level: 0.22, attack: 0.02 }),
    );
  }
  return Math.max(...ends) - t;
}

// Timer tick for the last seconds: a soft woodblock that alternates tick/tock; urgent is higher,
// brighter and a little louder.
function tickVoice(ctx, out, p) {
  const t = p.t, urgent = !!p.urgent;
  const f = (urgent ? 1500 : 1150) * (p.tock ? 0.86 : 1) * vary(1, 0.008);
  const A = urgent ? 0.66 : 0.48;
  return Math.max(
    toneHit(ctx, out, t, { freqs: [[0, f]], dur: urgent ? 0.045 : 0.055, level: A, attack: 0.0006 }),
    toneHit(ctx, out, t, { freqs: [[0, f * 2.71]], dur: 0.018, level: A * (urgent ? 0.35 : 0.14), attack: 0.0004 }),
    toneHit(ctx, out, t, { freqs: [[0, f * 0.5]], dur: 0.03, level: A * 0.22, attack: 0.001 }),
    noiseHit(ctx, out, t, { dur: 0.0015, level: A * 0.3, attack: 0.0002, hp: 2000, lp: urgent ? 9000 : 5000 }),
  ) - t;
}

// Level cleared: marimba arpeggio up C–E–G–C, then a bell chord with glitter (~1.2 s).
function winVoice(ctx, out, p) {
  const t = p.t, step = 0.085, ends = [];
  [0, 4, 7, 12].forEach((s, k) => {
    const tk = t + k * step;
    ends.push(mallet(ctx, out, tk, C5 * semis(s), k === 3 ? 0.42 : 0.34, 0.32));
    ends.push(bell(ctx, out, tk, C5 * 2 * semis(s), 0.1, 0.25));
  });
  const tc = t + 4 * step + 0.03;
  for (const s of [12, 16, 19, 24]) ends.push(bell(ctx, out, tc + rand(0, 0.012), C5 * semis(s), 0.17, 0.85));
  ends.push(
    mallet(ctx, out, tc, C5, 0.3, 0.6),
    mallet(ctx, out, tc, C5 * semis(-5), 0.22, 0.6),
    toneHit(ctx, out, tc, { wave: 'warm', freqs: [[0, C5 / 4]], dur: 0.5, level: 0.28, attack: 0.004 }),
    bubbles(ctx, out, tc + 0.02, {
      count: 8, level: 0.12, from: 0, to: 0.55, bias: 1.3, fLo: 3000, fHi: 7000, rise: [1, 1.02], len: [0.03, 0.09],
    }),
    noiseHit(ctx, out, tc, { dur: 0.35, level: 0.04, attack: 0.03, hp: 7000 }),
  );
  return Math.max(...ends) - t;
}

// A level lost: a soft mallet line falls (G–E–D), then settles on a warm, open C chord — "next time"
// rather than the mocking "wah-wah" (feel review); it sets up the retry instead of rubbing it in.
function loseVoice(ctx, out, p) {
  const t = p.t, ends = [];
  [[-5, 0, 0.26], [-8, 0.15, 0.24], [-10, 0.3, 0.22]].forEach(([s, dt, lvl]) => {
    ends.push(mallet(ctx, out, t + dt, C5 * semis(s) * vary(1, 0.004), lvl, 0.34));
  });
  const tc = t + 0.5;
  for (const [s, lvl] of [[-12, 0.16], [-8, 0.1], [-5, 0.09], [0, 0.07]]) ends.push(bell(ctx, out, tc + rand(0, 0.01), C5 * semis(s), lvl, 0.8));
  ends.push(toneHit(ctx, out, tc, { wave: 'warm', freqs: [[0, C5 / 4]], dur: 0.6, level: 0.18, attack: 0.02 }));
  return Math.max(...ends) - t;
}

// Soft UI blip: a little bubble rising.
function uiTapVoice(ctx, out, p) {
  const t = p.t, f = vary(560, 0.03);
  return Math.max(
    toneHit(ctx, out, t, { freqs: [[0, f], [0.03, f * 1.45]], dur: 0.06, level: 0.38, attack: 0.003 }),
    toneHit(ctx, out, t, { freqs: [[0, f * 2], [0.03, f * 2.9]], dur: 0.025, level: 0.05, attack: 0.002 }),
    noiseHit(ctx, out, t, { dur: 0.0015, level: 0.05, attack: 0.0002, hp: 3000 }),
  ) - t;
}

// Win reveal: the frost lifts (airy noise sweeping up, crystalline glints, a soft rising glass
// tone), then at `popDelay` s the photo jelly bursts out (big blorp, squelch, bubble pop,
// droplets, a slow heavy wobble) and the sparkle. Solid mode: a plastic pop instead of the blorp.
function revealVoice(ctx, out, p) {
  const t = p.t, m = matOf(p.material), pitch = m.pitch * vary(1, 0.04), sp = Math.sqrt(pitch);
  const T = clamp(Number.isFinite(p.popDelay) ? p.popDelay : 0.5, 0, 2);
  const tp = t + T, fr = Math.max(0.25, T + 0.12);
  const ends = [];

  const bp = filter(ctx, 'bandpass', 1400, 1.6);
  sweep(bp.frequency, t, 1400, 9000, fr);
  const g = ctx.createGain();
  const lvl = 0.3 * bandNorm(ctx, 3500, 1.6);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(lvl, t + fr * 0.7);
  g.gain.exponentialRampToValueAtTime(lvl * 0.001, t + fr + 0.15);
  chain(noiseSrc(ctx, 'white', t, fr + 0.15), bp, g, out);
  ends.push(t + fr + 0.15);
  ends.push(bubbles(ctx, out, t + 0.03, {
    count: 14, level: 0.2, from: 0, to: fr, bias: 0.8, fLo: 2800, fHi: 8000, rise: [1, 1.08], len: [0.02, 0.08], overtone: 0.25,
  }));
  ends.push(toneHit(ctx, out, t, { freqs: [[0, 700], [fr, 2100]], dur: 0.12, hold: fr * 0.8, level: 0.05, attack: fr * 0.2 }));

  if (p.mode === 'solid') {
    ends.push(
      plastic(ctx, out, tp, { f: vary(520, 0.04), level: 0.95, bright: 0.5, knock: 0.85, decay: 1.5, body: 0.7 }),
      plastic(ctx, out, tp + vary(0.07, 0.1), { f: vary(540, 0.04), level: 0.4, bright: 0.35, knock: 0.4, decay: 1, body: 0.4 }),
      bandHit(ctx, out, tp, { dur: 0.12, from: 600, to: 3000, Q: 1.3, level: 0.3, attack: 0.01 }),
    );
  } else {
    const f = vary(170, 0.05) * pitch;
    const o = ctx.createOscillator();
    o.setPeriodicWave(cacheFor(ctx).warm);
    o.frequency.setValueAtTime(f, tp);
    o.frequency.exponentialRampToValueAtTime(f * 0.62, tp + 0.06);
    o.frequency.exponentialRampToValueAtTime(f * 1.75, tp + 0.24);
    const og = ctx.createGain();
    envelope(og.gain, tp, 0.52, 0.012, 0.22, 0.1);
    chain(o, filter(ctx, 'lowpass', 1900, 1.2), og, out);
    o.start(tp);
    o.stop(tp + 0.36);
    ends.push(
      tp + 0.36,
      toneHit(ctx, out, tp, { wave: 'warm', freqs: [[0, 95], [0.12, 55]], dur: 0.2, level: 0.42, attack: 0.004 }),
      bandHit(ctx, out, tp + 0.005, { dur: 0.16, from: vary(1500, 0.1) * pitch, to: vary(340, 0.1) * pitch, Q: 7, level: 0.38, attack: 0.004 }),
      toneHit(ctx, out, tp + 0.22, { freqs: [[0, 500 * sp], [0.02, 1400 * sp]], dur: 0.05, level: 0.3, attack: 0.001 }),
      droplets(ctx, out, tp + 0.02, 6, 0.22, { from: 0, to: 0.3 }),
      jiggleTail(ctx, out, tp + 0.08, { level: 0.34, dur: 0.55, freq: 170 * pitch, rate: 7.5, depth: 0.5 }),
    );
  }
  ends.push(sparkle(ctx, out, tp + 0.1, { level: 0.48, count: 4, gap: 0.05 }));
  return Math.max(...ends) - t;
}

// ================================================================ Progression: mechanics, meta, characters
// Spec docs/progression-design.md §2.2 / §7; contract docs/build-contracts.md §8. Everything here is
// additive: new building blocks, the 12 mechanics' voices, chest / unlock ceremonies and the
// character voices used by the jelly packs (JellyDef `voice: { type, pitch }`).
// Design rules for these (they repeat a lot): every call re-randomises its timing and tuning a
// little, nothing sharp sits above ≈ 6 kHz at a high level, onsets are rounded (≥ 0.4 ms), and the
// musical cues stay in the same C-major world as the win jingle and the exit sparkle.

// Noise clicks rendered into one buffer: `count` clicks between `from`..`to` s (bias < 1 crowds them
// toward `to`, > 1 toward `from`; `even` spaces them regularly with a little jitter), each a short
// burst of brightened noise. Tape peel, frying crackle, zipper teeth, splinters.
function clicks(ctx, out, t, {
  count, level, from = 0, to = 0.2, bias = 1, len = [0.0006, 0.002], hp = 1500, lp = 7000, even = false, amp = [1, 1],
}) {
  count = Math.round(count);
  if (count < 1 || level < 1e-4) return t;
  const sr = ctx.sampleRate;
  const total = Math.ceil(sr * (to + len[1] + 0.004));
  const buf = ctx.createBuffer(1, total, sr);
  const d = buf.getChannelData(0);
  for (let k = 0; k < count; k++) {
    const u = even ? clamp((k + rand(-0.25, 0.25)) / Math.max(1, count - 1), 0, 1) : Math.pow(Math.random(), bias);
    const start = Math.floor((from + u * (to - from)) * sr);
    const n = Math.max(8, Math.floor(sr * rand(len[0], len[1])));
    const decay = Math.exp(-5 / n);
    const att = Math.max(2, Math.floor(sr * 0.0002));
    let e = rand(0.4, 1) * lerp(amp[0], amp[1], u), prev = 0;
    for (let i = 0; i < n && start + i < total; i++) {
      const w = Math.random() * 2 - 1;
      d[start + i] += e * (w - 0.7 * prev) * Math.min(1, i / att);
      prev = w;
      e *= decay;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  chain(src, filter(ctx, 'highpass', hp), filter(ctx, 'lowpass', lp), gainNode(ctx, level), out);
  src.start(t);
  return t + buf.duration;
}

// Schedules a contour [[timeOffset, value], …] (values > 0) on an AudioParam.
function contour(param, t, points, scale = 1) {
  param.setValueAtTime(points[0][1] * scale, t);
  for (let k = 1; k < points.length; k++) param.exponentialRampToValueAtTime(points[k][1] * scale, t + points[k][0]);
}

// Little formant voice: a buzzy source (sawtooth / triangle) plus breath noise through two or three
// resonant band-passes whose centres glide along `formants` [[time, F1, F2, F3?], …] while the
// pitch follows `pitch` [[time, f], …]. Optional vibrato and an amplitude flutter (growl / croak /
// snore rattle). Shared by the character voices, the yawn, the snore and the jar burp.
function formant(ctx, out, t, {
  dur, pitch, formants, level, attack = 0.02, release = 0.08, wave = 'sawtooth', voiced = 1,
  vib = 0, vibRate = 6, breath = 0, flutter = 0, flutterRate = 30, q = [6, 8, 10], weights = [1, 0.55, 0.25], lp = 4200,
}) {
  if (level < 1e-4) return t;
  const end = t + dur;
  const src = gainNode(ctx, 1);
  const o = ctx.createOscillator();
  o.type = wave;
  contour(o.frequency, t, pitch);
  const nodes = [o];
  if (vib > 0) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = vibRate * vary(1, 0.08);
    chain(lfo, gainNode(ctx, pitch[0][1] * vib), o.frequency);
    nodes.push(lfo);
  }
  chain(o, gainNode(ctx, voiced), src);
  if (breath > 0) chain(noiseSrc(ctx, 'pink', t, dur), filter(ctx, 'highpass', 500), gainNode(ctx, breath * 2.2), src);
  let head = src;
  if (flutter > 0) {
    const am = gainNode(ctx, 1 - flutter * 0.5);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = flutterRate * vary(1, 0.06);
    chain(lfo, gainNode(ctx, flutter * 0.5), am.gain);
    src.connect(am);
    head = am;
    nodes.push(lfo);
  }
  const sum = gainNode(ctx, 1);
  const f0 = pitch[0][1];
  for (let k = 0; k < formants[0].length - 1; k++) {
    const bp = filter(ctx, 'bandpass', formants[0][k + 1], q[k] ?? 8);
    contour(bp.frequency, t, formants.map(p => [p[0], p[k + 1]]));
    // a band-pass passes ≈ one harmonic of a buzz at f0: lift it back to roughly the source level
    const lift = clamp(formants[0][k + 1] / (f0 * 1.6), 1, 7);
    chain(head, bp, gainNode(ctx, (weights[k] ?? 0.2) * lift), sum);
  }
  const env = ctx.createGain();
  const a = Math.min(attack, dur * 0.5), r = Math.min(release, dur - a);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(level, t + a);
  env.gain.setValueAtTime(level, end - r);
  env.gain.exponentialRampToValueAtTime(level * 0.001, end);
  chain(sum, filter(ctx, 'lowpass', lp), env, out);
  for (const n of nodes) { n.start(t); n.stop(end + 0.02); }
  return end + 0.02;
}

// Soft pad note: two detuned triangles through a low-pass, slow swell (epic / legendary chords).
function padNote(ctx, out, t, f, { level, attack = 0.25, hold = 0.5, release = 0.7, lp = 1800 }) {
  if (level < 1e-4) return t;
  const end = t + attack + hold + release;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + attack);
  g.gain.setValueAtTime(level, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(level * 0.001, end);
  const lpf = filter(ctx, 'lowpass', lp, 0.8);
  chain(lpf, g, out);
  for (const det of [-6, 6]) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f * semis(det / 100);
    chain(o, gainNode(ctx, 0.5), lpf);
    o.start(t);
    o.stop(end + 0.02);
  }
  return end;
}

// Brass-ish fanfare note: detuned saws through a low-pass whose cutoff blooms on the attack.
function brass(ctx, out, t, f, { level, dur, bloom = 2600 }) {
  if (level < 1e-4) return t;
  const end = t + dur;
  const lpf = filter(ctx, 'lowpass', 400, 1.2);
  lpf.frequency.setValueAtTime(400, t);
  lpf.frequency.exponentialRampToValueAtTime(bloom, t + 0.05);
  lpf.frequency.exponentialRampToValueAtTime(bloom * 0.5, t + Math.max(0.12, dur * 0.6));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + 0.03);
  g.gain.setValueAtTime(level * 0.8, t + Math.max(0.05, dur - 0.12));
  g.gain.exponentialRampToValueAtTime(level * 0.001, end);
  chain(lpf, g, out);
  for (const det of [-5, 4]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f * semis(det / 100);
    chain(o, gainNode(ctx, 0.5), lpf);
    o.start(t);
    o.stop(end + 0.02);
  }
  return end;
}

// Timpani-like tuned drum: pitch-settling fundamental, two inharmonic modes and the felt mallet.
function timpani(ctx, out, t, f, level, decay = 0.7) {
  if (level < 1e-4) return t;
  return Math.max(
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, f * 1.05], [0.06, f]], dur: decay, level, attack: 0.002 }),
    toneHit(ctx, out, t, { freqs: [[0, f * 1.51]], dur: decay * 0.45, level: level * 0.32, attack: 0.002 }),
    toneHit(ctx, out, t, { freqs: [[0, f * 1.99]], dur: decay * 0.25, level: level * 0.18, attack: 0.002 }),
    noiseHit(ctx, out, t, { kind: 'pink', dur: 0.05, level: level * 0.45, attack: 0.001, lp: 900, lpTo: 300 }),
  );
}

const clampInt = (v, lo, hi, dflt) => clamp(Math.round(Number.isFinite(v) ? v : dflt), lo, hi);

// ---------------------------------------------------------------- mechanics (spec §2.2)

// JJ peel: the outer skin slurps through the gate — sticky "shhhk" (stick-slip film crackle and a
// swelling hiss) then a "thwip" up and out, the core snapping back with a brighter sparkle.
// layer 1 = the first peel; every further layer is 3 semitones higher.
function peelJelly(ctx, out, p) {
  const t = p.t, m = matOf(p.material), J = m.juiciness;
  const L = clampInt(p.layer, 1, 4, 1), r = semis(3 * (L - 1));
  const pitch = m.pitch * vary(1, 0.05), sp = Math.sqrt(pitch);
  const S = vary(0.19, 0.1), tp = t + S;
  const ends = [
    clicks(ctx, out, t + 0.01, { count: rand(14, 20), level: 0.3, from: 0, to: S - 0.01, bias: 0.6, hp: 1400, lp: 5200, amp: [0.4, 1] }),
    bandHit(ctx, out, t, { dur: 0.05, from: vary(1300, 0.08) * r, to: vary(3000, 0.08) * r, Q: 2.2, level: 0.16, attack: S * 0.85 }),
    bandHit(ctx, out, t, { dur: 0.06, from: vary(480, 0.1) * pitch * r, to: vary(1250, 0.1) * pitch * r, Q: 8, level: 0.22 * (0.5 + 0.5 * J), attack: S * 0.8 }),
    // thwip
    toneHit(ctx, out, tp, { freqs: [[0, vary(380, 0.05) * sp * r], [0.03, vary(1450, 0.05) * sp * r]], dur: 0.06, level: 0.55, attack: 0.0008 }),
    bandHit(ctx, out, tp, { dur: 0.05, from: 900 * r, to: 3600 * r, Q: 1.5, level: 0.12, attack: 0.006 }),
    noiseHit(ctx, out, tp, { dur: 0.002, level: 0.12, attack: 0.0004, hp: 2500, lp: 9000 }),
    // core snaps back
    jiggleTail(ctx, out, tp + 0.015, { level: 0.2 * (0.6 + 0.4 * m.wobble), ...tailParams(m, 0.5, 0.6, 1.15 * Math.sqrt(r)) }),
    sparkle(ctx, out, tp + 0.04, { level: 0.26, ratio: r, count: L >= 2 ? 3 : 2 }),
  ];
  return Math.max(...ends) - t;
}

// Solid: a sticker peeled off plastic — dry tape crackle, a click, the same sparkle.
function peelSolid(ctx, out, p) {
  const t = p.t, L = clampInt(p.layer, 1, 4, 1), r = semis(3 * (L - 1)), S = vary(0.13, 0.1);
  return Math.max(
    clicks(ctx, out, t, { count: rand(16, 22), level: 0.28, from: 0, to: S, bias: 0.7, hp: 2200, lp: 6500, amp: [0.5, 1] }),
    plastic(ctx, out, t + S, { f: vary(1400, 0.04) * r, level: 0.6, bright: 0.55, knock: 0.3 }),
    bandHit(ctx, out, t + S, { dur: 0.06, from: 1000 * r, to: 3400 * r, Q: 1.4, level: 0.12, attack: 0.01 }),
    sparkle(ctx, out, t + S + 0.04, { level: 0.26, ratio: r, count: L >= 2 ? 3 : 2 }),
  ) - t;
}

// ML set: "thwomp" into the tin (deep thud, wet squelch, suction seal), then the glassy floor tile
// clicks flush; a soft sparkle (combo-aware, a set counts as a clear).
function mouldSetJelly(ctx, out, p) {
  const t = p.t, m = matOf(p.material), J = m.juiciness, pitch = m.pitch * vary(1, 0.05), sp = Math.sqrt(pitch);
  const tc = t + vary(0.11, 0.08);
  const r = comboRatio(p.combo);
  const ends = [
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, vary(92, 0.05) * sp], [0.1, vary(52, 0.05) * sp]], dur: 0.24, level: 0.68, attack: 0.003 }),
    noiseHit(ctx, out, t, { kind: 'pink', dur: vary(0.12, 0.1), level: 0.55, attack: 0.002, lp: 1500, lpTo: 200, lpQ: 1.6 }),
    bandHit(ctx, out, t + 0.006, { dur: vary(0.12, 0.1), from: vary(1100, 0.1) * pitch, to: vary(280, 0.1) * pitch, Q: 7, level: 0.42 * (0.4 + 0.6 * J), attack: 0.003 }),
    toneHit(ctx, out, t + 0.07, { freqs: [[0, vary(300, 0.05) * sp], [0.03, vary(680, 0.05) * sp]], dur: 0.04, level: 0.18, attack: 0.002 }),
    plastic(ctx, out, tc, { f: vary(1900, 0.04), level: 0.36, bright: 0.5, knock: 0.08, decay: 0.8 }),
    bell(ctx, out, tc, vary(2350, 0.03), 0.08, 0.28),
    jiggleTail(ctx, out, t + 0.02, { level: 0.3 * (0.6 + 0.4 * m.wobble), ...tailParams(m, 0.7, 0.9, 0.9) }),
    sparkle(ctx, out, tc + 0.03, { level: 0.24, ratio: r, count: 2 }),
  ];
  return Math.max(...ends) - t;
}

// Solid: a heavy plastic tock and a snap-fit "click-click".
function mouldSetSolid(ctx, out, p) {
  const t = p.t, r = comboRatio(p.combo), d = vary(0.06, 0.1);
  return Math.max(
    plastic(ctx, out, t, { f: vary(430, 0.04), level: 0.85, bright: 0.3, knock: 0.9, decay: 1.6, body: 0.8 }),
    plastic(ctx, out, t + d, { f: vary(1700, 0.04), level: 0.45, bright: 0.65, knock: 0, decay: 0.6 }),
    plastic(ctx, out, t + d + vary(0.016, 0.15), { f: vary(1800, 0.04), level: 0.28, bright: 0.6, knock: 0, decay: 0.5 }),
    sparkle(ctx, out, t + d + 0.05, { level: 0.24, ratio: r, count: 2 }),
  ) - t;
}

// ZZ touched while asleep: a cartoon snore — an airy fluttering inhale "hnnk", a little whistled
// exhale, a drowsy wobble. Breath-led (never a raspberry).
function snoreVoice(ctx, out, p) {
  const t = p.t, v = vary(1, 0.05), D = vary(0.36, 0.08);
  const te = t + D + 0.06;
  return Math.max(
    formant(ctx, out, t, {
      dur: D, pitch: [[0, 140 * v], [D, 165 * v]], formants: [[0, 520, 1050], [D, 650, 1200]], level: 0.55,
      attack: D * 0.55, release: D * 0.3, voiced: 0.45, breath: 0.6, flutter: 0.8, flutterRate: 24, lp: 2200,
    }),
    toneHit(ctx, out, te, { freqs: [[0, vary(1250, 0.05)], [0.24, vary(880, 0.05)]], dur: 0.12, hold: 0.08, level: 0.12, attack: 0.06 }),
    bandHit(ctx, out, te, { dur: 0.16, from: 1000, to: 600, Q: 2, level: 0.24, attack: 0.08 }),
    jiggleTail(ctx, out, t + 0.04, { level: 0.18, dur: 0.4, freq: vary(150, 0.05), rate: 4.5, depth: 0.5 }),
  ) - t;
}

// ZZ wakes: a little yawn "i-aaah-mm" (pitch and vowels glide), a rubbery stretch, a bright blink.
function yawnVoice(ctx, out, p) {
  const t = p.t, v = vary(1, 0.05), D = vary(0.72, 0.06);
  const k = D / 0.72;
  return Math.max(
    formant(ctx, out, t, {
      dur: D, pitch: [[0, 290 * v], [0.17 * k, 410 * v], [0.5 * k, 330 * v], [D, 225 * v]],
      formants: [[0, 360, 2000], [0.15 * k, 800, 1250], [0.5 * k, 740, 1150], [D, 320, 750]],
      level: 0.38, attack: 0.07, release: 0.22, vib: 0.012, vibRate: 5.5, breath: 0.25, lp: 3200,
    }),
    squeakGlide(ctx, out, t + D * 0.7, { dur: 0.22, f0: vary(480, 0.06), f1: vary(860, 0.06), level: 0.06 }),
    bell(ctx, out, t + D + 0.06, C5 * semis(16) * vary(1, 0.01), 0.12, 0.3),
    jiggleTail(ctx, out, t + D * 0.75, { level: 0.12, dur: 0.3, freq: vary(190, 0.05), rate: 9, depth: 0.5 }),
  ) - t;
}

// TW: one grain of the pulled-sugar strand creaking; pitch rises with the stretch `amount` 0..1.
function taffyGrain(ctx, out, p) {
  const t = p.t, a = clamp01(p.amount ?? 0.4), A = loudness(clamp01(p.intensity ?? 0.5), 22) * 1.6;
  const f = (260 + 720 * a) * vary(1, 0.06);
  const dur = vary(0.085, 0.2);
  return Math.max(
    squeakGlide(ctx, out, t, { dur, f0: f, f1: f * rand(1.06, 1.18), level: 0.16 * A }),
    bandHit(ctx, out, t, { dur, from: f * 0.55, to: f * 0.75, Q: 6, level: 0.26 * A, attack: 0.012 }),
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, 120 * (1 + a)], [dur, 135 * (1 + a)]], dur: dur * 0.8, level: 0.12 * A, attack: 0.01 }),
  ) - t;
}

// TW tear: the strand thins and snaps — a soft crack, two thin recoil "twangs" falling away and
// both ends wobbling back.
function tearJelly(ctx, out, p) {
  const t = p.t, v = vary(1, 0.05);
  return Math.max(
    noiseHit(ctx, out, t, { dur: 0.004, level: 0.3, attack: 0.0005, hp: 2000, lp: 8000 }),
    toneHit(ctx, out, t, { freqs: [[0, 1050 * v], [0.13, 250 * v]], dur: 0.14, level: 0.4, attack: 0.001 }),
    toneHit(ctx, out, t + vary(0.012, 0.2), { freqs: [[0, 780 * v], [0.1, 200 * v]], dur: 0.11, level: 0.22, attack: 0.001 }),
    bandHit(ctx, out, t, { dur: 0.07, from: 1700 * v, to: 480 * v, Q: 5, level: 0.26, attack: 0.002 }),
    jiggleTail(ctx, out, t + 0.03, { level: 0.17, dur: 0.28, freq: vary(230, 0.06), rate: 12, depth: 0.5 }),
    jiggleTail(ctx, out, t + 0.05, { level: 0.14, dur: 0.3, freq: vary(185, 0.06), rate: 10, depth: 0.5 }),
    droplets(ctx, out, t + 0.01, 2, 0.1, { from: 0, to: 0.15 }),
  ) - t;
}

function tearSolid(ctx, out, p) {
  const t = p.t, v = vary(1, 0.04);
  return Math.max(
    plastic(ctx, out, t, { f: 1600 * v, level: 0.6, bright: 0.75, knock: 0.2 }),
    toneHit(ctx, out, t, { freqs: [[0, 900 * v], [0.08, 300 * v]], dur: 0.08, level: 0.2, attack: 0.001 }),
  ) - t;
}

// FL auto-exit: an airy rising "blub-bloop" (bubble resonances climbing), micro-bubbles and the
// sparkle; combo raises it like exit().
function bloopJelly(ctx, out, p) {
  const t = p.t, r = comboRatio(p.combo), v = vary(1, 0.04) * comboBodyRatio(p.combo);
  return Math.max(
    toneHit(ctx, out, t, { freqs: [[0, 240 * v], [0.06, 520 * v]], dur: 0.08, level: 0.38, attack: 0.002 }),
    toneHit(ctx, out, t + vary(0.07, 0.1), { freqs: [[0, 330 * v], [0.07, 920 * v]], dur: 0.1, level: 0.55, attack: 0.0015 }),
    bandHit(ctx, out, t + 0.06, { dur: 0.09, from: 500 * v, to: 1500 * v, Q: 6, level: 0.2, attack: 0.004 }),
    bandHit(ctx, out, t, { dur: 0.06, from: 800 * r, to: 3000 * r, Q: 1.2, level: 0.08, attack: 0.1 }),
    bubbles(ctx, out, t + 0.02, { count: 5, level: 0.16, from: 0, to: 0.2, fLo: 1200 * r, fHi: 2600 * r, rise: [1.3, 1.8], len: [0.008, 0.02] }),
    sparkle(ctx, out, t + 0.13, { level: 0.34, ratio: r }),
  ) - t;
}

function bloopSolid(ctx, out, p) {
  const t = p.t, r = comboRatio(p.combo);
  return Math.max(
    plastic(ctx, out, t, { f: vary(1000, 0.04) * comboBodyRatio(p.combo), level: 0.6, bright: 0.5, knock: 0.3 }),
    bandHit(ctx, out, t + 0.005, { dur: 0.08, from: 700 * r, to: 3000 * r, Q: 1.4, level: 0.14, attack: 0.03 }),
    sparkle(ctx, out, t + 0.06, { level: 0.34, ratio: r }),
  ) - t;
}

// PF breathe: 'in' = puffing up (airy inhale, balloon-rubber stretch, a soft "pomf" when full);
// 'out' = deflating (a soft "pfff" and a falling hum). Sized to the 0.25 s inflation.
function breatheVoice(ctx, out, p) {
  const t = p.t, v = vary(1, 0.05), D = vary(0.26, 0.06);
  if (p.dir === 'out') {
    return Math.max(
      bandHit(ctx, out, t, { dur: D + 0.06, from: 2200 * v, to: 750 * v, Q: 1.3, level: 0.2, attack: 0.025 }),
      toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, 240 * v], [D, 135 * v]], dur: 0.1, hold: D * 0.6, level: 0.18, attack: 0.02 }),
      jiggleTail(ctx, out, t + D * 0.8, { level: 0.12, dur: 0.25, freq: 170 * v, rate: 9, depth: 0.45 }),
    ) - t;
  }
  return Math.max(
    bandHit(ctx, out, t, { dur: 0.06, from: 500 * v, to: 1800 * v, Q: 1.6, level: 0.18, attack: D * 0.85 }),
    squeakGlide(ctx, out, t, { dur: D, f0: 220 * v, f1: 420 * v, level: 0.07 }),
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, 140 * v], [D, 235 * v]], dur: 0.08, hold: D * 0.25, level: 0.24, attack: D * 0.6 }),
    toneHit(ctx, out, t + D, { freqs: [[0, 260 * v], [0.03, 390 * v]], dur: 0.05, level: 0.16, attack: 0.002 }),
    jiggleTail(ctx, out, t + D, { level: 0.13, dur: 0.24, freq: 195 * v, rate: 9, depth: 0.45 }),
  ) - t;
}

// PF held / pushing a blocker: a tight trembling "nnngh" with a rubber squeak riding it.
function strainVoice(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.5), A = loudness(i, 18) * 2, v = vary(1, 0.05), D = vary(0.22, 0.1);
  return Math.max(
    formant(ctx, out, t, {
      dur: D, pitch: [[0, 380 * v], [D, 470 * v]], formants: [[0, 300, 2100], [D, 330, 2300]], q: [8, 10],
      level: 0.22 * A, attack: 0.03, release: 0.06, vib: 0.03, vibRate: 9, breath: 0.12, wave: 'triangle', lp: 3000,
    }),
    squeakGlide(ctx, out, t + 0.01, { dur: D, f0: 700 * v, f1: 900 * v, level: 0.1 * A }),
    bandHit(ctx, out, t, { dur: D, from: 420 * v, to: 600 * v, Q: 6, level: 0.12 * A, attack: D * 0.5 }),
  ) - t;
}

// ST: one grain of the soft zip while a striped piece slides on its rail — a few even zipper teeth
// over a hushed "zzz" and the groove's low hum.
function railGrain(ctx, out, p) {
  const t = p.t, i = clamp01(p.intensity ?? 0.5), A = loudness(i, 24) * 1.75;
  const dur = vary(0.06, 0.2);
  return Math.max(
    clicks(ctx, out, t, { count: rand(3, 5), level: 0.22 * A, from: 0, to: dur, even: true, len: [0.0005, 0.0012], hp: 2400, lp: 6500 }),
    bandHit(ctx, out, t, { dur, from: vary(1900, 0.1), to: vary(2400, 0.1), Q: 2, level: 0.18 * A, attack: 0.012 }),
    bandHit(ctx, out, t, { dur, from: vary(620, 0.1), Q: 3, level: 0.12 * A, attack: 0.015 }),
  ) - t;
}

// HT: one crackle burst per move. `left` = moves left before it melts; the burst gets denser,
// faster and a touch louder as it falls, with a rising "tss" tick so the countdown reads by ear.
function sizzleVoice(ctx, out, p) {
  const t = p.t, left = Math.max(1, Number.isFinite(p.left) ? p.left : 3);
  const u = clamp((5 - left) / 4, 0, 1);
  const dur = lerp(0.32, 0.42, u) * vary(1, 0.08);
  return Math.max(
    toneHit(ctx, out, t, { freqs: [[0, 1400 * semis(5 * u) * vary(1, 0.01)]], dur: 0.035, level: 0.3, attack: 0.001 }),
    clicks(ctx, out, t + 0.005, { count: lerp(10, 34, u) * vary(1, 0.15), level: 0.5 * (0.8 + 0.2 * u), from: 0, to: dur, bias: 1.3, hp: 1600, lp: 5200 }),
    noiseHit(ctx, out, t, { dur, level: 0.05 + 0.03 * u, attack: 0.02, hp: 3500, lp: 6500 }),
    bubbles(ctx, out, t + 0.01, { count: lerp(2, 6, u), level: 0.45, from: 0, to: dur * 0.8, fLo: 600, fHi: 1400, rise: [1.3, 1.8], len: [0.006, 0.015] }),
    noiseHit(ctx, out, t, { kind: 'pink', dur: dur * 0.8, level: 0.14 + 0.14 * u, attack: 0.03, lp: 900 }),
  ) - t;
}

// HT melt: a gooey descending "bloooorp", falling drips and a wisp of steam, then the puddle splat
// and a slow sad wobble. Gentle — it is a fail, not a punishment.
function meltVoice(ctx, out, p) {
  const t = p.t, v = vary(1, 0.04), ts = t + vary(0.62, 0.05);
  return Math.max(
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, 330 * v], [0.55, 95 * v]], dur: 0.32, hold: 0.15, level: 0.34, attack: 0.03 }),
    bandHit(ctx, out, t, { dur: 0.5, from: 1300 * v, to: 250 * v, Q: 7, level: 0.28, attack: 0.05 }),
    bubbles(ctx, out, t + 0.08, { count: 5, level: 0.18, from: 0, to: 0.5, fLo: 900, fHi: 1600, rise: [0.6, 0.8], len: [0.02, 0.04] }),
    noiseHit(ctx, out, t, { dur: 0.5, level: 0.045, attack: 0.05, hp: 3000, lp: 7000 }),
    noiseHit(ctx, out, ts, { kind: 'pink', dur: 0.1, level: 0.38, attack: 0.002, lp: 1200, lpTo: 200, lpQ: 1.4 }),
    toneHit(ctx, out, ts, { wave: 'warm', freqs: [[0, 110 * v], [0.08, 70 * v]], dur: 0.12, level: 0.38, attack: 0.003 }),
    droplets(ctx, out, ts, 3, 0.12, { from: 0.01, to: 0.2, fLo: 900, fHi: 2200 }),
    jiggleTail(ctx, out, ts + 0.03, { level: 0.18, dur: 0.4, freq: 140 * v, rate: 6, depth: 0.5 }),
  ) - t;
}

// GL: the deep wet glorp layered under squeezeThrough (call both, same `duration`): a slow,
// low stick-slip squelch, fat low bubbles and a heavy blorp at the end.
function gloopJelly(ctx, out, p) {
  const t = p.t, m = matOf(p.material), pitch = m.pitch * vary(1, 0.05);
  const D = clamp(Number.isFinite(p.duration) ? p.duration : SQUEEZE_TIME, 0.15, 0.8) * 1.05;
  return Math.max(
    squelchBody(ctx, out, t, { dur: D, f0: vary(150, 0.08) * pitch, f1: vary(520, 0.08) * pitch, rate0: vary(9, 0.15), rate1: vary(24, 0.12), voice: 0.4, q: 6, level: 0.42 }),
    bubbles(ctx, out, t + 0.04, { count: rand(3, 5), level: 0.3, from: 0, to: D, fLo: 280, fHi: 650, rise: [1.4, 2], len: [0.02, 0.045] }),
    noiseHit(ctx, out, t, { kind: 'pink', dur: 0.08, level: 0.16, attack: D * 0.7, lp: 700 }),
    toneHit(ctx, out, t + D * 0.85, { wave: 'warm', freqs: [[0, 150 * pitch], [0.05, 95 * pitch], [0.17, 165 * pitch]], dur: 0.12, hold: 0.04, level: 0.36, attack: 0.004 }),
  ) - t;
}

function gloopSolid(ctx, out, p) {
  return plastic(ctx, out, p.t, { f: vary(300, 0.05), level: 0.55, bright: 0.2, knock: 0.9, decay: 1.5, body: 0.8 }) - p.t;
}

// DY: an ink drop "plink-bloop" then a rising shimmer of little bells and micro-bubbles. Each colour
// sits on its own step of C major so the dyes have a voice of their own.
const DYE_KEY = { red: 0, orange: 2, yellow: 4, green: 5, blue: 7, purple: 9, pink: -3 };
function dyeShimmer(ctx, out, t, r, level) {
  const ends = [];
  [0, 2, 4, 7, 9].forEach((s, k) => {
    ends.push(bell(ctx, out, t + k * vary(0.075, 0.1), C5 * 2 * semis(s) * r, level * (0.7 + 0.08 * k), vary(0.38, 0.1)));
  });
  ends.push(bubbles(ctx, out, t, { count: 10, level: 0.13, from: 0, to: 0.45, bias: 0.8, fLo: 1500 * r, fHi: 4000 * r, rise: [1.2, 1.6], len: [0.006, 0.016] }));
  ends.push(noiseHit(ctx, out, t, { dur: 0.25, level: 0.025, attack: 0.25, hp: 5000, lp: 11000 }));
  return Math.max(...ends);
}
function dyeJelly(ctx, out, p) {
  const t = p.t, r = semis(DYE_KEY[p.color] ?? 0), v = vary(1, 0.03) * r;
  return Math.max(
    toneHit(ctx, out, t, { freqs: [[0, 600 * v], [0.012, 1200 * v]], dur: 0.03, level: 0.24, attack: 0.0008 }),
    toneHit(ctx, out, t + 0.03, { freqs: [[0, 262 * v], [0.05, 175 * v], [0.15, 420 * v]], dur: 0.12, hold: 0.03, level: 0.42, attack: 0.004 }),
    bandHit(ctx, out, t + 0.03, { dur: 0.12, from: 500 * v, to: 1200 * v, Q: 6, level: 0.18, attack: 0.01 }),
    dyeShimmer(ctx, out, t + 0.12, r, 0.17),
  ) - t;
}
function dyeSolid(ctx, out, p) {
  const t = p.t, r = semis(DYE_KEY[p.color] ?? 0);
  return Math.max(
    plastic(ctx, out, t, { f: vary(1100, 0.04) * r, level: 0.5, bright: 0.45, knock: 0.3 }),
    dyeShimmer(ctx, out, t + 0.05, r, 0.17),
  ) - t;
}

// BW: a bubble-wrap chain — `count` round pops `stagger` s apart, one semitone higher per cell
// (up to an octave), the last a little fuller, a sparkle after three or more.
function popVoice(ctx, out, p) {
  const t = p.t, n = clampInt(p.count, 1, 16, 1);
  const s = clamp(Number.isFinite(p.stagger) ? p.stagger : 0.04, 0.015, 0.12);
  const ends = [];
  let tk = t;
  for (let k = 0; k < n; k++) {
    const r = semis(Math.min(k, 12)) * vary(1, 0.03), a = (k === n - 1 && n > 1 ? 1 : 0.85) * vary(1, 0.1);
    ends.push(
      bandHit(ctx, out, tk, { dur: 0.012, from: 2200 * r, to: 1400 * r, Q: 2.5, level: 0.5 * a, attack: 0.0005 }),
      toneHit(ctx, out, tk, { freqs: [[0, 520 * r], [0.018, 220 * r]], dur: 0.035, level: 0.8 * a, attack: 0.0008 }),
      noiseHit(ctx, out, tk, { kind: 'pink', dur: 0.03, level: 0.28 * a, attack: 0.001, lp: 2500 }),
    );
    tk += s * vary(1, 0.12);
  }
  if (n >= 3) ends.push(sparkle(ctx, out, tk + 0.02, { level: 0.24, ratio: semis(Math.min(n - 1, 12) / 2), count: 2 }));
  return Math.max(...ends) - t;
}

// CL: false = the padlock rattles on a refusal (three small metal clacks, settling);
// true = it clicks open ("ka-chunk", a spring) with a sparkle.
function padlockVoice(ctx, out, p) {
  const t = p.t;
  if (!p.open) {
    let tk = t;
    const ends = [];
    [0.6, 0.48, 0.34].forEach((lv, k) => {
      const f = vary(2000, 0.05);
      ends.push(plastic(ctx, out, tk, { f, level: lv, bright: 0.6, knock: 0.12, decay: 0.7 }), bell(ctx, out, tk, f * 1.47, lv * 0.14, 0.12));
      tk += vary(0.05 - 0.008 * k, 0.12);
    });
    ends.push(toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, 300], [0.05, 250]], dur: 0.06, level: 0.25, attack: 0.002 }));
    return Math.max(...ends) - t;
  }
  const t2 = t + vary(0.09, 0.08);
  return Math.max(
    plastic(ctx, out, t, { f: vary(1900, 0.04), level: 0.45, bright: 0.6, knock: 0.3 }),
    toneHit(ctx, out, t + 0.02, { freqs: [[0, 500], [0.08, 1000]], dur: 0.09, level: 0.12, attack: 0.002 }),
    plastic(ctx, out, t2, { f: vary(1500, 0.04), level: 0.42, bright: 0.5, knock: 0.4, body: 0.4 }),
    sparkle(ctx, out, t2 + 0.05, { level: 0.34, count: 4, gap: 0.04 }),
  ) - t;
}

// JR: the jar swallows ("gulp" + the glass jar ringing softly); full = + a tiny lid burp and the
// lid clinking shut.
function gulpJelly(ctx, out, p) {
  const t = p.t, v = vary(1, 0.05);
  const ends = [
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, 230 * v], [0.09, 120 * v]], dur: 0.12, level: 0.42, attack: 0.004 }),
    bandHit(ctx, out, t, { dur: 0.12, from: 1100 * v, to: 350 * v, Q: 7, level: 0.32, attack: 0.01 }),
    toneHit(ctx, out, t + 0.1, { freqs: [[0, 300 * v], [0.02, 650 * v]], dur: 0.04, level: 0.22, attack: 0.001 }),
    bell(ctx, out, t + 0.04, vary(1350, 0.03), 0.07, 0.35),
    bell(ctx, out, t + 0.04, vary(1985, 0.03), 0.035, 0.25),
  ];
  return Math.max(...ends, p.full ? lidShut(ctx, out, t + vary(0.26, 0.06)) : t) - t;
}
function lidShut(ctx, out, t) {
  const v = vary(1, 0.05), tc = t + 0.2;
  return Math.max(
    formant(ctx, out, t, {
      dur: 0.17, pitch: [[0, 160 * v], [0.17, 125 * v]], formants: [[0, 620, 1050], [0.17, 460, 860]],
      level: 0.26, attack: 0.015, release: 0.06, flutter: 0.35, flutterRate: 32, breath: 0.15, lp: 1600,
    }),
    plastic(ctx, out, tc, { f: vary(2600, 0.03), level: 0.34, bright: 0.55, knock: 0.1, decay: 0.6 }),
    bell(ctx, out, tc, vary(3100, 0.03), 0.08, 0.25),
    plastic(ctx, out, tc + vary(0.045, 0.15), { f: vary(2650, 0.03), level: 0.16, bright: 0.45, knock: 0, decay: 0.5 }),
  );
}
function gulpSolid(ctx, out, p) {
  const t = p.t;
  return Math.max(
    plastic(ctx, out, t, { f: vary(700, 0.04), level: 0.6, bright: 0.35, knock: 0.6, body: 0.6 }),
    bell(ctx, out, t + 0.01, vary(1350, 0.03), 0.07, 0.35),
    p.full ? plastic(ctx, out, t + 0.22, { f: vary(2600, 0.03), level: 0.38, bright: 0.55, knock: 0.1, decay: 0.6 }) : t,
    p.full ? bell(ctx, out, t + 0.22, vary(3100, 0.03), 0.08, 0.25) : t,
  ) - t;
}

// SG: the ticket queue advances — a bell on the next step of a pentatonic ladder (index 0 = G5),
// a soft mallet an octave down and the chips sliding.
const DING_STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
function dingVoice(ctx, out, p) {
  const t = p.t, k = clampInt(p.index, 0, DING_STEPS.length - 1, 0);
  const f = C5 * semis(7 + DING_STEPS[k]) * vary(1, 0.006);
  return Math.max(
    bell(ctx, out, t, f, 0.3 * vary(1, 0.08), vary(0.6, 0.1)),
    mallet(ctx, out, t + rand(0, 0.006), (f / 2) * vary(1, 0.004), 0.18 * vary(1, 0.1), vary(0.3, 0.1)),
    bandHit(ctx, out, t + 0.04, { dur: 0.08, from: 1500, to: 3000, Q: 1.5, level: 0.06, attack: 0.02 }),
  ) - t;
}

// MB: crossing a membrane — a tiny drop "plip" and the film flexing.
function plipVoice(ctx, out, p) {
  const t = p.t, v = vary(1, 0.06);
  return Math.max(
    toneHit(ctx, out, t, { freqs: [[0, 900 * v], [0.015, 1900 * v]], dur: 0.03, level: 0.36, attack: 0.001 }),
    bandHit(ctx, out, t, { dur: 0.05, from: 450 * v, to: 1100 * v, Q: 4, level: 0.22, attack: 0.006 }),
    toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, 200 * v], [0.04, 150 * v]], dur: 0.05, level: 0.14, attack: 0.004 }),
  ) - t;
}

// ---------------------------------------------------------------- meta (spec §7)

// Reward chest: the jelly-box wobbles (squishes climbing, quicker each time), splats open with a
// pop, then the reward sparkle. 'star' adds a bell run, 'chapter' a bigger wobble, a low boom and
// a bell chord.
function chestVoice(ctx, out, p) {
  const t = p.t, kind = p.kind === 'chapter' || p.kind === 'star' ? p.kind : 'level';
  const n = kind === 'chapter' ? 5 : kind === 'star' ? 4 : 3;
  const ends = [];
  let tk = t;
  for (let k = 0; k < n; k++) {
    const r = semis(2 * k), up = k % 2 === 0;
    ends.push(
      bandHit(ctx, out, tk, { dur: 0.09, from: (up ? 350 : 700) * r, to: (up ? 700 : 380) * r, Q: 6, level: 0.24 + 0.05 * k, attack: 0.006 }),
      toneHit(ctx, out, tk, { wave: 'warm', freqs: [[0, 140 * r], [0.08, 112 * r]], dur: 0.1, level: 0.22 + 0.04 * k, attack: 0.004 }),
    );
    tk += lerp(0.17, 0.09, k / Math.max(1, n - 1)) * vary(1, 0.06);
  }
  const ts = tk + 0.03;
  const big = kind === 'chapter' ? 1 : 0.8;
  ends.push(
    noiseHit(ctx, out, ts, { kind: 'pink', dur: 0.14, level: 0.55 * big, attack: 0.002, lp: 4000, lpTo: 300, lpQ: 1.5 }),
    toneHit(ctx, out, ts, { wave: 'warm', freqs: [[0, 120], [0.1, 70]], dur: 0.2, level: 0.55 * big, attack: 0.003 }),
    bandHit(ctx, out, ts + 0.006, { dur: 0.12, from: 1500, to: 350, Q: 7, level: 0.36, attack: 0.003 }),
    toneHit(ctx, out, ts + 0.03, { freqs: [[0, 400], [0.02, 1200]], dur: 0.06, level: 0.42, attack: 0.001 }),
    droplets(ctx, out, ts, 6, 0.18, { from: 0.02, to: 0.3 }),
    jiggleTail(ctx, out, ts + 0.04, { level: 0.24, dur: 0.5, freq: 170, rate: 8, depth: 0.5 }),
    sparkle(ctx, out, ts + 0.07, { level: 0.42, count: 4, gap: 0.045 }),
  );
  if (kind === 'star') {
    [0, 4, 7, 12, 16].forEach((s, k) => ends.push(bell(ctx, out, ts + 0.18 + k * 0.065, C5 * 2 * semis(s), 0.16, 0.5)));
  }
  if (kind === 'chapter') {
    ends.push(timpani(ctx, out, ts, 98, 0.3, 0.8));
    for (const s of [0, 4, 7, 12]) ends.push(mallet(ctx, out, ts + 0.12, C5 / 2 * semis(s), 0.16, 0.7));
    for (const s of [12, 16, 19, 24]) ends.push(bell(ctx, out, ts + 0.14 + rand(0, 0.015), C5 * semis(s), 0.13, 0.9));
    ends.push(bubbles(ctx, out, ts + 0.1, { count: 12, level: 0.12, from: 0, to: 0.7, bias: 1.3, fLo: 3000, fHi: 7000, rise: [1, 1.02], len: [0.03, 0.08] }));
  }
  return Math.max(...ends) - t;
}

// Jelly unlock ceremony, escalating with rarity (spec §7.3):
// common 2-note ta-da · rare 3 notes + sparkle · epic arpeggio + pad · legendary fanfare + timpani + choir.
const RARITIES = ['common', 'rare', 'epic', 'legendary'];
function unlockVoice(ctx, out, p) {
  const t = p.t, rarity = RARITIES.includes(p.rarity) ? p.rarity : 'common';
  const N = s => C5 * semis(s);
  const ends = [];
  const note = (at, s, lv, decay = 0.35) => {
    const f = N(s) * vary(1, 0.005), a = at + rand(0, 0.008);
    ends.push(mallet(ctx, out, a, f, lv * vary(1, 0.06), vary(decay, 0.08)), bell(ctx, out, a, f * 2, lv * 0.32, decay * 0.9));
  };
  if (rarity === 'common') {
    note(t, 7, 0.3, 0.25);
    note(t + 0.13, 12, 0.38, 0.55);
    ends.push(mallet(ctx, out, t + 0.13, N(-12), 0.18, 0.5));
    ends.push(bubbles(ctx, out, t + 0.15, { count: 4, level: 0.12, from: 0, to: 0.3, fLo: 3000, fHi: 6000, rise: [1, 1.03], len: [0.03, 0.07] }));
  } else if (rarity === 'rare') {
    note(t, 4, 0.28, 0.25);
    note(t + 0.1, 7, 0.3, 0.25);
    note(t + 0.2, 12, 0.38, 0.6);
    ends.push(mallet(ctx, out, t + 0.2, N(-12), 0.2, 0.55));
    ends.push(sparkle(ctx, out, t + 0.26, { level: 0.4, count: 4, gap: 0.045 }));
  } else if (rarity === 'epic') {
    [0, 4, 7, 12, 16].forEach((s, k) => note(t + k * 0.07, s, 0.24 + 0.03 * k, k === 4 ? 0.7 : 0.25));
    for (const s of [-12, -8, -5, 0]) ends.push(padNote(ctx, out, t + 0.05, N(s), { level: 0.06, attack: 0.35, hold: 0.55, release: 0.8 }));
    ends.push(toneHit(ctx, out, t + 0.28, { wave: 'warm', freqs: [[0, N(-24)]], dur: 0.7, level: 0.22, attack: 0.02 }));
    ends.push(sparkle(ctx, out, t + 0.34, { level: 0.42, count: 4, gap: 0.05 }));
    ends.push(bubbles(ctx, out, t + 0.35, { count: 10, level: 0.12, from: 0, to: 0.8, bias: 1.3, fLo: 3000, fHi: 7000, rise: [1, 1.02], len: [0.03, 0.09] }));
  } else {
    // timpani roll into a brass fanfare G–C–E–G, a held chord with a choir "aah" and a big shimmer
    for (let k = 0; k < 5; k++) ends.push(timpani(ctx, out, t + k * 0.055, 98, 0.1 + 0.05 * k, 0.35));
    const tf = t + 0.3, beat = 0.13;
    [[-5, 1], [0, 1], [4, 1], [7, 7]].forEach(([s, len], k) => {
      ends.push(brass(ctx, out, tf + k * beat, N(s), { level: k === 3 ? 0.2 : 0.16, dur: len * beat * (k === 3 ? 1.2 : 0.9) }));
    });
    const th = tf + 3 * beat;
    ends.push(brass(ctx, out, th, N(-12), { level: 0.12, dur: 1.0, bloom: 1600 }));
    ends.push(brass(ctx, out, th, N(-5), { level: 0.1, dur: 1.0, bloom: 1800 }));
    ends.push(timpani(ctx, out, th, 130.81, 0.5, 0.9));
    ends.push(timpani(ctx, out, th + 0.5, 98, 0.22, 0.6));
    for (const [s, k] of [[-12, 0], [-8, 1], [-5, 2], [0, 3]]) {
      const f = N(s) * vary(1, 0.004);
      ends.push(formant(ctx, out, th + 0.02 + 0.02 * k, {
        dur: 1.6, pitch: [[0, f], [1.6, f]], formants: [[0, 800, 1200, 2600], [1.6, 760, 1150, 2500]], q: [8, 10, 12],
        level: 0.06, attack: 0.3, release: 0.7, vib: 0.006, vibRate: 5 + 0.3 * k, breath: 0.12, lp: 3500,
      }));
    }
    ends.push(sparkle(ctx, out, th + 0.05, { level: 0.42, count: 4, gap: 0.05 }));
    ends.push(sparkle(ctx, out, th + 0.5, { level: 0.3, count: 4, gap: 0.06, ratio: 2 }));
    ends.push(bubbles(ctx, out, th + 0.1, { count: 18, level: 0.13, from: 0, to: 1.3, bias: 1.2, fLo: 3000, fHi: 7500, rise: [1, 1.02], len: [0.03, 0.1] }));
    ends.push(noiseHit(ctx, out, th, { dur: 0.6, level: 0.03, attack: 0.1, hp: 6500, lp: 12000 }));
  }
  return Math.max(...ends) - t;
}

// ---------------------------------------------------------------- character voices (JellyDef.voice)
// (ctx, out, { t, pitch 0.5..2, intensity 0..1 }) → duration. Small, cute, never shrill: the
// brightest partials stay soft and everything passes a low-pass.

const vp = p => clamp(Number.isFinite(p.pitch) ? p.pitch : 1, 0.5, 2) * vary(1, 0.02);
const vA = p => loudness(clamp01(p.intensity ?? 0.6), 14);

const CHARACTER = {
  // rubber toy "squee-ak"
  squeak(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p), D = vary(0.17, 0.1), f = 680 * P;
    return Math.max(
      formant(ctx, out, t, {
        dur: D, pitch: [[0, f], [D * 0.45, f * 1.25], [D, f * 0.95]], formants: [[0, 1700 * Math.sqrt(P)], [D, 1900 * Math.sqrt(P)]],
        q: [3], weights: [0.9], level: 0.34 * A, attack: 0.012, release: 0.05, wave: 'triangle', vib: 0.02, vibRate: 30, lp: 4200,
      }),
      bandHit(ctx, out, t, { dur: D * 0.8, from: 2400, to: 2800, Q: 2, level: 0.05 * A, attack: 0.01 }),
    ) - t;
  },
  // "mi-aow"
  meow(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p), D = vary(0.42, 0.08) / Math.pow(P, 0.3), s = Math.sqrt(P), f = 520 * P;
    return formant(ctx, out, t, {
      dur: D, pitch: [[0, f], [D * 0.3, f * 1.33], [D * 0.7, f * 1.08], [D, f * 0.82]],
      formants: [[0, 350 * s, 2300 * s], [D * 0.3, 760 * s, 1700 * s], [D * 0.7, 850 * s, 1250 * s], [D, 450 * s, 900 * s]],
      level: 0.3 * A, attack: 0.03, release: 0.12, vib: 0.012, vibRate: 6.5, breath: 0.15, lp: 4000,
    }) - t;
  },
  // "rib-bit": two croaky syllables
  ribbit(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p), s = Math.sqrt(P), t2 = t + vary(0.16, 0.06);
    return Math.max(
      formant(ctx, out, t, {
        dur: 0.12, pitch: [[0, 170 * P], [0.12, 150 * P]], formants: [[0, 560 * s, 1300 * s], [0.12, 600 * s, 1350 * s]],
        level: 0.34 * A, attack: 0.008, release: 0.04, flutter: 0.9, flutterRate: 38 * s, breath: 0.08, lp: 2600,
      }),
      formant(ctx, out, t2, {
        dur: 0.1, pitch: [[0, 215 * P], [0.1, 190 * P]], formants: [[0, 660 * s, 1500 * s], [0.1, 620 * s, 1450 * s]],
        level: 0.3 * A, attack: 0.008, release: 0.04, flutter: 0.9, flutterRate: 44 * s, breath: 0.08, lp: 2600,
      }),
    ) - t;
  },
  // nasal "kwak"
  quack(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p), s = Math.sqrt(P), D = vary(0.2, 0.08), f = 320 * P;
    return Math.max(
      noiseHit(ctx, out, t, { dur: 0.004, level: 0.06 * A, attack: 0.0005, hp: 1500, lp: 4000 }),
      formant(ctx, out, t + 0.004, {
        dur: D, pitch: [[0, f], [D * 0.2, f * 1.12], [D, f * 0.8]], formants: [[0, 900 * s, 2400 * s], [D * 0.25, 1150 * s, 2600 * s], [D, 700 * s, 2000 * s]],
        q: [5, 6], weights: [1, 0.7], level: 0.3 * A, attack: 0.008, release: 0.06, breath: 0.1, lp: 3600,
      }),
    ) - t;
  },
  // "hee-hee-hee-hee", stepping down
  giggle(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p), s = Math.sqrt(P), n = Math.random() < 0.5 ? 3 : 4, ends = [];
    let tk = t;
    for (let k = 0; k < n; k++) {
      const f = 600 * P * semis(-1.3 * k) * vary(1, 0.02), d = vary(0.065, 0.1);
      ends.push(formant(ctx, out, tk, {
        dur: d, pitch: [[0, f * 1.04], [d, f * 0.94]], formants: [[0, 400 * s, 2400 * s]], q: [6, 8],
        level: 0.26 * A * (1 - 0.1 * k), attack: 0.012, release: 0.03, breath: 0.4, lp: 3800,
      }));
      tk += d + vary(0.035, 0.15);
    }
    return Math.max(...ends) - t;
  },
  // underwater "blub-blub"
  blub(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p), ends = [];
    [0, 0.09, 0.17].forEach((dt, k) => {
      const f = 220 * P * vary(1, 0.08) * (1 + 0.12 * k);
      ends.push(toneHit(ctx, out, t + dt * vary(1, 0.1), { freqs: [[0, f], [0.05, f * 2.3]], dur: 0.07, level: (0.36 - 0.05 * k) * A, attack: 0.002 }));
    });
    ends.push(noiseHit(ctx, out, t, { kind: 'pink', dur: 0.24, level: 0.12 * A, attack: 0.02, lp: 600 }));
    return Math.max(...ends) - t;
  },
  // cartoon spring "boi-oi-oing"
  boing(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p), D = vary(0.42, 0.06), f = 180 * P * vary(1, 0.04);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    contour(o.frequency, t, [[0, f], [vary(0.05, 0.15), f * vary(2.3, 0.04)], [D, f * 2.1]]);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 16 * vary(1, 0.05);
    const depth = gainNode(ctx, 0);
    depth.gain.setValueAtTime(f * 0.28, t);
    depth.gain.exponentialRampToValueAtTime(f * 0.01, t + D);
    chain(lfo, depth, o.frequency);
    const g = ctx.createGain();
    envelope(g.gain, t, 0.36 * A, 0.005, D - 0.05, 0.05);
    chain(o, filter(ctx, 'lowpass', 3000), g, out);
    for (const n of [o, lfo]) { n.start(t); n.stop(t + D + 0.06); }
    return Math.max(
      t + D + 0.06,
      toneHit(ctx, out, t, { wave: 'warm', freqs: [[0, 120 * P], [0.05, 90 * P]], dur: 0.06, level: 0.2 * A, attack: 0.002 }),
    ) - t;
  },
  // little bird: two or three quick upward chirps
  chirp(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p), n = Math.random() < 0.6 ? 2 : 3, ends = [];
    let tk = t;
    for (let k = 0; k < n; k++) {
      const f = 1700 * P * vary(1, 0.05);
      ends.push(
        toneHit(ctx, out, tk, { freqs: [[0, f], [0.035, f * 1.6]], dur: 0.045, level: 0.24 * A, attack: 0.003 }),
        toneHit(ctx, out, tk, { freqs: [[0, f * 2], [0.035, f * 3.2]], dur: 0.02, level: 0.03 * A, attack: 0.003 }),
      );
      tk += vary(0.075, 0.12);
    }
    return Math.max(...ends) - t;
  },
  // soft ghostly "ooOOooh"
  moan(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p), s = Math.sqrt(P), D = vary(0.75, 0.06), f = 240 * P;
    return formant(ctx, out, t, {
      dur: D, pitch: [[0, f], [D * 0.4, f * 1.17], [D, f * 0.84]], formants: [[0, 350 * s, 700 * s], [D * 0.5, 460 * s, 860 * s], [D, 320 * s, 650 * s]],
      level: 0.3 * A, attack: 0.18, release: 0.3, vib: 0.02, vibRate: 4.5, breath: 0.35, wave: 'triangle', weights: [1, 0.6], lp: 2200,
    }) - t;
  },
  // magical twinkle
  sparkle(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p);
    return Math.max(
      sparkle(ctx, out, t, { level: 0.36 * A, ratio: P * 0.75, count: 4, gap: 0.05 }),
      bubbles(ctx, out, t + 0.05, { count: 5, level: 0.12 * A, from: 0, to: 0.3, fLo: 2500 * P, fHi: 5000 * P, rise: [1, 1.03], len: [0.02, 0.06] }),
    ) - t;
  },
  // small cute "grrr"
  growl(ctx, out, p) {
    const t = p.t, P = vp(p), A = vA(p), s = Math.sqrt(P), D = vary(0.38, 0.08), f = 120 * P;
    return formant(ctx, out, t, {
      dur: D, pitch: [[0, f], [D * 0.4, f * 1.15], [D, f * 0.92]], formants: [[0, 500 * s, 1100 * s], [D, 560 * s, 1200 * s]],
      level: 0.34 * A, attack: 0.06, release: 0.1, flutter: 0.7, flutterRate: 26 * s, breath: 0.3, lp: 2000,
    }) - t;
  },
};

/** Character voice types a JellyDef `voice.type` may use (contract §8). */
export const VOICE_TYPES = Object.freeze(Object.keys(CHARACTER));

/** Character voice synths by type: (ctx, destNode, { t, pitch, intensity }) → duration (s). */
export const CHARACTER_VOICES = Object.freeze({ ...CHARACTER });

// Per-type trim (dB), measured with tests/audio-test.html → "Offline check · Progression" so every
// voice lands near the same short-term loudness (≈ 8–9 LU under an exit: present, never in the way).
const VOICE_TRIM = { squeak: 10, meow: 4.5, ribbit: 10.5, quack: 2, giggle: 12, blub: 8, boing: 0.5, chirp: 10, moan: 9, sparkle: -2, growl: 5 };

function characterVoice(ctx, out, p) {
  const type = CHARACTER[p.type] ? p.type : 'squeak';
  const trim = gainNode(ctx, dbToGain(VOICE_TRIM[type] ?? 0));
  trim.connect(out);
  return CHARACTER[type](ctx, trim, p);
}

const byMode = (jelly, solid) => (ctx, out, p) => (p.mode === 'solid' ? solid : jelly)(ctx, out, p);

/** Synth voices by sound type: (ctx, destNode, params) → duration in seconds. */
export const VOICES = {
  slap: slapVoice,
  impact: impactVoice,
  collide: collideVoice,
  grab: grabVoice,
  release: releaseVoice,
  squish: squishVoice,
  spawn: spawnVoice,
  // Squeeze Out! — params.mode 'solid' selects the dry plastic variant
  land: byMode(landJelly, landSolid),
  slide: byMode(slideJelly, slideSolid),
  bump: byMode(bumpJelly, bumpSolid),
  squeezeThrough: byMode(squeezeJelly, exitSolid),
  squeezeFail: byMode(squeezeFailJelly, squeezeFailSolid),
  exit: byMode(exitJelly, exitSolid),
  iceCrack: iceCrackVoice,
  tick: tickVoice,
  win: winVoice,
  lose: loseVoice,
  uiTap: uiTapVoice,
  reveal: revealVoice,
  // Progression (contract §8): the 12 mechanics, meta ceremonies and character voices
  peel: byMode(peelJelly, peelSolid),
  mouldSet: byMode(mouldSetJelly, mouldSetSolid),
  snore: snoreVoice,
  yawn: yawnVoice,
  taffyStretch: taffyGrain,
  tear: byMode(tearJelly, tearSolid),
  bloop: byMode(bloopJelly, bloopSolid),
  breathe: breatheVoice,
  strain: strainVoice,
  rail: railGrain,
  sizzle: sizzleVoice,
  melt: meltVoice,
  gloop: byMode(gloopJelly, gloopSolid),
  dye: byMode(dyeJelly, dyeSolid),
  pop: popVoice,
  padlock: padlockVoice,
  gulp: byMode(gulpJelly, gulpSolid),
  ding: dingVoice,
  plip: plipVoice,
  chest: chestVoice,
  unlock: unlockVoice,
  voice: characterVoice,
};

// ---------------------------------------------------------------- player

export class JellyAudio {
  /**
   * @param {object} [opts]
   * @param {BaseAudioContext} [opts.context] use this context (e.g. an OfflineAudioContext in
   *   tests) instead of creating an AudioContext in unlock()
   * @param {number} [opts.volume=0.85]
   * @param {'jelly'|'solid'} [opts.mode='jelly'] Squeeze Out! material voices
   */
  constructor({ context = null, volume = 0.85, mode = 'jelly' } = {}) {
    this.ctx = null;
    this.stats = { played: 0, dropped: 0, stolen: 0, maxVoices: 0 };
    this._context = context;
    this._offline = false;
    this._unsupported = false;
    this._enabled = true;
    this._volume = clamp01(volume);
    this._bus = null;
    this._voices = [];         // { type, start, end, priority, nodes, stolen }
    this._last = {};           // type → { time, intensity } of the last played sound
    this._density = {};        // type (and '*' for all) → { value, time }: recent triggers, decaying
    this._squish = new Map();  // hold key → stretch-rate tracker
    this._slides = new Map();  // drag key → slither grain tracker
    this._taffy = new Map();   // twin pair key → strand creak tracker
    this._rails = new Map();   // striped piece key → zip grain tracker
    this._lastDur = 0;         // duration (s) of the sound _play() last started
    this._lastStart = 0;       // context time it starts at
    this.lastSqueeze = null;   // { ctxPop, perfPop (performance.now() ms the pop is heard), duration }
    this._ticks = 0;           // tick/tock alternation
    this._mode = mode === 'solid' ? 'solid' : 'jelly';
    this.music = null;         // src/music.js bed (own gain; Settings → Music), created with the context
    this._musicOn = true;
    this._musicMood = 'off';
    this._held = null;         // why we suspended the context ourselves: 'hidden' | 'idle' | null
    this._resuming = null;     // Promise while leaving an idle hold
    this._lastSound = 0;       // performance.now() of the last sound started
  }

  /**
   * Battery: suspend the running AudioContext (the master chain's reverb and compressor otherwise
   * process silence forever). reason 'hidden' (app in the background) or 'idle' (nothing heard for
   * a while, Free mode). A sound asked for while 'idle'-suspended is played as soon as the context
   * is back (unlock() / the next gesture resumes it); unhold(reason) resumes a 'hidden' one.
   */
  hold(reason = 'idle') {
    const ctx = this.ctx;
    if (!ctx || this._offline) return;
    if (reason === 'idle' && (this._held || this.music?._on?.())) return; // the music bed needs the clock
    this._held = reason === 'hidden' ? 'hidden' : this._held || 'idle';
    if (ctx.state === 'running') ctx.suspend().catch(() => {});
  }

  // Leave an idle hold: resume, and remember the pending resume so sounds asked for meanwhile wait for it.
  _wakeFromIdle() {
    const ctx = this.ctx;
    this._held = null;
    if (!ctx || this._resuming || ctx.state === 'running') return;
    const done = () => { this._resuming = null; };
    this._resuming = ctx.resume().then(done, done);
  }

  /** Undo hold(reason) (hold('hidden') is only undone by unhold('hidden')). */
  unhold(reason = 'idle') {
    const ctx = this.ctx;
    if (!ctx || !this._held || (this._held === 'hidden' && reason !== 'hidden')) return;
    this._held = null;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  /** Seconds since the last sound started (Infinity before the first). */
  get quietFor() { return this._lastSound ? (performance.now() - this._lastSound) / 1000 : Infinity; }

  /** Settings → Music (independent of Sound effects). */
  setMusicEnabled(on) { this._musicOn = !!on; this.music?.setEnabled(this._musicOn); }
  /** 'menu' | 'play' | 'hard' | 'off' (game flow). */
  setMusicMood(mood) { this._musicMood = mood; this.music?.setMood(mood); }

  get enabled() { return this._enabled; }
  set enabled(on) { this._enabled = !!on; this._applyLevel(); }

  /**
   * Squeeze Out! material: 'jelly' (wet squelches, wobble) or 'solid' (dry plastic click/clack,
   * the A/B control). Affects land/slide/bump/squeezeThrough/squeezeFail/exit/reveal only; every
   * other sound is the same in both modes. Anything but 'solid' means 'jelly'.
   */
  get mode() { return this._mode; }
  set mode(m) { this._mode = m === 'solid' ? 'solid' : 'jelly'; }

  /** 0..1; applied squared, so the slider feels even to the ear. */
  get volume() { return this._volume; }
  set volume(v) { this._volume = clamp01(v); this._applyLevel(); }

  /**
   * Call from a user gesture. Resolves true once audio can play.
   * With `{ rarity }` it is instead the jelly-unlock ceremony sound (contract §8 names it
   * `unlock({ rarity })`): returns true when it started, and never creates the context itself.
   * `unlockCeremony({ rarity })` is the same sound under an unambiguous name.
   */
  unlock(opts) {
    if (opts && typeof opts === 'object' && typeof opts.rarity === 'string') return this.unlockCeremony(opts);
    if (!this.ctx && !this._create()) return Promise.resolve(false);
    const ctx = this.ctx;
    if (this._held === 'idle') this._wakeFromIdle();
    if (this._offline || ctx.state === 'running') return Promise.resolve(true);
    return ctx.resume().then(() => ctx.state === 'running', () => false);
  }

  impact({ intensity = 0.5, pan = 0, material } = {}) {
    this._play('impact', { intensity: clamp01(intensity), material }, pan);
  }

  collide({ intensity = 0.5, pan = 0, material } = {}) {
    this._play('collide', { intensity: clamp01(intensity), material }, pan);
  }

  slap({ intensity = 0.7, pan = 0, material } = {}) {
    this._play('slap', { intensity: clamp01(intensity), material }, pan);
  }

  grab({ pan = 0, material } = {}) {
    this._play('grab', { intensity: 0.6, material }, pan);
  }

  release({ speed = 0, pan = 0, material } = {}) {
    if (!(speed >= RELEASE_MIN_SPEED)) return;
    this._play('release', { speed, intensity: 0.2 + 0.8 * whooshStrength(speed), material }, pan);
  }

  /**
   * Call every frame while a jelly is held. `amount` ≈ 0 (rest) … 1 (very stretched); only how
   * fast it changes makes sound. Pass `id` (e.g. body id) when several jellies can be held.
   */
  squish({ amount = 0, pan = 0, material, id } = {}) {
    if (!this.ctx || !this._enabled || !Number.isFinite(amount)) return;
    const now = this._now();
    const key = id ?? material?.id ?? '';
    const s = this._squish.get(key);
    if (!s || now - s.time > 0.25) {
      if (this._squish.size > 32) this._squish.clear();
      this._squish.set(key, { amount, time: now, speed: 0, acc: 0, dir: 1 });
      return;
    }
    const dt = now - s.time;
    if (dt < 0.004) return;
    const delta = amount - s.amount;
    s.speed += (Math.abs(delta) / dt - s.speed) * (1 - Math.exp(-dt / 0.05));
    if (Math.abs(delta) > 1e-4) s.dir = Math.sign(delta);
    s.amount = amount;
    s.time = now;
    // Grains per second grow with stretch speed, capped hard.
    s.acc = Math.min(1.5, s.acc + clamp((s.speed - 0.08) * 12, 0, 14) * dt);
    if (s.acc < 1) return;
    s.acc -= 1;
    const intensity = clamp(0.15 + 0.3 * s.speed, 0.15, 0.9);
    this._play('squish', { intensity, material, stretch: Math.abs(amount), dir: s.dir }, pan);
  }

  spawn({ pan = 0, material } = {}) {
    this._play('spawn', { intensity: 0.7, material }, pan);
  }

  // ---- Squeeze Out! Each returns true when a sound was started. Every method also takes an
  // optional `mode` ('jelly'|'solid') overriding audio.mode for that one call.

  /** A piece drops into its socket at level start (jelly splat / plastic tock). */
  land({ intensity = 0.6, pan = 0, material, mode } = {}) {
    return this._play('land', { intensity: clamp01(intensity), material, mode: this._modeOf(mode) }, pan);
  }

  /**
   * Call every frame while a piece is dragged. `speed` = piece speed in stage px/s; silent below
   * SLIDE_MIN_SPEED, then soft slither grains at ≈ 6…24 per second as the speed rises (rate- and
   * voice-limited). Pass `id` when several pieces can move at once.
   */
  slide({ speed = 0, pan = 0, material, id, mode } = {}) {
    if (!this.ctx || !this._enabled || !Number.isFinite(speed)) return false;
    const now = this._now();
    const key = id ?? material?.id ?? '';
    const s = this._slides.get(key);
    if (!s || now - s.time > 0.25) {
      if (this._slides.size > 32) this._slides.clear();
      this._slides.set(key, { time: now, speed: Math.max(0, speed), acc: 0.6 }); // first grain comes quickly
      return false;
    }
    const dt = now - s.time;
    if (dt < 0.004) return false;
    s.time = now;
    s.speed += (Math.max(0, speed) - s.speed) * (1 - Math.exp(-dt / 0.04));
    const strength = slideStrength(s.speed);
    if (strength <= 0) { s.acc = 0.6; return false; }
    s.acc = Math.min(1.5, s.acc + lerp(6, 24, strength) * dt);
    if (s.acc < 1) return false;
    s.acc -= 1;
    return this._play('slide', { intensity: 0.2 + 0.8 * strength, material, mode: this._modeOf(mode) }, pan);
  }

  /** A dragged piece is stopped by a wall or another piece. */
  bump({ intensity = 0.5, pan = 0, material, mode } = {}) {
    return this._play('bump', { intensity: clamp01(intensity), material, mode: this._modeOf(mode) }, pan);
  }

  /**
   * The signature squeeze through a narrow gate: wet rising squelch, then a pop at `duration` s
   * (default SQUEEZE_TIME = 0.3; clamp 0.15…0.8 — pass the animation length to sync the pop),
   * droplets and the exit sparkle. It IS the exit sound for that piece: don't also call exit().
   * Solid mode: a normal exit. `combo` as in exit().
   */
  squeezeThrough({ pan = 0, material, combo = 0, duration = SQUEEZE_TIME, mode } = {}) {
    const ok = this._play('squeezeThrough', { intensity: 0.9, material, combo, duration, mode: this._modeOf(mode) }, pan);
    if (ok) {
      // When the pop will be HEARD (haptics.js lines its pop transient up with it, ±10 ms).
      const D = clamp(Number.isFinite(duration) ? duration : SQUEEZE_TIME, 0.15, 0.8);
      const at = this._lastStart + (this._modeOf(mode) === 'solid' ? 0 : D);
      this.lastSqueeze = { ctxPop: at, perfPop: this.perfTimeAt(at), duration: D };
      this.music?.duck(4, D + 0.3);
    }
    return ok;
  }

  /**
   * performance.now() time (ms) at which a sound scheduled at context time `ctxTime` reaches the
   * speaker: uses getOutputTimestamp() (includes the output latency) when the browser has it, else
   * currentTime + outputLatency/baseLatency. NaN before unlock(). Haptics sync uses it.
   */
  perfTimeAt(ctxTime) {
    const ctx = this.ctx;
    if (!ctx || this._offline || typeof performance === 'undefined') return NaN;
    try {
      const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
      if (ts && ts.performanceTime > 0 && Number.isFinite(ts.contextTime) && ts.contextTime > 0) {
        return ts.performanceTime + (ctxTime - ts.contextTime) * 1000;
      }
    } catch { /* fall through */ }
    const lat = (Number(ctx.outputLatency) || 0) + (Number(ctx.baseLatency) || 0);
    return performance.now() + (ctxTime - ctx.currentTime + lat) * 1000;
  }

  /** Too wide: the jelly bulges into the opening and springs back (solid: knocks the frame). */
  squeezeFail({ pan = 0, material, intensity = 0.7, mode } = {}) {
    return this._play('squeezeFail', { intensity: clamp01(intensity), material, mode: this._modeOf(mode) }, pan);
  }

  /** A piece leaves through a gate: plop + sparkle. combo climbs COMBO_LADDER (0/+2/+4/+7/+9/+12 st, holds from 5). */
  exit({ pan = 0, material, combo = 0, mode } = {}) {
    // Guard against exit() fired in the same frame as squeezeThrough() for the same exit.
    const sq = this._last.squeezeThrough;
    if (sq && this.ctx && this.ctx.currentTime - sq.time < 0.05) { this.stats.dropped++; return false; }
    return this._play('exit', { intensity: 0.8, material, combo, mode: this._modeOf(mode) }, pan);
  }

  /** A frozen piece slapped: stage 1 crack, stage 2 shatter + slushy melt. */
  iceCrack({ stage = 1, pan = 0 } = {}) {
    return this._play('iceCrack', { intensity: stage >= 2 ? 1 : 0.8, stage: stage >= 2 ? 2 : 1 }, pan);
  }

  /** A light icy tick: a frozen piece pressed, or refused at a squeeze gate (no crack yet). */
  iceTap({ pan = 0 } = {}) {
    return this._play('iceCrack', { intensity: 0.4, stage: 1, tap: true }, pan);
  }

  /** Wet onset when an exit is committed (the plop follows when the piece has left). */
  slurp({ pan = 0, material, mode } = {}) {
    return this._play('slide', { intensity: 0.95, material, mode: this._modeOf(mode) }, pan);
  }

  /** The mix before the user volume (null until unlocked): a fixed-level tap for recording. */
  get recordSource() { return this._bus?.comp || null; }

  /** Timer tick (alternates tick/tock); urgent = higher and brighter. */
  tick({ urgent = false } = {}) {
    const ok = this._play('tick', { intensity: urgent ? 0.6 : 0.45, urgent: !!urgent, tock: this._ticks % 2 === 1 }, 0);
    if (ok) this._ticks++;
    return ok;
  }

  win() { return this._play('win', { intensity: 1 }, 0); }
  lose() { return this._play('lose', { intensity: 1 }, 0); }
  uiTap() { return this._play('uiTap', { intensity: 0.4 }, 0); }

  /**
   * Win reveal: frost lifts, then after `popDelay` s (default 0.5) the photo jelly bursts out with
   * a big blorp and a sparkle (solid mode: a plastic pop instead of the blorp).
   */
  reveal({ pan = 0, material, popDelay = 0.5, mode } = {}) {
    return this._play('reveal', { intensity: 1, material, popDelay, mode: this._modeOf(mode) }, pan);
  }

  // ---- Progression (contract §8). Same conventions as above: options object, safe no-op before
  // unlock() or while disabled, true when a sound started (voice() returns its duration in s),
  // per-type rate limits, optional `mode` override. Mechanic voices with a dry 'solid' variant:
  // peel, mouldSet, tear, bloop, gloop, dye, gulp; the rest sound the same in both modes.

  /** JJ: the outer skin peels off through a gate. layer 1 = first peel; higher layers pitch up. */
  peel({ layer = 1, pan = 0, material, mode } = {}) {
    return this._play('peel', { intensity: 0.8, layer, material, mode: this._modeOf(mode) }, pan);
  }

  /** ML: a piece sets into its mould (deep thud + glassy click). `combo` (optional) tunes the sparkle. */
  mouldSet({ pan = 0, material, combo = 0, mode } = {}) {
    return this._play('mouldSet', { intensity: 0.85, material, combo, mode: this._modeOf(mode) }, pan);
  }

  /** ZZ: a sleeping jelly is touched / its drag refused. */
  snore({ pan = 0 } = {}) { return this._play('snore', { intensity: 0.5 }, pan); }

  /** ZZ: a sleeper wakes up. */
  yawn({ pan = 0 } = {}) { return this._play('yawn', { intensity: 0.6 }, pan); }

  /**
   * TW: call every frame while a twin pair is dragged; `amount` 0..1 = strand stretch. Creaks
   * (pitch rising with the stretch) only while the stretch changes, plus a sparse creak when it is
   * held taut (> 0.35). Pass `id` per pair.
   */
  taffyStretch({ amount = 0, pan = 0, id, material } = {}) {
    if (!this.ctx || !this._enabled || !Number.isFinite(amount)) return false;
    const now = this._now(), key = id ?? '', a = clamp01(amount);
    const s = this._taffy.get(key);
    if (!s || now - s.time > 0.25) {
      if (this._taffy.size > 32) this._taffy.clear();
      this._taffy.set(key, { amount: a, time: now, speed: 0, acc: 0.5 });
      return false;
    }
    const dt = now - s.time;
    if (dt < 0.004) return false;
    s.speed += (Math.abs(a - s.amount) / dt - s.speed) * (1 - Math.exp(-dt / 0.05));
    s.amount = a;
    s.time = now;
    const rate = clamp((s.speed - 0.05) * 14, 0, 12) + 3 * Math.max(0, a - 0.35);
    if (rate <= 0) { s.acc = Math.min(s.acc, 0.5); return false; }
    s.acc = Math.min(1.5, s.acc + rate * dt);
    if (s.acc < 1) return false;
    s.acc -= 1;
    return this._play('taffyStretch', { intensity: clamp(0.3 + 0.4 * a + 0.3 * Math.min(1, s.speed), 0.2, 1), amount: a, material }, pan);
  }

  /** TW: the twin strand snaps. */
  tear({ pan = 0, mode } = {}) { return this._play('tear', { intensity: 0.8, mode: this._modeOf(mode) }, pan); }

  /** FL: a floaty auto-exits; `combo` as in exit(). */
  bloop({ pan = 0, combo = 0, material, mode } = {}) {
    return this._play('bloop', { intensity: 0.8, combo, material, mode: this._modeOf(mode) }, pan);
  }

  /** PF: dir 'in' = puffing up, 'out' = deflating (≈ 0.25 s, the inflation time). */
  breathe({ dir = 'in', pan = 0 } = {}) {
    return this._play('breathe', { intensity: 0.6, dir: dir === 'out' ? 'out' : 'in' }, pan);
  }

  /** PF held / pushing against a blocker: a short trembling strain. */
  strain({ pan = 0, intensity = 0.5 } = {}) {
    return this._play('strain', { intensity: clamp01(intensity) }, pan);
  }

  /**
   * ST: call every frame while a striped piece slides (`speed` stage px/s): soft zip grains at
   * ≈ 5…18 per second, silent below SLIDE_MIN_SPEED. Pass `id` per piece.
   */
  rail({ speed = 0, pan = 0, id } = {}) {
    if (!this.ctx || !this._enabled || !Number.isFinite(speed)) return false;
    const now = this._now(), key = id ?? '';
    const s = this._rails.get(key);
    if (!s || now - s.time > 0.25) {
      if (this._rails.size > 32) this._rails.clear();
      this._rails.set(key, { time: now, speed: Math.max(0, speed), acc: 0.6 });
      return false;
    }
    const dt = now - s.time;
    if (dt < 0.004) return false;
    s.time = now;
    s.speed += (Math.max(0, speed) - s.speed) * (1 - Math.exp(-dt / 0.04));
    const strength = slideStrength(s.speed);
    if (strength <= 0) { s.acc = 0.6; return false; }
    s.acc = Math.min(1.5, s.acc + lerp(5, 18, strength) * dt);
    if (s.acc < 1) return false;
    s.acc -= 1;
    return this._play('rail', { intensity: 0.25 + 0.75 * strength }, pan);
  }

  /** HT: one crackle burst per move; `left` = moves left (denser and faster as it falls). */
  sizzle({ left = 3, pan = 0 } = {}) {
    const l = Number.isFinite(left) ? Math.max(1, left) : 3;
    return this._play('sizzle', { intensity: 0.5 + 0.1 * clamp(5 - l, 0, 4), left: l }, pan);
  }

  /** HT: the hot jelly melts into a puddle (lose). */
  melt({ pan = 0 } = {}) { return this._play('melt', { intensity: 0.8 }, pan); }

  /** GL: deep wet glorp; play it with squeezeThrough() (pass the same `duration`). */
  gloop({ pan = 0, material, duration = SQUEEZE_TIME, mode } = {}) {
    return this._play('gloop', { intensity: 0.8, material, duration, mode: this._modeOf(mode) }, pan);
  }

  /** DY: a clear jelly takes a colour (bloop + rising shimmer in that colour's key). */
  dye({ pan = 0, color, mode } = {}) {
    return this._play('dye', { intensity: 0.7, color, mode: this._modeOf(mode) }, pan);
  }

  /** BW: a bubble-wrap chain of `count` pops, `stagger` s apart, rising one semitone per cell. */
  pop({ count = 1, pan = 0, stagger = 0.04 } = {}) {
    return this._play('pop', { intensity: 0.7, count, stagger }, pan);
  }

  /** CL: open=false → padlock rattle (refused); open=true → clicks open + sparkle. */
  padlock({ open = false, pan = 0 } = {}) {
    return this._play('padlock', { intensity: open ? 0.8 : 0.55, open: !!open }, pan);
  }

  /** JR: the jar swallows a piece; full=true adds the lid burp and the lid clinking shut. */
  gulp({ full = false, pan = 0, mode } = {}) {
    return this._play('gulp', { intensity: 0.75, full: !!full, mode: this._modeOf(mode) }, pan);
  }

  /** SG: the sequence ticket advances; `index` = the new position (0 = first), rising in pitch. */
  ding({ index = 0, pan = 0 } = {}) { return this._play('ding', { intensity: 0.65, index }, pan); }

  /** MB: a piece crosses a membrane. */
  plip({ pan = 0 } = {}) { return this._play('plip', { intensity: 0.45 }, pan); }

  /** Reward chest: 'level' | 'chapter' | 'star' — wobble, splat open, sparkle. */
  chest({ kind = 'level' } = {}) {
    return this._play('chest', { intensity: 1, kind: kind === 'chapter' || kind === 'star' ? kind : 'level' }, 0);
  }

  /** Jelly unlock ceremony: common < rare < epic < legendary. Same as unlock({ rarity }). */
  unlockCeremony({ rarity = 'common' } = {}) {
    const r = RARITIES.includes(rarity) ? rarity : 'common';
    return this._play('unlock', { intensity: 1, rarity: r }, 0);
  }

  /**
   * Character voice (JellyDef `voice: { type, pitch }`): type ∈ VOICE_TYPES, pitch 0.5..2.
   * Returns the voice's length in s when it started, 0 otherwise (unknown type, locked, limited).
   */
  voice({ type, pitch = 1, intensity = 0.6, pan = 0 } = {}) {
    if (!VOICE_TYPES.includes(type)) return 0;
    const ok = this._play('voice', { intensity: clamp01(intensity), type, pitch }, pan);
    return ok ? this._lastDur : 0;
  }

  // ---- internals

  _modeOf(mode) {
    return mode === 'solid' || mode === 'jelly' ? mode : this._mode;
  }

  _create() {
    if (this._unsupported) return false;
    let ctx = this._context;
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      try {
        ctx = new AC({ latencyHint: 'interactive' });
      } catch (err) {
        this._unsupported = true;
        console.warn('JellyAudio: Web Audio unavailable, sound disabled.', err);
        return false;
      }
      // Older iOS only unlocks once a buffer has been started inside the gesture.
      const blip = ctx.createBufferSource();
      blip.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      blip.connect(ctx.destination);
      blip.start();
    }
    this.ctx = ctx;
    this._offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    this._bus = createMasterChain(ctx);
    cacheFor(ctx); // pre-generate noise buffers now rather than on the first hit
    this._applyLevel(true);
    if (!this._offline) {
      try {
        this.music = new JellyMusic();
        this.music.enabled = this._musicOn;
        this.music.attach(ctx);
        this.music.setMood(this._musicMood);
      } catch { this.music = null; }
    }
    return true;
  }

  _now() {
    return this._offline ? this.ctx.currentTime : performance.now() / 1000;
  }

  _applyLevel(immediate = false) {
    if (!this._bus) return;
    const target = this._enabled ? MAKEUP * this._volume * this._volume : 0;
    const gain = this._bus.master.gain;
    if (immediate) { gain.value = target; return; }
    const now = this.ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(target, now, 0.03);
  }

  _play(type, params, pan) {
    const ctx = this.ctx;
    if (!ctx || !this._enabled || this._volume <= 0) return false;
    if (!this._offline && ctx.state !== 'running') {
      if (this._held === 'hidden') return false;
      if (this._held === 'idle') this._wakeFromIdle();
      // Idle-suspended a moment ago (Free mode): the gesture that asked for this sound is
      // resuming the context; play it the moment the clock runs again (if still in time).
      if (this._resuming) {
        const asked = performance.now();
        this._resuming.then(() => {
          if (ctx.state === 'running' && performance.now() - asked < 250) this._play(type, params, pan);
        });
      } else ctx.resume().catch(() => {});
      return false;
    }
    const now = ctx.currentTime;
    const intensity = params.intensity;

    // Per-type minimum gap, unless the new hit is clearly harder than the last one.
    const last = this._last[type];
    if (last && now - last.time < MIN_GAP[type] && intensity < last.intensity * 1.6) {
      this.stats.dropped++;
      return false;
    }

    // Rapid repeats duck each other (same type strongly, any type a little),
    // so 20 hits a second stay pleasant.
    const duck = DUCK[type] || DUCK_DEFAULT;
    const selfDensity = this._bumpDensity(type, now);
    const allDensity = duck.feed === false ? this._peekDensity('*', now) : this._bumpDensity('*', now);
    const level = dbToGain(rand(-1.5, 1.5)) / (1 + duck.self * selfDensity + duck.all * allDensity);
    const priority = level * loudness(intensity);

    if (!this._makeRoom(type, priority, now)) {
      this.stats.dropped++;
      return false;
    }
    this._last[type] = { time: now, intensity };

    const out = gainNode(ctx, level);
    const nodes = [out];
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(Number.isFinite(pan) ? pan : 0, -1, 1) * 0.8; // never hard-panned
      out.connect(panner);
      nodes.push(panner);
    }
    nodes[nodes.length - 1].connect(this._bus.input);

    const t = now + rand(0.001, 0.004);
    const dur = VOICES[type](ctx, out, { ...params, t });
    this._lastDur = dur;
    this._lastStart = t;
    this._voices.push({ type, start: now, end: t + dur, priority, nodes, stolen: false });
    this._lastSound = performance.now();
    this.stats.played++;
    this.stats.maxVoices = Math.max(this.stats.maxVoices, this._voices.filter(v => v.end > now && !v.stolen).length);
    return true;
  }

  // Recent trigger count for `key` (decays with a 0.3 s time constant), then counts this one.
  _bumpDensity(key, now) {
    const d = this._density[key];
    const value = d ? d.value * Math.exp(-(now - d.time) / 0.3) : 0;
    this._density[key] = { value: value + 1, time: now };
    return value;
  }

  // Same as _bumpDensity without counting this trigger.
  _peekDensity(key, now) {
    const d = this._density[key];
    return d ? d.value * Math.exp(-(now - d.time) / 0.3) : 0;
  }

  // Enforce the per-type and total voice caps; steal the oldest voice when full.
  _makeRoom(type, priority, now) {
    this._voices = this._voices.filter(v => {
      if (v.end + 0.1 > now) return true;
      for (const n of v.nodes) n.disconnect();
      return false;
    });
    const live = this._voices.filter(v => v.end > now && !v.stolen);
    const same = live.filter(v => v.type === type);
    const victim = same.length >= TYPE_CAP[type] ? same[0]
      : live.length >= MAX_VOICES ? live.find(v => !PROTECTED.has(v.type)) || live[0] : null;
    if (!victim) return true;
    // Don't cut a fresh, louder sound for a quiet one.
    if (priority < victim.priority * 0.5 && now - victim.start < 0.08) return false;
    const gain = victim.nodes[0].gain;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(0, now, 0.01);
    victim.stolen = true;
    victim.end = now + 0.06;
    this.stats.stolen++;
    return true;
  }
}
