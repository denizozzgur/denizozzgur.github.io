// Jellify Anything: vertical 1080×1920 clip of the live stage, recorded on this device.
//
// Every stage frame the layers (backdrop, gel, juice) are composited at the clip size into one
// canvas with a small "Squeeze Out!" watermark, plus the end card ("Squish more in Squeeze Out!" +
// store badges) for the last ~1.8 s. The canvas is captured with captureStream(30) together with the
// engine's own sound (a tap on the audio master bus) and encoded by MediaRecorder: MP4 (H.264/AAC)
// where the browser can (Safari, Chrome 126+), else WebM. No MediaRecorder at all → a 1080×1920 PNG
// still with the same watermark and end-card strip (`snapshot`).
import { APP_STORE_URL, APP_STORE_LIVE, PLAY_URL, PAGE_URL } from './config.js';

export const CLIP_W = 1080;
export const CLIP_H = 1920;
const FPS = 30;
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.4D401F,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
}

export function canRecord() {
  const c = document.createElement('canvas');
  return typeof MediaRecorder !== 'undefined' && typeof c.captureStream === 'function' && !!pickMime();
}

const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function rrect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
}

export class ClipMaker {
  constructor(stage) {
    this.stage = stage;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CLIP_W; this.canvas.height = CLIP_H;
    this.canvas.className = 'jf-rec-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.g = this.canvas.getContext('2d', { alpha: false });
    this.assets = null;
    this.recording = false;
    this.endCardAt = Infinity;   // seconds into the clip when the end card starts
    this.t0 = 0;
    this._audioDest = null;
    this._tapped = false;
  }

  async loadAssets() {
    if (this.assets) return this.assets;
    const [logo, icon] = await Promise.all([loadImage('/assets/logo.png'), loadImage('/assets/icon-512.png')]);
    try { await Promise.all([document.fonts.load('700 64px Fredoka'), document.fonts.load('800 40px Nunito')]); } catch { /* system font */ }
    this.assets = { logo, icon };
    return this.assets;
  }

  get elapsed() { return this.recording ? (performance.now() - this.t0) / 1000 : 0; }

  /** Composite the current stage frame (call right after the stage rendered, same task). */
  compose(endT = -1) {
    const s = this.stage, g = this.g;
    const kx = CLIP_W / s.W, ky = CLIP_H / s.H;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#fde8dc';
    g.fillRect(0, 0, CLIP_W, CLIP_H);
    g.setTransform(kx, 0, 0, ky, s.shake.x * kx, s.shake.y * ky);
    g.drawImage(s.bg, 0, 0, s.W, s.H);
    g.drawImage(s.glCanvas, 0, 0, s.W, s.floorY);
    g.drawImage(s.fxCanvas, 0, 0, s.W, s.H);
    g.setTransform(1, 0, 0, 1, 0, 0);
    this.watermark(endT >= 0 ? Math.max(0, 1 - endT / 0.3) : 1);
    if (endT >= 0) this.endCard(endT);
  }

  watermark(alpha) {
    const g = this.g, { logo } = this.assets || {};
    if (alpha <= 0) return;
    g.save();
    g.globalAlpha = 0.92 * alpha;
    if (logo) {
      const w = 250, h = (w * logo.height) / logo.width;
      g.shadowColor = 'rgba(80,30,20,0.25)'; g.shadowBlur = 14; g.shadowOffsetY = 4;
      g.drawImage(logo, 54, 96, w, h);
    } else {
      g.font = '700 54px Fredoka, Nunito, sans-serif';
      g.fillStyle = '#ff7a1a';
      g.fillText('Squeeze Out!', 56, 150);
    }
    g.restore();
  }

