// Shared material presets. Read by physics (feel), render (look) and audio (sound).
// All scalar fields are 0..1 unless noted.
//   softness  – 0 = firm gummy, 1 = barely holds its shape
//   wobble    – 0 = heavily damped, 1 = rings like a bell
//   juiciness – wet/splashy sounds, juice droplets, gloss
//   seeds     – tiny crunchy seed clicks in the sound (kiwi, strawberry…)
//   pitch     – audio pitch multiplier (0.5..2)
//   gloss     – specular strength of the gel surface
//   tint      – [r,g,b] 0..1 colour of the clear gel rim / juice / shadows

export const MATERIALS = {
  jelly: {
    id: 'jelly', label: 'Jelly',
    softness: 0.6, wobble: 0.7, juiciness: 0.5, seeds: 0, pitch: 1.0, gloss: 0.8,
    tint: [0.95, 0.45, 0.55],
  },
  kiwi: {
    id: 'kiwi', label: 'Kiwi',
    softness: 0.55, wobble: 0.65, juiciness: 0.9, seeds: 0.8, pitch: 0.95, gloss: 0.85,
    tint: [0.45, 0.75, 0.15],
  },
  strawberry: {
    id: 'strawberry', label: 'Strawberry',
    softness: 0.5, wobble: 0.6, juiciness: 0.8, seeds: 0.5, pitch: 1.1, gloss: 0.85,
    tint: [0.9, 0.15, 0.2],
  },
  orange: {
    id: 'orange', label: 'Orange',
    softness: 0.45, wobble: 0.55, juiciness: 1.0, seeds: 0.1, pitch: 1.0, gloss: 0.8,
    tint: [1.0, 0.55, 0.1],
  },
  watermelon: {
    id: 'watermelon', label: 'Watermelon',
    softness: 0.5, wobble: 0.6, juiciness: 1.0, seeds: 0.4, pitch: 0.85, gloss: 0.8,
    tint: [0.95, 0.3, 0.35],
  },
  gummy: {
    id: 'gummy', label: 'Gummy bear',
    softness: 0.35, wobble: 0.8, juiciness: 0.2, seeds: 0, pitch: 1.25, gloss: 1.0,
    tint: [1.0, 0.8, 0.1],
  },
};

export function materialFor(id, overrides = {}) {
  const base = MATERIALS[id] || MATERIALS.jelly;
  return { ...base, tint: [...base.tint], ...overrides };
}

// Pick a preset for an uploaded photo from its average colour (r,g,b 0..255).
// Returns a material whose tint is the photo's own colour.
export function guessMaterialFromColor(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  let h = 0;
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min)) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h *= 60; if (h < 0) h += 360;
  }
  let id = 'jelly';
  if (sat > 0.25) {
    if (h >= 65 && h < 160) id = 'kiwi';
    else if (h >= 20 && h < 50) id = 'orange';
    else if (h < 15 || h >= 340) id = 'strawberry';
  }
  const tint = [r / 255, g / 255, b / 255].map(v => Math.min(1, v * 1.15 + 0.05));
  // photo: true → the renderer colours the gel border from the photo itself (src/render.js).
  // juice: splash droplets are clear gel (a cool, almost colourless drop) with only a hint of the
  // photo's colour: its average colour is often a muddy grey-brown (a black-and-white dog), and
  // half of it made the droplets read as grey pebbles.
  const CLEAR = [0.86, 0.94, 1.0];
  const juice = tint.map((v, i) => 0.82 * CLEAR[i] + 0.18 * v);
  return materialFor(id, { tint, photo: true, juice });
}
