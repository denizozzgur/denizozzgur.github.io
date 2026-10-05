// Squeeze Out! — procedural background music: a soft kalimba-and-pad bed in C major pentatonic.
//
// Why procedural: no audio files to license, decode or download (boot budget), and it shares the
// sound effects' harmonic world (the win jingle and the combo ladder are C-major pentatonic too).
// It has its own gain straight to the destination, so Settings → Music and Settings → Sound effects
// are independent (review-mining §6.9: "some players hate games with sound").
//
// Mix (playbook B-8): about −20 dB under the SFX peaks; it ducks 4 dB for a squeeze and fades out on
// a pause / ad (the AudioContext is suspended then anyway). Moods: 'menu' (pad + sparse plucks),
// 'play' (+ bass), 'hard' (+ a heartbeat bass on every beat, a darker filter), 'off'.
//
// Battery: each mood is synthesised ONCE into a looping AudioBuffer (an OfflineAudioContext renders
// LOOP_STEPS eighth notes — two passes of the chord cycle with different plucks — and folds the
// release tails past the end back onto the start, so the loop is seamless). Playing is then one
// AudioBufferSourceNode → gain, instead of a 50 ms timer creating ~10 oscillators a second; a mood
// change crossfades to the other mood's loop at the same position. Without OfflineAudioContext
// (or if rendering fails) the bed falls back to the live look-ahead scheduler below (a 50 ms timer
// scheduling notes 0.25 s ahead on the AudioContext clock). DOM-free.

const BPM = 84;
const STEP = 60 / BPM / 2;                 // one 8th note (s)
const LOOK = 0.25;                         // s scheduled ahead (live fallback)
const MIDI = (n) => 440 * Math.pow(2, (n - 69) / 12);
// I – vi – IV – V in C, one chord per bar (8 eighths); tones are MIDI notes.
const CHORDS = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
const PENTA = [60, 62, 64, 67, 69, 72, 74, 76];
// 8-step pluck rhythm per bar (1 = play), two variants alternate.
const RHYTHM = [[1, 0, 1, 1, 0, 1, 0, 1], [1, 0, 0, 1, 1, 0, 1, 0]];
export const MUSIC_LEVEL = 0.11;           // linear gain of the bed (≈ −19 dBFS before the SFX master)
export const MOODS = Object.freeze(['off', 'menu', 'play', 'hard']);
// Pre-rendered loop: 128 eighths ≈ 45.7 s (the 64-step cycle twice, different plucks each time).
export const LOOP_STEPS = 128;
const LOOP_RATE = 22050;                   // Hz: everything sits under the 2.4 kHz bed filter
const TAIL = 1.6;                          // s rendered past the loop end and folded back
const XFADE = 0.6;                         // s mood crossfade
const MAX_CACHED = 2;                      // loops kept (≈ 4 MB each)

/** Seeded LCG (the bed's pluck choices); state in `o._seed`. */
function nextRand(o) { o._seed = (o._seed * 1103515245 + 12345) >>> 0; return (o._seed >>> 8) / 16777216; }

/**
 * Schedule one eighth note of `mood` at time t on ctx into `dest` (shared by the offline render and
 * the live fallback). `st` carries the PRNG seed and the last pluck note.
 */
function scheduleStep(ctx, dest, mood, step, t, st) {
  const bar = Math.floor(step / 8) % CHORDS.length, beat = step % 8;
  const chord = CHORDS[bar];
  const variant = Math.floor(step / (8 * CHORDS.length)) % 2;
  if (beat === 0) pad(ctx, dest, chord, t, STEP * 8);
  if (mood !== 'menu' && (beat === 0 || beat === 4 || (mood === 'hard' && beat % 2 === 0))) bass(ctx, dest, chord[0] - 24, t, mood === 'hard' ? 0.5 : 0.7);
  const play = RHYTHM[variant][beat] && (mood !== 'menu' || beat % 2 === 0);
  if (play) {
    // Chord tones on strong steps, pentatonic neighbours on weak ones; never two equal notes in a row.
    const pool = beat % 2 === 0 ? chord.map((n) => n + 12) : PENTA.map((n) => n + 12);
    let n = pool[Math.floor(nextRand(st) * pool.length)];
    if (n === st._lastNote) n = pool[(pool.indexOf(n) + 1) % pool.length];
    st._lastNote = n;
    pluck(ctx, dest, n, t, beat === 0 ? 0.9 : 0.6 + nextRand(st) * 0.25);
  }
}

