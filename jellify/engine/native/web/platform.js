// Jellify Anything's stand-in for the game's native/web/platform.js (NOT synced from the repo; owned
// by site/jellify). The engine's segment.js asks `plugin('SubjectCutout')` for an on-device subject
// cutout; in the app that is Apple Vision / ML Kit. Here it is MediaPipe MagicTouch running in the
// browser (../../../cutout-ai.js), behind the very same contract:
//   cutout({ image: <JPEG data URL> }) → { mask: <PNG data URL whose alpha is the subject mask> }
// Everything stays in this tab: data URLs and canvases only, no network.
import { cutoutMask, prepareAI } from '../../../cutout-ai.js';

let nextPoint = null;

/** The object the user tapped (0..1 of the photo) for the next cutout only; null = automatic. */
export function setCutoutPoint(p) { nextPoint = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null; }

function decode(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('mask input could not be decoded'));
    img.src = dataUrl;
  });
}

const SubjectCutout = {
  prepare: () => prepareAI(),
  async cutout({ image }) {
    const point = nextPoint;
    nextPoint = null;
    const img = await decode(image);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const alpha = await cutoutMask(c, point);
    if (!alpha) return null;
    const px = g.createImageData(c.width, c.height);
    for (let i = 0; i < alpha.length; i++) { px.data[i * 4 + 3] = alpha[i]; }
    g.putImageData(px, 0, 0);
    return { mask: c.toDataURL('image/png') };
  },
};

export const isNative = () => false;
export const platform = () => 'web';
export const hasPlugin = (name) => name === 'SubjectCutout';
export function plugin(name) { return name === 'SubjectCutout' ? SubjectCutout : null; }
export function hideSplash() {}