  /** End card at `t` seconds since it began. */
  endCard(t) {
    const g = this.g, { logo, icon } = this.assets || {};
    const p = ease(t / 0.45);
    g.save();
    // Dim the scene into the brand plum, then slide the card up.
    g.fillStyle = `rgba(43,24,56,${0.86 * p})`;
    g.fillRect(0, 0, CLIP_W, CLIP_H);
    g.translate(0, (1 - p) * 220);
    g.globalAlpha = p;
    const cx = CLIP_W / 2;
    if (icon) {
      const s = 300, x = cx - s / 2, y = 330;
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 40; g.shadowOffsetY = 14;
      rrect(g, x, y, s, s, 68); g.fillStyle = '#fff'; g.fill();
      g.shadowColor = 'transparent';
      rrect(g, x, y, s, s, 68); g.clip();
      g.drawImage(icon, x, y, s, s);
      g.restore();
    }
    g.textAlign = 'center';
    g.fillStyle = '#fff7ec';
    g.font = '800 64px Nunito, system-ui, sans-serif';
    g.fillText('Squish more in', cx, 760);
    if (logo) {
      const w = 820, h = (w * logo.height) / logo.width;
      g.drawImage(logo, cx - w / 2, 790, w, h);
    } else {
      g.font = '700 120px Fredoka, sans-serif';
      g.fillStyle = '#ffa53a';
      g.fillText('Squeeze Out!', cx, 960);
    }
    // Store badges (generic glyphs, same style as the site).
    const bw = 620, bh = 150, bx = cx - bw / 2;
    const badge = (y, small, big, glyph) => {
      g.save();
      rrect(g, bx, y, bw, bh, 34);
      g.fillStyle = '#0d0d10'; g.fill();
      g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.35)'; g.stroke();
      g.translate(bx + 92, y + bh / 2);
      g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 7; g.lineJoin = 'round';
      glyph(g);
      g.restore();
      g.save();
      g.textAlign = 'left'; g.fillStyle = '#fff';
      g.font = '800 30px Nunito, sans-serif'; g.globalAlpha *= 0.85;
      g.fillText(small, bx + 160, y + 62);
      g.globalAlpha /= 0.85;
      g.font = '600 52px Fredoka, sans-serif';
      g.fillText(big, bx + 158, y + 116);
      g.restore();
    };
    badge(1270, 'GET IT ON', 'Google Play', (c) => { c.beginPath(); c.moveTo(-26, -40); c.lineTo(-26, 40); c.lineTo(38, 0); c.closePath(); c.stroke(); });
    badge(1450, APP_STORE_LIVE ? 'Download on the' : 'Coming soon on the', 'App Store', (c) => {
      rrect(c, -24, -44, 48, 88, 12); c.stroke(); c.beginPath(); c.arc(0, 28, 5, 0, Math.PI * 2); c.fill();
    });
    g.fillStyle = 'rgba(255,247,236,0.8)';
    g.font = '800 34px Nunito, sans-serif';
    g.fillText('Jellify your own photo: ' + PAGE_URL.replace(/^https?:\/\//, '').replace(/\/$/, ''), cx, 1720);
    g.restore();
  }

  _audioTrack() {
    const a = this.stage.audio;
    const ctx = a && a.ctx;
    const src = a && (a.recordSource || a._bus?.master);
    if (!ctx || !src || typeof ctx.createMediaStreamDestination !== 'function') return null;
    try {
      if (!this._audioDest) this._audioDest = ctx.createMediaStreamDestination();
      if (!this._tapped) { src.connect(this._audioDest); this._tapped = true; }
      return this._audioDest.stream.getAudioTracks()[0] || null;
    } catch { return null; }
  }

  /**
   * Record `action` seconds of the live stage, then `endCard` seconds of end card.
   * director(t) is called every frame with the clip time (to script pokes); onTick(t, total) for UI.
   * → Promise<{ blob, url, mime, ext, duration }>
   */
  async record({ action = 6, endCard = 1.8, director = null, onTick = null } = {}) {
    if (this.recording) throw new Error('already recording');
    await this.loadAssets();
    const s = this.stage;
    const total = action + endCard;
    let mime = pickMime();
    if (!mime) throw new Error('recording not supported');
    if (!this.canvas.isConnected) document.body.appendChild(this.canvas);
    s.setPixelScale(CLIP_W / s.W); // render the gel at the clip's resolution
    s.recording = true;
    this.compose();
    const stream = this.canvas.captureStream(FPS);
    const audio = this._audioTrack();
    if (audio) stream.addTrack(audio);
    else mime = mime.replace(/,(mp4a\.40\.2|opus)/, '');
    let rec;
    const opts = { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 128_000 };
    try { rec = new MediaRecorder(stream, opts); } catch {
      try { rec = new MediaRecorder(stream); } catch (err) { this._cleanup(stream); throw err; }
    }
    const chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    const done = new Promise((resolve, reject) => {
      rec.onstop = () => resolve();
      rec.onerror = (ev) => reject(ev.error || new Error('recording failed'));
    });
    this.recording = true;
    this.t0 = performance.now();
    s.onFrame = () => {
      const t = this.elapsed;
      director?.(t);
      this.compose(t >= action ? t - action : -1);
      onTick?.(Math.min(t, total), total);
    };
    rec.start(250);
    s.wake();
    await new Promise((resolve) => {
      const check = () => { if (this.elapsed >= total) resolve(); else setTimeout(check, 50); };
      check();
    });
    try { rec.requestData?.(); } catch { /* fine */ }
    rec.stop();
    try { await done; } finally { this._cleanup(stream); }
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    return { blob, url: URL.createObjectURL(blob), mime: rec.mimeType || mime, ext: /mp4/.test(type) ? 'mp4' : 'webm', duration: total };
  }

  _cleanup(stream) {
    const s = this.stage;
    s.onFrame = null;
    s.recording = false;
    this.recording = false;
    for (const t of stream.getVideoTracks()) t.stop();
    s.setPixelScale(0);
    s.wake();
  }

  /** A 1080×1920 PNG still (browsers without MediaRecorder): the frame + a "Squish more" strip. */
  async snapshot() {
    await this.loadAssets();
    const s = this.stage;
    s.setPixelScale(CLIP_W / s.W);
    s.tick(1 / 60);
    this.compose();
    s.setPixelScale(0);
    const g = this.g, { logo } = this.assets;
    g.save();
    const y = CLIP_H - 300;
    const grad = g.createLinearGradient(0, y - 60, 0, CLIP_H);
    grad.addColorStop(0, 'rgba(43,24,56,0)'); grad.addColorStop(0.35, 'rgba(43,24,56,0.82)'); grad.addColorStop(1, 'rgba(43,24,56,0.92)');
    g.fillStyle = grad; g.fillRect(0, y - 60, CLIP_W, 360);
    g.textAlign = 'center'; g.fillStyle = '#fff7ec';
    g.font = '800 46px Nunito, sans-serif';
    g.fillText('Squish more in', CLIP_W / 2, y + 70);
    if (logo) { const w = 460, h = (w * logo.height) / logo.width; g.drawImage(logo, CLIP_W / 2 - w / 2, y + 90, w, h); }
    g.font = '800 30px Nunito, sans-serif'; g.globalAlpha = 0.85;
    g.fillText('Free on Google Play · ' + PAGE_URL.replace(/^https?:\/\//, '').replace(/\/$/, ''), CLIP_W / 2, CLIP_H - 40);
    g.restore();
    const blob = await new Promise((r) => this.canvas.toBlob(r, 'image/png'));
    return { blob, url: URL.createObjectURL(blob), mime: 'image/png', ext: 'png', duration: 0 };
  }
}

export { APP_STORE_URL, PLAY_URL };