function pluck(ctx, dest, note, t, vel) {
  const f = MIDI(note);
  const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = f;
  o2.type = 'triangle'; o2.frequency.value = f * 2.01;
  const g2 = ctx.createGain(); g2.gain.value = 0.18;
  o.connect(g); o2.connect(g2); g2.connect(g); g.connect(dest);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.32 * vel, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0008, t + 0.9);
  o.start(t); o2.start(t); o.stop(t + 1); o2.stop(t + 1);
}

function bass(ctx, dest, note, t, vel) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = MIDI(note);
  o.connect(g); g.connect(dest);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.42 * vel, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, t + STEP * 3);
  o.start(t); o.stop(t + STEP * 3 + 0.05);
}

function pad(ctx, dest, chord, t, dur) {
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
  const g = ctx.createGain();
  lp.connect(g); g.connect(dest);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.05, t + 0.8);
  g.gain.setValueAtTime(0.05, t + dur - 0.6);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.2);
  for (const n of chord) for (const d of [-6, 6]) {
    const o = ctx.createOscillator();
    o.type = 'triangle'; o.frequency.value = MIDI(n); o.detune.value = d;
    o.connect(lp); o.start(t); o.stop(t + dur + 0.3);
  }
}

const moodCutoff = (mood) => (mood === 'hard' ? 1500 : 2400);

/**
 * Render `mood`'s loop (LOOP_STEPS eighths) into a mono AudioBuffer of `ctx` (seamless: the tail
 * past the end is added onto the start). → Promise<AudioBuffer | null>.
 */
export async function renderMoodLoop(ctx, mood, { steps = LOOP_STEPS, rate = LOOP_RATE } = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC || !ctx || typeof ctx.createBuffer !== 'function') return null;
  const dur = steps * STEP, frames = Math.ceil(dur * rate), total = Math.ceil((dur + TAIL) * rate);
  const off = new OAC(1, total, rate);
  const filter = off.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = moodCutoff(mood);
  filter.connect(off.destination);
  const st = { _seed: 7, _lastNote: null };
  for (let s = 0; s < steps; s++) scheduleStep(off, filter, mood, s, s * STEP + 0.0001, st);
  const rendered = await off.startRendering();
  const src = rendered.getChannelData(0);
  const out = ctx.createBuffer(1, frames, rate);
  const dst = out.getChannelData(0);
  dst.set(src.subarray(0, frames));
  for (let i = frames; i < total; i++) dst[i - frames] += src[i];
  return out;
}

export class JellyMusic {
  constructor() {
    this.ctx = null;
    this.out = null;
    this.filter = null;
    this.enabled = true;
    this.mood = 'off';
    this.prerender = true;   // false: always the live scheduler (tests / debugging)
    this._timer = 0;
    this._next = 0;          // context time of the next step (live fallback)
    this._step = 0;
    this._seed = 7;
    this._loops = new Map(); // mood → Promise<AudioBuffer | null>
    this._src = null;        // { node, gain, mood } of the playing loop
    this._t0 = 0;            // context time the loop position is measured from
    this._live = false;      // the live scheduler is running instead of a loop
  }

  /** Hook up to a running AudioContext (JellyAudio calls this once the context exists). */
  attach(ctx) {
    if (!ctx || this.ctx === ctx) return;
    this.ctx = ctx;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 2400;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.filter.connect(this.out);
    this.out.connect(ctx.destination);
    this._apply(true);
  }

  setEnabled(on) { this.enabled = !!on; this._apply(); }

  /** 'menu' | 'play' | 'hard' | 'off' */
  setMood(mood) {
    const m = MOODS.includes(mood) ? mood : 'play';
    if (m === this.mood) return;
    this.mood = m;
    this._apply();
  }

  /** A short dip under a signature sound (squeeze pop, unlock sting). */
  duck(db = 4, seconds = 0.45) {
    const g = this.out && this.out.gain;
    if (!g || !this._on()) return;
    const t = this.ctx.currentTime, lvl = this._level();
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(lvl * Math.pow(10, -db / 20), t + 0.04);
    g.setTargetAtTime(lvl, t + seconds, 0.25);
  }

