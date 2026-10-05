// Jellify Anything — page controller. Small on purpose: the engine (stage.js → engine/src/*) is loaded
// right after first paint, and the AI cutout (cutout-ai.js → vendor/, ~9 MB gzipped) only when the
// visitor asks to jellify a photo. No analytics, no cookies, no network besides these same-origin
// files; photos are decoded in the tab (ImageBitmap / object URLs) and never leave it.
import { APP_STORE_URL, APP_STORE_LIVE, PLAY_URL } from './config.js';

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $('stage'), hint: $('hint'), busy: $('busy'), busyLabel: $('busyLabel'), busyBar: $('busyBar'), busyNote: $('busyNote'),
  fatal: $('fatal'), pick: $('pick'), pickImg: $('pickImg'), pickCancel: $('pickCancel'), pickBtn: $('pickBtn'),
  photoBtn: $('photoBtn'), file: $('file'), samples: $('samples'),
  clipBtn: $('clipBtn'), clipLabel: $('clipLabel'), dropBtn: $('dropBtn'), pokeBtn: $('pokeBtn'), soundBtn: $('soundBtn'),
  recBadge: $('recBadge'), recTime: $('recTime'),
  result: $('result'), resultClose: $('resultClose'), resultTitle: $('resultTitle'), preview: $('preview'),
  shareBtn: $('shareBtn'), saveBtn: $('saveBtn'), resultNote: $('resultNote'),
  iosBadge: $('iosBadge'), playBadge: $('playBadge'),
};

const ACTION_S = 6;      // live action in a clip …
const END_CARD_S = 1.8;  // … then the end card (7.8 s total)

const state = {
  stage: null, clips: null, ai: null,
  photo: null,          // the last photo File (kept in memory only, for "tap it yourself")
  photoUrl: '',
  busy: false, recording: false,
  lastResult: null,
  canRecord: false,
};

// ---------------------------------------------------------------------------------------------
// Store badge (App Store: "coming soon" until launch, see config.js)

if (APP_STORE_LIVE) {
  ui.iosBadge.href = APP_STORE_URL;
  ui.iosBadge.removeAttribute('aria-disabled');
  ui.iosBadge.title = 'Download on the App Store';
  ui.iosBadge.rel = 'noopener';
  ui.iosBadge.target = '_blank';
  ui.iosBadge.querySelector('small').textContent = 'Download on the';
} else {
  ui.iosBadge.addEventListener('click', (e) => e.preventDefault());
}
ui.playBadge.href = PLAY_URL;

// ---------------------------------------------------------------------------------------------
// UI helpers

function setBusy(label, fraction = null, note = 'Happens right here on your device.') {
  ui.busy.hidden = false;
  ui.busyLabel.textContent = label;
  ui.busyNote.textContent = note;
  const bar = ui.busyBar.parentElement;
  bar.classList.toggle('indeterminate', fraction == null);
  if (fraction != null) ui.busyBar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}
function clearBusy() { ui.busy.hidden = true; }

function lockControls(on) {
  for (const b of [ui.photoBtn, ui.dropBtn, ui.pokeBtn, ...ui.samples.querySelectorAll('button')]) b.disabled = on;
  ui.clipBtn.disabled = on && !state.recording;
  ui.pickBtn.disabled = on;
}

function fatal(msg) {
  ui.fatal.hidden = false;
  ui.fatal.textContent = msg;
  lockControls(true);
  ui.clipBtn.disabled = true;
}

/** Bring the whole stage on screen (picking, recording). */
function showStage() {
  const r = ui.stage.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) ui.stage.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function dismissHint() { ui.hint.classList.add('gone'); }

function markSample(id) {
  for (const b of ui.samples.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
}

// ---------------------------------------------------------------------------------------------
// Boot: engine after first paint

async function boot() {
  let mod;
  try {
    mod = await import('./stage.js');
  } catch (err) {
    console.warn('[jellify] engine failed to load:', err);
    fatal('The jelly engine could not load. Please reload the page.');
    return;
  }
  try {
    state.stage = new mod.JellyStage(ui.stage);
  } catch (err) {
    fatal('This browser can\'t run the jelly engine (it needs WebGL2). Try a recent Safari, Chrome, Edge or Firefox.');
    return;
  }
  const S = state.stage;
  S.onInteract = dismissHint;
  for (const s of mod.SAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jf-chip';
    b.dataset.id = s.id;
    b.setAttribute('aria-pressed', 'false');
    b.title = s.label;
    b.setAttribute('aria-label', s.label);
    b.innerHTML = `<span class="e" aria-hidden="true">${s.emoji}</span><span class="l">${s.label}</span>`;
    b.addEventListener('click', () => showSample(s.id));
    ui.samples.appendChild(b);
  }
  ui.dropBtn.disabled = ui.pokeBtn.disabled = false;
  const rec = await import('./recorder.js');
  state.clips = new rec.ClipMaker(S);
  state.canRecord = rec.canRecord();
  ui.clipLabel.textContent = state.canRecord ? 'Make a clip' : 'Save a picture';
  ui.clipBtn.disabled = false;
  // First impression: a kiwi drops in, no upload needed.
  const first = new URLSearchParams(location.search).get('sample');
  showSample(mod.SAMPLES.some((s) => s.id === first) ? first : 'kiwi');
  window.jellify = api();
  document.documentElement.dataset.jellify = 'ready';
}

function showSample(id) {
  if (state.busy || state.recording) return;
  state.stage.show(state.stage.sampleSpec(id));
  markSample(id);
}

// ---------------------------------------------------------------------------------------------
// Photos (never leave the device)

async function ai() {
  if (!state.ai) state.ai = await import('./cutout-ai.js');
  return state.ai;
}

ui.photoBtn.addEventListener('click', () => {
  if (state.busy || state.recording) return;
  // The visitor wants to jellify a photo: start fetching the cutout model while they pick one.
  ai().then((m) => m.prepareAI()).catch(() => {});
  ui.file.value = '';
  ui.file.click();
});

ui.file.addEventListener('change', () => {
  const f = ui.file.files && ui.file.files[0];
  if (f) jellifyPhoto(f);
});

// Drag & drop a photo onto the stage (desktop).
ui.stage.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
ui.stage.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type));
  if (!f) return;
  e.preventDefault();
  ai().then((m) => m.prepareAI()).catch(() => {});
  jellifyPhoto(f);
});

async function jellifyPhoto(file, point = null) {
  if (!state.stage || state.busy || state.recording) return null;
  if (!/^image\//.test(file.type || 'image/')) { setBusy('That file is not a picture'); setTimeout(clearBusy, 1600); return null; }
  state.busy = true;
  lockControls(true);
  dismissHint();
  let unsub = null;
  try {
    const m = await ai();
    if (m.aiState() !== 'ready' && m.aiSupported()) {
      unsub = m.onProgress((p) => {
        if (m.aiState() === 'loading') setBusy('Getting the jelly maker ready…', p, 'One-time download (about 9 MB). Your photo stays on your device.');
      });
      await m.prepareAI();
      unsub(); unsub = null;
    }
    setBusy('Removing background…', null);
    const spec = await state.stage.photoSpec(file, {
      point,
      onProgress: (label) => setBusy(label === 'Making jelly…' ? 'Making jelly…' : 'Removing background…', null),
    });
    if (state.photoUrl && state.photo !== file) { URL.revokeObjectURL(state.photoUrl); state.photoUrl = ''; }
    state.photo = file;
    state.stage.show(spec);
    markSample(null);
    ui.pickBtn.hidden = false;
    return spec;
  } catch (err) {
    console.warn('[jellify] photo failed:', err?.message || err);
    setBusy('That photo could not be opened. Try another one?', 0, 'HEIC from some Android phones may not open in the browser. A JPG or PNG works.');
    await new Promise((r) => setTimeout(r, 2200));
    return null;
  } finally {
    unsub?.();
    clearBusy();
    state.busy = false;
    lockControls(false);
  }
}

// Overlays inside the stage are not the jelly: keep their pointers away from the stage's input
// (it captures the pointer, which would retarget the click to the stage).
for (const el of [ui.soundBtn, ui.pick, ui.busy, ui.fatal]) el.addEventListener('pointerdown', (e) => e.stopPropagation());

// "Wrong part? Tap it yourself": show the photo, tap the object, cut out what's under the finger.
ui.pickBtn.addEventListener('click', () => {
  if (!state.photo || state.busy || state.recording) return;
  if (!state.photoUrl) state.photoUrl = URL.createObjectURL(state.photo);
  ui.pickImg.src = state.photoUrl;
  ui.pick.hidden = false;
  showStage();
});
ui.pickCancel.addEventListener('click', (e) => { e.stopPropagation(); ui.pick.hidden = true; });
ui.pickImg.addEventListener('click', (e) => {
  const r = ui.pickImg.getBoundingClientRect();
  // object-fit: contain → the picture's own box inside the element.
  const iw = ui.pickImg.naturalWidth, ih = ui.pickImg.naturalHeight;
  const s = Math.min(r.width / iw, r.height / ih);
  const w = iw * s, h = ih * s, ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
  const x = (e.clientX - ox) / w, y = (e.clientY - oy) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  ui.pick.hidden = true;
  jellifyPhoto(state.photo, { x, y });
});

// ---------------------------------------------------------------------------------------------
// Play buttons

ui.dropBtn.addEventListener('click', () => { state.stage?.drop(); dismissHint(); });
ui.pokeBtn.addEventListener('click', () => { state.stage?.autoPoke(Math.random() < 0.5 ? 'poke' : 'swipe'); dismissHint(); });
ui.soundBtn.addEventListener('click', () => {
  const S = state.stage;
  if (!S) return;
  S.audio.enabled = !S.audio.enabled;
  ui.soundBtn.setAttribute('aria-pressed', String(S.audio.enabled));
});

// ---------------------------------------------------------------------------------------------
// Clip / picture

ui.clipBtn.addEventListener('click', () => {
  if (!state.stage || state.busy) return;
  if (state.recording) return;
  if (state.canRecord) makeClip(); else makePicture();
});

/** Scripted pokes so every clip has action, unless the visitor is playing with it themselves. */
function director() {
  const S = state.stage;
  const beats = [{ t: 0.05, act: 'drop' }, { t: 2.3, act: 'poke' }, { t: 3.5, act: 'swipe' }, { t: 4.7, act: 'poke' }];
  let i = 0;
  return (t) => {
    while (i < beats.length && t >= beats[i].t) {
      const b = beats[i++];
      if (b.act === 'drop') { S.drop({ vy: 320 }); continue; }
      if (performance.now() - S.lastInput > 900 && t < ACTION_S - 0.4) S.autoPoke(b.act);
    }
  };
}

async function makeClip() {
  const S = state.stage;
  S.audio.unlock(); // inside the tap: the clip gets the engine's sound
  showStage();
  state.recording = true;
  lockControls(true);
  ui.clipBtn.disabled = true;
  ui.clipBtn.classList.add('is-rec');
  ui.clipLabel.textContent = 'Recording…';
  ui.recBadge.hidden = false;
  dismissHint();
  let clip = null;
  try {
    clip = await state.clips.record({
      action: ACTION_S, endCard: END_CARD_S, director: director(),
      onTick: (t, total) => { ui.recTime.textContent = Math.max(0, total - t).toFixed(1); },
    });
  } catch (err) {
    console.warn('[jellify] recording failed, saving a picture instead:', err?.message || err);
  } finally {
    state.recording = false;
    ui.recBadge.hidden = true;
    ui.clipBtn.classList.remove('is-rec');
    ui.clipLabel.textContent = state.canRecord ? 'Make a clip' : 'Save a picture';
    lockControls(false);
  }
  if (!clip || !clip.blob.size) { await makePicture(); return; }
  showResult(clip);
}

async function makePicture() {
  const pic = await state.clips.snapshot();
  showResult(pic);
}

function fileName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `squeeze-out-jelly-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

function showResult(res) {
  if (state.lastResult) URL.revokeObjectURL(state.lastResult.url);
  state.lastResult = res;
  const isVideo = res.ext !== 'png';
  const name = fileName(res.ext);
  res.file = typeof File === 'function' ? new File([res.blob], name, { type: res.blob.type }) : null;
  ui.resultTitle.textContent = isVideo ? 'Your jelly clip' : 'Your jelly picture';
  ui.preview.textContent = '';
  const el = document.createElement(isVideo ? 'video' : 'img');
  if (isVideo) {
    Object.assign(el, { src: res.url, muted: true, loop: true, autoplay: true, playsInline: true, controls: true });
    el.setAttribute('playsinline', '');
    el.setAttribute('muted', '');
  } else {
    el.src = res.url;
    el.alt = 'Your jelly picture';
  }
  ui.preview.appendChild(el);
  if (isVideo) el.play?.().catch(() => {});
  ui.saveBtn.href = res.url;
  ui.saveBtn.download = name;
  const canShare = !!(res.file && navigator.canShare && (() => { try { return navigator.canShare({ files: [res.file] }); } catch { return false; } })());
  ui.shareBtn.hidden = !canShare;
  ui.saveBtn.classList.toggle('jf-ghost', canShare);
  ui.resultNote.textContent = isVideo
    ? `${res.ext.toUpperCase()} · 1080×1920 · ${res.duration.toFixed(1)} s. Made on your device, nothing was uploaded.`
    : 'This browser can\'t record video, so here is a 1080×1920 picture. Made on your device.';
  ui.result.hidden = false;
  ui.resultClose.focus();
}

ui.shareBtn.addEventListener('click', async () => {
  const res = state.lastResult;
  if (!res?.file) return;
  try {
    await navigator.share({ files: [res.file], title: 'My jelly', text: 'I turned my photo into jelly! Squish more in Squeeze Out!' });
  } catch (err) {
    if (err?.name !== 'AbortError') ui.saveBtn.click(); // share sheet unavailable: download instead
  }
});

function closeResult() {
  ui.result.hidden = true;
  ui.preview.querySelector('video')?.pause();
  ui.clipBtn.focus();
}
ui.resultClose.addEventListener('click', closeResult);
ui.result.addEventListener('click', (e) => { if (e.target === ui.result) closeResult(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!ui.result.hidden) closeResult();
  else if (!ui.pick.hidden) ui.pick.hidden = true;
});

// ---------------------------------------------------------------------------------------------
// Test / debug hook (no data leaves the page)

function api() {
  const S = state.stage;
  return {
    stage: S,
    get state() { return { busy: state.busy, recording: state.recording, hero: !!S.hero, kind: S.spec?.kind, method: S.spec?.cutout?.method, canRecord: state.canRecord }; },
    sample: (id) => showSample(id),
    photo: (file, point) => jellifyPhoto(file, point),
    clip: () => makeClip(),
    picture: () => makePicture(),
    get result() { return state.lastResult; },
    closeResult,
    advance: (seconds, fps = 60) => { for (let k = Math.round(seconds * fps); k > 0; k--) S.tick(1 / fps); },
  };
}

const start = () => boot().catch((err) => { console.warn('[jellify] boot failed:', err); fatal('Something went wrong. Please reload the page.'); });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