  _on() { return this.enabled && this.mood !== 'off' && !!this.ctx; }
  _level() { return this.mood === 'menu' ? MUSIC_LEVEL * 0.8 : MUSIC_LEVEL; }

  _apply(immediate = false) {
    if (!this.ctx || !this.out) return;
    const on = this._on();
    const t = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(t);
    if (immediate) g.value = on ? this._level() : 0;
    else g.setTargetAtTime(on ? this._level() : 0, t, on ? 0.6 : 0.25);
    this.filter.frequency.setTargetAtTime(moodCutoff(this.mood), t, 0.4);
    if (!on) { this._stopSources(t + 1.5); this._stopLive(); return; }
    if (this.prerender && !this._live) this._playLoop(this.mood);
    else this._startLive();
  }

  // --- pre-rendered loops ---------------------------------------------------------------------

  _loop(mood) {
    let p = this._loops.get(mood);
    if (!p) {
      p = renderMoodLoop(this.ctx, mood).catch(() => null);
      this._loops.set(mood, p);
      while (this._loops.size > MAX_CACHED) {
        const old = [...this._loops.keys()].find((k) => k !== mood && k !== this._src?.mood);
        if (old == null) break;
        this._loops.delete(old);
      }
    }
    return p;
  }

  _playLoop(mood) {
    if (this._src && this._src.mood === mood && !this._src.stopping) return;
    const want = mood;
    this._loop(mood).then((buf) => {
      if (!this._on() || this.mood !== want || !this.ctx) return;
      if (!buf) { this._live = true; this._apply(); return; } // no OfflineAudioContext: live bed
      if (this._src && this._src.mood === want && !this._src.stopping) return;
      const ctx = this.ctx, t = ctx.currentTime, len = buf.duration;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.loop = true;
      const gain = ctx.createGain();
      node.connect(gain); gain.connect(this.out);
      // Crossfade from the playing loop at the same position in the chord cycle.
      const fresh = !this._src;
      if (fresh) this._t0 = t;
      const offset = ((t - this._t0) % len + len) % len;
      gain.gain.setValueAtTime(fresh ? 1 : 0, t);
      if (!fresh) gain.gain.linearRampToValueAtTime(1, t + XFADE);
      node.start(t, offset);
      this._stopSources(t + XFADE);
      this._src = { node, gain, mood: want };
      // The level bed is the next one needed: render it now, while the menu plays.
      if (want === 'menu') this._loop('play');
    });
  }

  /** Fade out and stop every playing loop at context time `at`. */
  _stopSources(at) {
    const s = this._src;
    if (!s) return;
    this._src = null;
    s.stopping = true;
    const t = this.ctx.currentTime;
    try {
      s.gain.gain.cancelScheduledValues(t);
      s.gain.gain.setValueAtTime(s.gain.gain.value, t);
      s.gain.gain.linearRampToValueAtTime(0, Math.max(t + 0.05, at));
      s.node.stop(Math.max(t + 0.06, at + 0.02));
      s.node.onended = () => { try { s.node.disconnect(); s.gain.disconnect(); } catch { /* gone */ } };
    } catch { /* already stopped */ }
  }

  // --- live fallback ------------------------------------------------------------------------

  _startLive() {
    if (this._timer) return;
    this._next = this.ctx.currentTime + 0.1;
    this._timer = setInterval(() => this._pump(), 50);
  }

  _stopLive() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = 0;
  }

  _rand() { return nextRand(this); }

  _pump() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') { if (ctx) this._next = Math.max(this._next, ctx.currentTime + 0.05); return; }
    if (this._next < ctx.currentTime - 0.5) this._next = ctx.currentTime + 0.05; // after a suspend
    while (this._next < ctx.currentTime + LOOK) {
      scheduleStep(ctx, this.filter, this.mood, this._step, this._next, this);
      this._step = (this._step + 1) % (8 * CHORDS.length * 2);
      this._next += STEP;
    }
  }

  destroy() {
    this._stopLive();
    if (this.ctx) this._stopSources(this.ctx.currentTime);
    try { this.out?.disconnect(); } catch { /* gone */ }
  }
}
