// WebGL2 jelly renderer.
//
// Every JellyBody is drawn as its deforming triangle mesh, textured with the photo
// cutout and shaded as if the object were cast in glossy gelatin:
//   - a dome-shaped height field h = H·sqrt(1-(1-depth)²) gives the gel its volume;
//     its gradient is rebuilt on the CPU each frame from the *deformed* triangles, so
//     highlights slide and stretch with the wobble (no dFdx faceting),
//   - the photo is seen through the dome (interior slightly magnified, rim softened),
//     colour-boosted, more translucent and tint-coloured near the edges, darker/saturated
//     where squashed and paler/clearer where stretched,
//   - key light from the upper-left: sharp Blinn-Phong glint, broad sheen, a fake studio
//     window reflection, fresnel rim and a caustic glow pooled on the far (lower-right) side,
//   - the dilated clear-gel border renders as translucent tinted gel.
// Shadows: a soft tinted silhouette offset down-right (it grows while a body is held, as if
// lifted toward the viewer) and a contact shadow on the floor (y = canvas CSS height).
// Options: renderer.floorShadow (false: no floor contact shadows, e.g. on a puzzle board),
// renderer.shadowOffset ([x, y] px fixed drop-shadow offset; null = automatic, by body size),
// renderer.setTexture(body, canvas) swaps a body's texture, and a material with `solid: true`
// renders as opaque glossy plastic (crisp silhouette from the texture alpha, flat top with a
// rounded bevel, no translucent gel border / rim, no refraction, a dense dark shadow).
// Additive options (Squeeze Out!): body.lift (number 0..1, overrides `grabbed` as the lift
// target), renderer.liftShadowOpacity (drop-shadow opacity at full lift; null = the default
// fade) and renderer.preloadTexture(canvas) (upload ahead of addBody with that canvas).
// Additive options (Free-mode personalities and finishes; all optional, defaults render exactly
// as before):
//   body.glow = [r,g,b]   emissive inner glow + a soft halo around the body (strength
//                         body.glowStrength, default 0.55; halo radius ≈ 1.4 × the body's extent)
//   body.finish           'glitter' | 'pearl' | 'glass' | 'gold' | 'rainbow' (render-only look)
//   body.eyes = [[u, v, ru, rv], …] (≤ 4, texture uv) + body.lid (0 open … 1 closed) and
//   body.eyeWide (0 … 1, eyes opened wide): eyelids drawn over the painted eyes
//   renderer.ambient      0..1 multiplier of the reflected light (Night Lights dims the room;
//                         emissive glow is not dimmed). Default 1.
// Photo jellies (material.photo, set by guessMaterialFromColor): one average tint turns a
// many-coloured photo's clear gel border, rim and edge line into a muddy grey band. For them the
// gel takes the colour of the photo right next to it instead (a coarse mip of the premultiplied
// texture = the alpha-weighted average of nearby object pixels), and the thin rim keeps its detail.
// A photo has no painted highlights, so its gloss is built in the shader: the picture sits under a
// flat, clear top (faces stay readable) with a narrow rounded bevel (photoSlope) that carries crisp
// window streaks, grazing glints, a sky sheen, a rim light and a subsurface glow in the photo's own
// hue; the picture's finest texture is softened a touch (light diffusing in the gel) and held just
// below paper white so the gloss reads on white fur too.

// Dome height as a fraction of the body's inradius (world px). Larger = rounder, steeper rim.
const DOME_HEIGHT = 0.75;
// Refraction strength: world px of apparent shift per unit of surface slope, per px of inradius.
const REFRACTION = 0.05;
const DEFAULT_TINT = [0.9, 0.5, 0.6];
// Solid (plastic) look: width of the rounded bevel along the outline, world px.
const SOLID_BEVEL = 11;

const BODY_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUv;
layout(location=2) in float aDepth;
layout(location=3) in vec2 aGrad;    // world-space gradient of depth (1/px)
layout(location=4) in vec2 aRefr;    // (du/dworld, dv/dworld) · aGrad  → uv shift direction
layout(location=5) in float aStrain;
uniform vec2 uView;
out vec2 vUv;
out float vDepth;
out vec2 vGrad;
out vec2 vRefr;
out float vStrain;
// The gel is near-incompressible, so area strain stays small (about -0.2 in a hard landing,
// +0.1 when yanked); amplify it so squash and stretch read in the colour.
const float STRAIN_GAIN = 2.5;
void main() {
  vUv = aUv; vDepth = aDepth; vGrad = aGrad; vRefr = aRefr; vStrain = aStrain * STRAIN_GAIN;
  vec2 clip = aPos / uView * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const BODY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vDepth;
in vec2 vGrad;
in vec2 vRefr;
in float vStrain;
uniform sampler2D uTex;
uniform vec3 uTint;
uniform float uGloss;
uniform float uHeight;   // dome height, world px
uniform float uRefract;  // refraction shift, world px per unit slope
uniform float uSolid;    // 1: opaque plastic (material.solid)
uniform float uBevel;    // solid: bevel width in depth units
uniform vec4 uGlow;      // emissive colour (rgb) and strength (a); 0 = none
uniform float uFinish;   // 0 none · 1 glitter · 2 pearl · 3 glass · 4 gold · 5 rainbow
uniform float uTime;     // s, animates glitter / rainbow
uniform float uPhoto;    // 1: photo cutout (local gel colour, see the header)
uniform float uAmbient;  // reflected-light multiplier (1 = normal)
uniform vec4 uEyes[4];   // painted eyes in texture uv: (u, v, radius u, radius v)
uniform float uEyeCount;
uniform float uLid;      // 0 open … 1 closed
uniform float uWide;     // 0 … 1 eyes opened wide
out vec4 outColor;

// y points down, z toward the viewer.
const vec3 KEY  = vec3(-0.46, -0.66, 0.60);   // normalized, upper-left
const vec3 KICK = vec3(0.62, 0.52, 0.59);     // faint lower-right kicker

// d/dd of sqrt(1-(1-d)^2): the dome's slope per unit depth (clamped at the rim).
float domeSlope(float d) {
  float q = 1.0 - clamp(d, 0.0, 1.0);
  return q * inversesqrt(max(1.0 - q * q, 0.03));
}

// Photo jellies are lit as a cast gel slab: an almost flat top (the picture, faces included, stays
// clean) with a rounded, glossy bevel along the outline. The bevel is PHOTO_BEVEL of the inradius
// wide but never more than PHOTO_BEVEL_PX (a head or a paw sticking out of a big jelly keeps its
// face clear of the edge gloss; thin parts are all bevel, so they read as round gel). Its slope
// comes from the deformed mesh like the dome's, so the edge streaks, glints and rim light slide and
// bunch up with every squash.
const float PHOTO_BEVEL = 0.28;
const float PHOTO_BEVEL_PX = 22.0;
const float PHOTO_BEVEL_K = 1.6;   // bevel steepness (1.0 = a quarter-round profile)
const float PHOTO_SOFTEN = 1.3;    // mip bias of the softened read of the picture
// World-space slope of a photo's surface edgePx from the outline (r = inradius, world px).
float photoBevelPx(float r) { return min(PHOTO_BEVEL * r, PHOTO_BEVEL_PX); }
float photoSlope(float d, float edgePx, float r) {
  return PHOTO_BEVEL_K * min(domeSlope(edgePx / photoBevelPx(r)), 5.0) + 0.16 * min(domeSlope(d * 0.6), 6.0);
}

float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Eyes opened wide: the painted eye is magnified a little (texture uv warp).
vec2 eyeWarp(vec2 uv) {
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uEyeCount) break;
    vec4 e = uEyes[i];
    vec2 p = (uv - e.xy) / e.zw;
    float k = uWide * 0.2 * (1.0 - smoothstep(0.85, 1.45, length(p)));
    uv = e.xy + (uv - e.xy) * (1.0 - k);
  }
  return uv;
}

// Eyelids: skin-coloured lids close from the top with a dark lash line; fully closed they
// leave a curved "sleeping" line.
vec3 eyeLids(vec3 obj, float bias) {
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uEyeCount) break;
    vec4 e = uEyes[i];
    vec2 p = (vUv - e.xy) / e.zw;
    float dist = length(p);
    if (dist > 1.25) continue;
    vec4 s = texture(uTex, e.xy - vec2(0.0, 1.75 * e.w), bias);
    if (s.a < 0.6) s = texture(uTex, e.xy + vec2(1.75 * e.z, 0.0), bias);
    vec3 skin = s.a > 0.003 ? s.rgb / s.a : uTint;
    float edge = mix(-1.3, 0.5, uLid) + 0.24 * (1.0 - p.x * p.x);
    float disc = 1.0 - smoothstep(0.96, 1.1, dist);
    float cover = smoothstep(edge + 0.05, edge - 0.05, p.y) * disc;
    vec3 lid = skin * (0.86 + 0.14 * smoothstep(edge, edge - 0.9, p.y));
    obj = mix(obj, lid, cover);
    float lash = (1.0 - smoothstep(0.025, 0.1, abs(p.y - edge))) * (1.0 - smoothstep(1.0, 1.2, dist));
    obj = mix(obj, skin * 0.28, lash * smoothstep(0.02, 0.15, uLid));
  }
  return obj;
}

vec3 hue3(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

float roundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Fake studio environment looked up by the reflected view ray: a big window up-left
// (crisp edges, a mullion cross), a faint skylight above.
// mullions = 0 gives a plain window, a touch softer (photos: dark bars would read as lines on the picture).
float environment(vec3 R, float mullions) {
  vec2 p = (R.xy - vec2(-0.50, -0.56)) / vec2(0.36, 0.29);
  float win = 1.0 - smoothstep(-0.04 - 0.08 * (1.0 - mullions), 0.06, roundBox(p, vec2(1.0), 0.4));
  float bars = smoothstep(0.035, 0.07, abs(p.x + 0.08)) * smoothstep(0.035, 0.07, abs(p.y - 0.04));
  win *= mix(mix(0.45, 1.0, bars), 1.0, 1.0 - mullions);
  float sky = smoothstep(0.35, -0.95, R.y) * 0.3;
  return win + sky;
}

// Photos: a smaller studio window with a bold mullion cross, so on the bevel it reads as a few
// separate crisp streaks on the lit shoulder, not a line traced around the whole outline.
float photoWindow(vec3 R) {
  vec2 p = (R.xy - vec2(-0.46, -0.6)) / vec2(0.3, 0.24);
  float win = 1.0 - smoothstep(-0.03, 0.04, roundBox(p, vec2(1.0), 0.35));
  float bars = smoothstep(0.07, 0.12, abs(p.x + 0.1)) * smoothstep(0.07, 0.12, abs(p.y - 0.05));
  return win * mix(0.12, 1.0, bars);
}

// Opaque glossy plastic: the texture's own silhouette (crisp), a gently pillowed top with a
// rounded bevel along the outline, hard specular highlights; no refraction / translucency /
// strain colour.
vec4 solidColor() {
  float d = vDepth;
  float b = 1.0 - smoothstep(0.0, uBevel, d);
  float pillow = 0.5 * min(domeSlope(d), 3.0);   // a slightly domed top catches the window
  vec2 gradH = uHeight * (2.4 * b * b + pillow) * vGrad;
  vec3 N = normalize(vec3(-gradH, 1.0));
  float tilt = 1.0 - N.z;
  float fres = tilt * tilt;
  float lit = dot(N.xy / max(length(N.xy), 1e-4), normalize(KEY.xy));

  vec4 tex = texture(uTex, vUv);
  float a = smoothstep(0.22, 0.78, tex.a);           // crisp edge (keeps ~1 px of anti-aliasing)
  vec3 obj = tex.a > 0.003 ? tex.rgb / tex.a : uTint;
  float luma = dot(obj, vec3(0.299, 0.587, 0.114));
  obj = clamp(mix(vec3(luma), obj, 1.1), 0.0, 1.0);

  // Plastic body shading: lit bevel on the key side, darker on the far side.
  vec3 base = obj * (0.84 + 0.22 * dot(N, KEY));
  base *= 1.0 - 0.22 * max(-lit, 0.0) * smoothstep(0.08, 0.5, tilt);

  // Hard glints, a broad sheen and the studio window: glossy, but no glow from inside.
  vec3 halfKey = normalize(KEY + vec3(0.0, 0.0, 1.0));
  float nh = max(dot(N, halfKey), 0.0);
  float glint = pow(nh, 220.0) * 2.0 + pow(nh, 60.0) * 0.35;
  float sheen = pow(nh, 14.0) * 0.12;
  vec3 R = vec3(2.0 * N.z * N.xy, 2.0 * N.z * N.z - 1.0);
  float env = environment(R, 1.0) * (0.3 + 0.7 * fres) * 0.55;
  float rimLight = smoothstep(0.25, 0.8, tilt) * max(lit, 0.0) * max(lit, 0.0) * 0.45;
  float light = uGloss * (glint + sheen + env + rimLight) * a;

  vec3 color = base * a + light * vec3(1.0, 0.99, 0.97);
  return vec4(color, clamp(a + light * 0.3, 0.0, 1.0));
}

void main() {
  if (uSolid > 0.5) { outColor = solidColor(); return; }
  float d = vDepth;
  bool photo = uPhoto > 0.5;
  // Photos: a rounder dome (its slope reaches further in) for the refraction; the lighting normal
  // is a rounded gel bevel (PHOTO_BEVEL, see photoSlope).
  float slope = min(domeSlope(photo ? d * 0.6 : d), 6.0);
  float edgePx = d / max(length(vGrad), 1e-5);   // distance to the mesh rim in px
  vec2 gradH = photo
    ? photoSlope(d, edgePx, uHeight / ${DOME_HEIGHT.toFixed(3)}) * vGrad / max(length(vGrad), 1e-5)
    : uHeight * slope * vGrad;
  vec3 N = normalize(vec3(-gradH, 1.0));
  float tilt = 1.0 - N.z;
  float fres = tilt * tilt;
  // +1 where the surface faces the key light (upper-left), -1 on the far side.
  float lit = dot(N.xy / max(length(N.xy), 1e-4), normalize(KEY.xy));

  // The photo seen through the dome: the interior is magnified; the outer rim is left
  // unrefracted so the clear gel border stays visible.
  float refr = uRefract * uHeight * min(slope, 1.5) * smoothstep(0.05, 0.3, d);
  // Light diffuses in the thin rim: the photo gets softer there (mip bias; less on photos, whose
  // thin parts, like a paw, would blur into a blob).
  float rim = 1.0 - smoothstep(0.0, 0.4, d);
  float rimBlur = (uPhoto > 0.5 ? 0.5 : 1.4) * rim;
  vec2 tuv = vUv + vRefr * refr;
  bool eyes = uEyeCount > 0.5;
  if (eyes && uWide > 0.001) tuv = eyeWarp(tuv);
  vec4 tex = texture(uTex, tuv, rimBlur);
  // Photo: light diffusing through the gel softens the picture's finest texture (fur, pores) a
  // little: half of a slightly blurred read, so the crisp gloss on top reads as a wet surface over
  // a soft body rather than a laminated print. Edges and faces stay sharp enough to read.
  if (photo) tex = mix(tex, texture(uTex, tuv, rimBlur + PHOTO_SOFTEN), 0.45);
  float a = tex.a;
  // The gel's own colour: the material tint, or for a photo the photo's colour nearby.
  vec3 tint = uTint;
  float cover = 1.0;   // how much of the clear gel border shows
  float silh = 1.0;    // photo: soft coverage of the picture's own outline (0 outside … 1 inside)
  vec3 glowCol = uTint;
  if (photo) {
    vec4 near = textureLod(uTex, vUv, 3.5);
    vec4 wide = textureLod(uTex, vUv, 5.5);
    vec3 local = near.a > 0.02 ? near.rgb / near.a : wide.a > 0.002 ? wide.rgb / wide.a : uTint;
    float ll = dot(local, vec3(0.299, 0.587, 0.114));
    // A touch brighter and richer (light passing through the gel), never muddier than the photo.
    tint = mix(uTint, clamp(mix(vec3(ll), local, 1.25) * 1.08 + 0.05, 0.0, 1.0), 0.9);
    // The mesh outline is a polygon a few px outside the photo; at big sizes its corners show. A
    // photo's gel border instead hugs the photo's own smooth outline and fades out before the polygon.
    silh = textureLod(uTex, vUv, 2.6).a;
    cover = smoothstep(0.0, 0.3, silh);
    // Light glowing through the gel near its edge: the photo's own hue, brightened and kept rich
    // (black fur glows a deep warm amber-brown, never a flat grey).
    float mx = max(local.r, max(local.g, local.b));
    vec3 hue = local / max(mx, 0.3);   // (a near-black's hue is mostly noise: not amplified)
    glowCol = clamp(mix(vec3(dot(hue, vec3(0.299, 0.587, 0.114))), hue, 1.15) * vec3(1.0, 0.94, 0.86), 0.0, 1.0) * mix(0.5, 1.0, mx);
  }
  vec3 obj = a > 0.003 ? tex.rgb / a : tint;
  if (eyes && uLid > 0.001) obj = eyeLids(obj, rimBlur);
  float fin = uFinish;
  if (fin > 3.5 && fin < 4.5) {        // gold: metallic gold leaf over the painting
    float l = dot(obj, vec3(0.299, 0.587, 0.114));
    obj = mix(obj, vec3(1.0, 0.77, 0.32) * (0.3 + 0.95 * l), 0.62);
  } else if (fin > 4.5) {              // rainbow: slow hue bands across the jelly
    vec3 rgb = hue3(vUv.x * 0.9 + vUv.y * 0.6 - uTime * 0.07);
    obj = mix(obj, obj * 0.45 + rgb * 0.62, 0.5);
  } else if (fin > 1.5 && fin < 2.5) { // pearl: milky and soft
    obj = mix(obj, vec3(dot(obj, vec3(0.299, 0.587, 0.114))) * 1.08 + 0.07, 0.3);
  }

  // Light scattering inside the gel: a bit more saturated and brighter.
  float luma = dot(obj, vec3(0.299, 0.587, 0.114));
  obj = clamp(mix(vec3(luma), obj, 1.22) * 1.05 + 0.015, 0.0, 1.0);
  // Photo: the gel holds the picture a touch below paper white (a soft shoulder on the highlights),
  // so the gloss still reads on white fur, a white shirt or a bright sky.
  if (photo) obj = obj * (1.0 - 0.13 * smoothstep(0.45, 1.0, obj));

  // Strain: squashed → denser (darker, saturated); stretched → paler and clearer.
  float squash = clamp(-vStrain, 0.0, 0.6);
  float stretch = clamp(vStrain, 0.0, 0.8);
  luma = dot(obj, vec3(0.299, 0.587, 0.114));
  obj = mix(vec3(luma), obj, 1.0 + 0.9 * squash) * (1.0 - 0.25 * squash);
  obj = mix(obj, obj * 0.55 + 0.45, 0.4 * stretch);

  // Subsurface: thin rim regions are translucent and take the gel's tint.
  obj = mix(obj, obj * (0.5 + 0.7 * tint), (uPhoto > 0.5 ? 0.15 : 0.4) * rim);
  // Translucent towards the rim (a photo only along a thin edge: a wide see-through band over a dark
  // photo reads as a grey halo).
  float objAlpha = (uPhoto > 0.5 ? mix(0.8, 0.98, smoothstep(0.0, 0.12, d)) : mix(0.62, 0.97, smoothstep(0.0, 0.4, d))) * (1.0 - 0.3 * stretch);
  if (fin > 2.5 && fin < 3.5) objAlpha *= 0.58;   // glass: see-through

  // Clear gel where the cutout is transparent.
  vec3 gel = tint * 0.9 + 0.06;
  float gelAlpha = (0.3 + 0.3 * fres - 0.08 * stretch) * cover;

  vec3 base = mix(gel, obj, a);
  float alpha = mix(gelAlpha, objAlpha, a);

  // Gentle dome shading; the far side glows with transmitted light instead of going dark.
  base *= photo ? 0.83 + 0.27 * dot(N, KEY) : 0.86 + 0.2 * dot(N, KEY);
  if (photo) {
    float bw = photoBevelPx(uHeight / ${DOME_HEIGHT.toFixed(3)});
    float e = edgePx / bw;   // 0 at the outline … 1 where the bevel meets the flat top
    // Subsurface glow inside the bevel, strongest where the light exits (far side).
    float inner = smoothstep(0.1, 0.35, e) * (1.0 - smoothstep(0.7, 1.4, e)) * a;
    float far0 = max(-lit, 0.0);
    base = mix(base, base * 1.1 + glowCol * 0.45, inner * (0.3 + 0.7 * far0));
    // The upward-facing bevel reflects the sky: a cool sheen that shows even on white fur, the way
    // a wet sweet looks outdoors.
    float up = max(-N.y, 0.0) / max(length(N.xy), 1e-4);
    float skyK = smoothstep(0.1, 0.3, tilt) * (1.0 - smoothstep(0.55, 0.75, tilt)) * smoothstep(0.1, 0.9, up) * 0.3;
    base = mix(base, max(base, vec3(0.66, 0.82, 1.0)), skyK * a);
  }
  float far = max(-lit, 0.0);
  float band = smoothstep(0.0, 0.08, d) * (1.0 - smoothstep(0.18, 0.5, d));
  float caustic = far * far * band * min(1.0, length(N.xy) * 1.6);
  base = mix(base, base * 1.25 + tint * 0.35, 0.7 * caustic);
  alpha = min(1.0, alpha + 0.2 * caustic * (1.0 - a) * cover);

  // Thin tinted edge line (surroundings refracted at the rim), strongest on the far side.
  float line = 1.0 - smoothstep(0.2, 1.6, edgePx);
  base = mix(base, tint * 0.45, 0.4 * line * (0.4 + 0.6 * far) * cover);
  alpha = mix(alpha, 0.8, 0.4 * line * cover);

  // Wet highlights.
  vec3 halfKey = normalize(KEY + vec3(0.0, 0.0, 1.0));
  float nh = max(dot(N, halfKey), 0.0);
  float glint = pow(nh, 300.0) * 2.2;
  float sheen = pow(nh, 30.0) * 0.18;
  float kick = pow(max(dot(N, normalize(KICK + vec3(0.0, 0.0, 1.0))), 0.0), 90.0) * 0.35;
  vec3 R = vec3(2.0 * N.z * N.xy, 2.0 * N.z * N.z - 1.0);   // reflect((0,0,-1), N)
  float env = environment(R, photo ? 0.0 : 1.0) * (0.16 + 0.84 * fres) * 0.62;
  float rimLight = smoothstep(0.35, 0.9, tilt) * max(lit, 0.0) * max(lit, 0.0) * 0.5;
  if (photo) {
    // A photo has no painted highlights of its own: the gel's gloss has to carry the "jelly" read.
    // It all lives on the narrow bevel (photoBevelPx), so the top, faces included, stays clear:
    //  - the studio window (photoWindow) as a few crisp streaks on the lit shoulder, a shorter one
    //    on the other; only a narrow slope range reflects it, so it is a streak, not a band;
    //  - grazing glints and a thin rim light along the outermost edge, a fainter kicker opposite;
    //  - a thin rim light tracing the picture's own outline on the lit side.
    float streak = smoothstep(0.18, 0.24, tilt) * (1.0 - smoothstep(0.46, 0.54, tilt));
    env = photoWindow(R) * streak * 1.5;
    // …and a small second one up-right: a short glint on the other shoulder.
    env += photoWindow(vec3(-R.x * 1.25, R.y * 1.1, R.z)) * streak * 0.75;
    rimLight = smoothstep(0.6, 0.85, tilt) * max(lit, 0.0) * max(lit, 0.0) * 0.8;
    float far1 = max(-lit, 0.0);
    rimLight += smoothstep(0.6, 0.9, tilt) * far1 * far1 * 0.35;
    // Glints from low (grazing) keys: they land on the steep outer bevel, tracing the outline as a
    // crisp streak instead of a hot spot on the picture (an eye, a nose).
    float ng = max(dot(N, normalize(vec3(-0.57, -0.82, 0.77))), 0.0);
    float nk = max(dot(N, normalize(vec3(0.62, 0.78, 0.8))), 0.0);
    glint = pow(ng, 260.0) * 1.8 + pow(ng, 60.0) * 0.4 + pow(nk, 220.0) * 0.9;
    sheen = pow(nh, 30.0) * 0.1;
    float ring = smoothstep(0.12, 0.45, silh) * (1.0 - smoothstep(0.55, 0.92, silh));
    rimLight += ring * smoothstep(0.2, 0.85, lit) * 0.5;
  }
  float light = uGloss * (glint + sheen + kick + env + rimLight) * max(a, cover);
  // Over near-white parts of a photo the gloss can only blow the detail out (white fur turns into a
  // glow); it is held back there and reads on the mid and dark tones instead.
  if (photo) light *= mix(1.0, 0.5, smoothstep(0.62, 0.95, dot(base, vec3(0.299, 0.587, 0.114))) * a);
  vec3 lightCol = vec3(1.0, 0.99, 0.96);

  if (fin > 0.5) {
    if (fin < 1.5) {                   // glitter: twinkling flecks suspended in the gel
      vec2 g = vUv * 80.0;
      vec2 cell = floor(g);
      float h = hash12(cell);
      vec2 f = fract(g) - 0.5 - (vec2(hash12(cell + 7.1), hash12(cell + 3.3)) - 0.5) * 0.5;
      float tw = pow(0.5 + 0.5 * sin(uTime * 4.0 + h * 60.0 + N.x * 9.0 + N.y * 7.0), 6.0);
      float fleck = step(0.8, h) * smoothstep(0.26, 0.03, length(f)) * (0.25 + tw) * smoothstep(0.02, 0.15, d);
      light += fleck * 2.4;
      base += vec3(1.0, 0.9, 0.7) * fleck * 0.5;
    } else if (fin < 2.5) {            // pearl: thin-film iridescence on the slopes
      vec3 irid = 0.5 + 0.5 * cos(6.2832 * (tilt * 1.8 + d * 0.7 + vec3(0.0, 0.33, 0.67)));
      base = mix(base, base * 0.75 + irid * 0.4, 0.3 + 0.5 * fres);
      light *= 1.15;
    } else if (fin < 3.5) {            // glass: crisper, brighter reflections
      light *= 1.4;
    } else if (fin < 4.5) {            // gold: warm metallic reflections
      lightCol = vec3(1.0, 0.86, 0.55);
      light *= 1.5;
    }
  }

  base *= uAmbient;
  light *= uAmbient;
  if (uGlow.a > 0.0) {                 // emissive: lit from inside (not dimmed at night)
    float core = 0.35 + 0.65 * smoothstep(0.0, 0.6, d);
    base += uGlow.rgb * uGlow.a * core * 0.6;
    alpha = max(alpha, min(1.0, 0.5 * uGlow.a));
  }

  vec3 color = base * alpha + light * lightCol;
  outColor = vec4(color, clamp(alpha + light * 0.5, 0.0, 1.0));
}`;

const SHADOW_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=2) in float aDepth;
layout(location=3) in vec2 aGrad;
uniform vec2 uView;
uniform vec2 uOffset;
uniform float uSpread;     // px the silhouette grows outward (half the penumbra)
uniform float uInradius;
out float vDepth;
void main() {
  vDepth = aDepth;
  vec2 outward = -aGrad * uInradius;
  float len = length(outward);
  if (len > 1.0) outward /= len;
  vec2 p = aPos + uOffset + outward * uSpread * (1.0 - aDepth);
  vec2 clip = p / uView * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
in float vDepth;
uniform vec3 uTint;
uniform float uOpacity;
uniform float uSoft;       // penumbra width in depth units
uniform float uSolid;      // 1: opaque body, no light passes through
out vec4 outColor;
void main() {
  float edge = smoothstep(0.0, uSoft, vDepth);
  // Light passing through the gel: the core of the shadow is lighter and tint-coloured.
  float core = smoothstep(uSoft, 1.0, vDepth) * (1.0 - uSolid);
  vec3 dark = mix(vec3(0.12, 0.08, 0.1), uTint * 0.35, 0.7);
  vec3 col = mix(dark, uTint * 0.65, 0.5 * core);
  float a = uOpacity * edge * edge * (3.0 - 2.0 * edge) * (1.0 - 0.35 * core);
  outColor = vec4(col * a, a);
}`;

const FLOOR_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
uniform vec2 uView;
uniform vec2 uCenter;
uniform vec2 uRadius;
out vec2 vP;
void main() {
  vP = aCorner;
  vec2 p = uCenter + aCorner * uRadius;
  vec2 clip = p / uView * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FLOOR_FS = `#version 300 es
precision highp float;
in vec2 vP;
uniform vec3 uColor;
uniform float uOpacity;
out vec4 outColor;
void main() {
  float r2 = dot(vP, vP);
  float f = max(1.0 - r2, 0.0);
  float a = uOpacity * f * f * (0.35 + 0.65 * f);
  outColor = vec4(uColor * a, a);
}`;

// Soft additive halo around a glowing body (drawn with FLOOR_VS's unit quad).
const HALO_FS = `#version 300 es
precision highp float;
in vec2 vP;
uniform vec3 uColor;
uniform float uOpacity;
out vec4 outColor;
void main() {
  float f = max(1.0 - length(vP), 0.0);
  float a = uOpacity * f * f;
  outColor = vec4(uColor * a, a * 0.3);   // mostly additive: light, not paint
}`;

const FINISH_IDS = { glitter: 1, pearl: 2, glass: 3, gold: 4, rainbow: 5 };
const NO_EYES = new Float32Array(16);

const ACC = 7; // per-vertex accumulator: ∇depth(2), ∇u(2), ∇v(2), weight

/**
 * Area-weighted one-ring average of per-triangle gradients of the depth, u and v fields
 * over the triangles as positioned by `P`. Writes un-normalized sums into `acc`
 * (ACC floats per vertex; divide by acc[7i+6]). Allocation-free.
 * For a linear field f on a triangle, 2·area·∇f = Σ f_i · perp(edge opposite i), so each
 * triangle contributes that numerator and weight 2·|area|.
 */
export function accumulateGradients(P, uv, depth, tris, acc) {
  acc.fill(0);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const xa = P[2 * a], ya = P[2 * a + 1];
    const xb = P[2 * b], yb = P[2 * b + 1];
    const xc = P[2 * c], yc = P[2 * c + 1];
    const A2 = (xb - xa) * (yc - ya) - (xc - xa) * (yb - ya);
    if (!(A2 > 1e-9 || A2 < -1e-9)) continue; // degenerate or NaN
    const s = A2 > 0 ? 1 : -1; // flipped triangles still contribute with positive weight
    const kxa = (yb - yc) * s, kxb = (yc - ya) * s, kxc = (ya - yb) * s;
    const kya = (xc - xb) * s, kyb = (xa - xc) * s, kyc = (xb - xa) * s;
    const da = depth[a], db = depth[b], dc = depth[c];
    const ua = uv[2 * a], ub = uv[2 * b], uc = uv[2 * c];
    const va = uv[2 * a + 1], vb = uv[2 * b + 1], vc = uv[2 * c + 1];
    const gdx = da * kxa + db * kxb + dc * kxc, gdy = da * kya + db * kyb + dc * kyc;
    const gux = ua * kxa + ub * kxb + uc * kxc, guy = ua * kya + ub * kyb + uc * kyc;
    const gvx = va * kxa + vb * kxb + vc * kxc, gvy = va * kya + vb * kyb + vc * kyc;
    const w = A2 * s;
    addGradient(acc, a * ACC, gdx, gdy, gux, guy, gvx, gvy, w);
    addGradient(acc, b * ACC, gdx, gdy, gux, guy, gvx, gvy, w);
    addGradient(acc, c * ACC, gdx, gdy, gux, guy, gvx, gvy, w);
  }
}

function addGradient(acc, o, gdx, gdy, gux, guy, gvx, gvy, w) {
  acc[o] += gdx; acc[o + 1] += gdy;
  acc[o + 2] += gux; acc[o + 3] += guy;
  acc[o + 4] += gvx; acc[o + 5] += gvy;
  acc[o + 6] += w;
}

// Inradius of the rest mesh in cutout px, from the typical |∇depth| (depth is a normalized
// distance-to-edge, so |∇depth| ≈ 1 / inradius away from the rim and the medial ridge).
function estimateInradius(mesh, acc) {
  accumulateGradients(mesh.rest, mesh.uv, mesh.depth, mesh.tris, acc);
  let sum = 0, count = 0;
  for (let i = 0; i < mesh.depth.length; i++) {
    const d = mesh.depth[i], w = acc[i * ACC + 6];
    if (d < 0.12 || d > 0.85 || w <= 0) continue;
    const g = Math.hypot(acc[i * ACC], acc[i * ACC + 1]) / w;
    if (g > 0) { sum += g; count++; }
  }
  if (count > 0) return count / sum;
  return Math.sqrt((mesh.area || mesh.width * mesh.height * 0.5) / Math.PI);
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error('Jelly shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc, uniforms) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error('Jelly shader link failed: ' + gl.getProgramInfoLog(prog));
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const u = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
  return { prog, u };
}

export class JellyRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false,
    });
    if (!gl) throw new Error('WebGL2 is not supported');
    this.canvas = canvas;
    this.gl = gl;
    this.width = canvas.clientWidth || canvas.width || 1;
    this.height = canvas.clientHeight || canvas.height || 1;
    this.dpr = 1;
    this.entries = new Map(); // JellyBody → per-body CPU scratch + GPU resources
    this.lost = false;
    this._lastTime = null;
    this.floorShadow = true;  // contact shadows on the floor (y = canvas CSS height)
    this.floorY = null;       // optional floor line (CSS px) when the canvas extends below the floor
    this.shadowOffset = null; // [x, y] px drop-shadow offset (grows while lifted); null = automatic
    this.liftShadowOpacity = null; // drop-shadow opacity at full lift (null: fades as before)
    this._preloaded = new Map();   // canvas → texture uploaded ahead of addBody (preloadTexture)
    this.ambient = 1;              // reflected-light multiplier (Night Lights: < 1)
    this._time = 0;
    this._eyeBuf = new Float32Array(16);

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // allows the context to be restored
      this.lost = true;
      this._preloaded.clear();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this._initGL();
      for (const entry of this.entries.values()) this._createGPU(entry);
      this.lost = false;
    });

    this._initGL();
  }

  resize(width, height, dpr = 1) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    const w = Math.max(1, Math.round(this.width * dpr));
    const h = Math.max(1, Math.round(this.height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
  }

  addBody(body, textureCanvas, material) {
    if (this.entries.has(body)) this.removeBody(body);
    const mesh = body.mesh;
    const n = mesh.rest.length / 2;
    const acc = new Float64Array(n * ACC);
    const entry = {
      body,
      mesh,
      source: textureCanvas,
      material: material || body.material || {},
      n,
      acc,
      surface: new Float32Array(n * 5), // ∇depth(2), uv shift dir(2), strain
      inradius: estimateInradius(mesh, acc), // cutout px
      lift: body.grabbed ? 1 : 0,
      minX: 0, maxX: 0, maxY: 0, valid: false,
      gpu: null,
    };
    this.entries.set(body, entry);
    if (!this.lost) this._createGPU(entry);
  }

  removeBody(body) {
    const entry = this.entries.get(body);
    if (!entry) return;
    this._deleteGPU(entry);
    this.entries.delete(body);
  }

  clear() {
    for (const entry of this.entries.values()) this._deleteGPU(entry);
    this.entries.clear();
  }

  /**
   * Upload `canvas` as a texture now (e.g. in idle time), so a later addBody(body, canvas) does
   * not stall the frame it happens in. Keeps at most 4 pending uploads. → true when uploaded.
   */
  preloadTexture(canvas) {
    if (!canvas || this.lost || this._preloaded.has(canvas)) return false;
    const gl = this.gl;
    if (this._preloaded.size >= 4) {
      const [old, tex] = this._preloaded.entries().next().value;
      gl.deleteTexture(tex);
      this._preloaded.delete(old);
    }
    const tex = gl.createTexture();
    this._uploadTexture(tex, canvas);
    this._preloaded.set(canvas, tex);
    return true;
  }

  // Swap a body's texture (same layout as the cutout the mesh was built from; any resolution).
  // → false if the body isn't rendered.
  setTexture(body, canvas) {
    const entry = this.entries.get(body);
    if (!entry || !canvas) return false;
    entry.source = canvas;
    if (!this.lost && entry.gpu) this._uploadTexture(entry.gpu.tex, canvas);
    return true;
  }

  render(bodies, timeSeconds = 0) {
    const gl = this.gl;
    const dt = this._lastTime === null ? 0 : Math.min(0.1, Math.max(0, timeSeconds - this._lastTime));
    this._lastTime = timeSeconds;
    this._time = timeSeconds;
    if (this.lost || gl.isContextLost()) return;

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const liftRate = 1 - Math.exp(-dt * 9);
    for (let i = 0; i < bodies.length; i++) {
      const entry = this.entries.get(bodies[i]);
      if (!entry || !entry.gpu) continue;
      const b = entry.body;
      const lt = typeof b.lift === 'number' ? b.lift : b.grabbed ? 1 : 0;
      entry.lift += (lt - entry.lift) * liftRate;
      this._updateSurface(entry);
    }

    if (this.floorShadow) this._drawFloorShadows(bodies);
    this._drawHalos(bodies);

    // Each body's drop shadow is drawn right before the body, so bodies in front
    // cast their shadow onto the ones behind them.
    for (let i = 0; i < bodies.length; i++) {
      const entry = this.entries.get(bodies[i]);
      if (!entry || !entry.gpu || !entry.valid) continue;
      gl.bindVertexArray(entry.gpu.vao);
      this._drawShadow(entry);
      this._drawBody(entry);
    }
    gl.bindVertexArray(null);
  }

  // --- internals -----------------------------------------------------------------------

  _initGL() {
    const gl = this.gl;
    this.bodyProg = createProgram(gl, BODY_VS, BODY_FS,
      ['uView', 'uTex', 'uTint', 'uGloss', 'uHeight', 'uRefract', 'uSolid', 'uBevel',
        'uGlow', 'uFinish', 'uTime', 'uAmbient', 'uEyes', 'uEyeCount', 'uLid', 'uWide', 'uPhoto']);
    this.shadowProg = createProgram(gl, SHADOW_VS, SHADOW_FS,
      ['uView', 'uOffset', 'uSpread', 'uInradius', 'uTint', 'uOpacity', 'uSoft', 'uSolid']);
    this.floorProg = createProgram(gl, FLOOR_VS, FLOOR_FS,
      ['uView', 'uCenter', 'uRadius', 'uColor', 'uOpacity']);
    this.haloProg = createProgram(gl, FLOOR_VS, HALO_FS,
      ['uView', 'uCenter', 'uRadius', 'uColor', 'uOpacity']);

    this.floorVao = gl.createVertexArray();
    gl.bindVertexArray(this.floorVao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  }

  _createGPU(entry) {
    const gl = this.gl;
    const { mesh, n } = entry;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, n * 2 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const staticData = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      staticData[3 * i] = mesh.uv[2 * i];
      staticData[3 * i + 1] = mesh.uv[2 * i + 1];
      staticData[3 * i + 2] = mesh.depth[i];
    }
    const staticBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, staticBuf);
    gl.bufferData(gl.ARRAY_BUFFER, staticData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 12, 8);

    const surfBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, surfBuf);
    gl.bufferData(gl.ARRAY_BUFFER, n * 5 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, 20, 8);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, 20, 16);

    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.tris, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    let tex = this._preloaded.get(entry.source);
    if (tex) this._preloaded.delete(entry.source);
    else {
      tex = gl.createTexture();
      this._uploadTexture(tex, entry.source);
    }

    entry.gpu = {
      vao, posBuf, staticBuf, surfBuf, idxBuf, tex,
      count: mesh.tris.length,
      indexType: mesh.tris instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    };
  }

  _uploadTexture(tex, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
  }

  _deleteGPU(entry) {
    const g = entry.gpu;
    entry.gpu = null;
    if (!g || this.lost) return; // objects of a lost context are already gone
    const gl = this.gl;
    gl.deleteVertexArray(g.vao);
    gl.deleteBuffer(g.posBuf);
    gl.deleteBuffer(g.staticBuf);
    gl.deleteBuffer(g.surfBuf);
    gl.deleteBuffer(g.idxBuf);
    gl.deleteTexture(g.tex);
  }

  // Per-vertex surface attributes from the deformed mesh; uploads positions + surface.
  _updateSurface(entry) {
    const { body, mesh, acc, surface, n } = entry;
    const P = body.positions;
    const strain = body.strain;
    accumulateGradients(P, mesh.uv, mesh.depth, mesh.tris, acc);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0, o = 0, s = 0; i < n; i++, o += ACC, s += 5) {
      const w = acc[o + 6];
      if (w > 0) {
        const inv = 1 / w;
        const gdx = acc[o] * inv, gdy = acc[o + 1] * inv;
        surface[s] = gdx;
        surface[s + 1] = gdy;
        // uv shift for a world shift along ∇depth: J · ∇depth, J = d(uv)/d(world)
        surface[s + 2] = (acc[o + 2] * gdx + acc[o + 3] * gdy) * inv;
        surface[s + 3] = (acc[o + 4] * gdx + acc[o + 5] * gdy) * inv;
      } else {
        surface[s] = surface[s + 1] = surface[s + 2] = surface[s + 3] = 0;
      }
      surface[s + 4] = strain ? strain[i] : 0;
      const x = P[2 * i], y = P[2 * i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (y < minY) minY = y;
    }
    entry.minX = minX; entry.maxX = maxX; entry.minY = minY; entry.maxY = maxY;
    entry.valid = maxX >= minX; // false if positions went NaN

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.gpu.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, P, 0, n * 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.gpu.surfBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, surface);
  }

  _inradiusWorld(entry) {
    return entry.inradius * (entry.body.scale || 1);
  }

  _drawFloorShadows(bodies) {
    const gl = this.gl;
    const { prog, u } = this.floorProg;
    const floorY = Number.isFinite(this.floorY) ? this.floorY : this.height;
    gl.useProgram(prog);
    gl.uniform2f(u.uView, this.width, this.height);
    gl.bindVertexArray(this.floorVao);
    for (let i = 0; i < bodies.length; i++) {
      const entry = this.entries.get(bodies[i]);
      if (!entry || !entry.gpu || !entry.valid) continue;
      const halfW = (entry.maxX - entry.minX) * 0.5;
      const gap = Math.max(0, floorY - entry.maxY);
      const near = 1 - smoothstep(0, Math.max(halfW * 3.5, 1), gap);
      if (near <= 0.01) continue;
      const tint = entry.material.tint || DEFAULT_TINT;
      const spread = 1 + (1 - near) * 0.7;
      gl.uniform2f(u.uCenter, (entry.minX + entry.maxX) * 0.5, floorY);
      gl.uniform2f(u.uRadius, halfW * 1.08 * spread, Math.max(10, halfW * 0.2) * spread);
      gl.uniform3f(u.uColor, 0.1 + tint[0] * 0.12, 0.07 + tint[1] * 0.12, 0.08 + tint[2] * 0.12);
      gl.uniform1f(u.uOpacity, 0.5 * near * near);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // Halos of glowing bodies (body.glow), under every body.
  _drawHalos(bodies) {
    let prog = null;
    const gl = this.gl;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i], glow = b.glow;
      if (!glow) continue;
      const entry = this.entries.get(b);
      if (!entry || !entry.gpu || !entry.valid) continue;
      const k = Number.isFinite(b.glowStrength) ? b.glowStrength : 0.55;
      if (!(k > 0)) continue;
      if (!prog) {
        prog = this.haloProg;
        gl.useProgram(prog.prog);
        gl.uniform2f(prog.u.uView, this.width, this.height);
        gl.bindVertexArray(this.floorVao);
      }
      const hw = (entry.maxX - entry.minX) * 0.5, hh = (entry.maxY - entry.minY) * 0.5;
      gl.uniform2f(prog.u.uCenter, entry.minX + hw, entry.minY + hh);
      gl.uniform2f(prog.u.uRadius, hw * 1.42 + 6, hh * 1.42 + 6);
      gl.uniform3f(prog.u.uColor, glow[0], glow[1], glow[2]);
      gl.uniform1f(prog.u.uOpacity, Math.min(1, k));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  _drawShadow(entry) {
    const gl = this.gl;
    const { prog, u } = this.shadowProg;
    const r = this._inradiusWorld(entry);
    const lift = entry.lift;
    const solid = entry.material.solid === true;
    const spread = 4 + 0.05 * r + lift * (0.08 * r + 8);
    const tint = entry.material.tint || DEFAULT_TINT;
    gl.useProgram(prog);
    gl.uniform2f(u.uView, this.width, this.height);
    const fixed = this.shadowOffset;
    if (fixed && Number.isFinite(fixed[0]) && Number.isFinite(fixed[1])) {
      const extra = lift * (0.14 * r + 16); // still lifts toward the viewer while held
      gl.uniform2f(u.uOffset, fixed[0] + extra * 0.56, fixed[1] + extra * 0.83);
    } else {
      const dist = 5 + 0.06 * r + lift * (0.14 * r + 16);
      gl.uniform2f(u.uOffset, dist * 0.56, dist * 0.83);
    }
    gl.uniform1f(u.uSpread, spread);
    gl.uniform1f(u.uInradius, r);
    gl.uniform3f(u.uTint, tint[0], tint[1], tint[2]);
    gl.uniform1f(u.uSolid, solid ? 1 : 0);
    const base = solid ? 0.36 : 0.3, lo = this.liftShadowOpacity;
    gl.uniform1f(u.uOpacity, Number.isFinite(lo) ? base + (lo - base) * lift : base * (1 - 0.35 * lift));
    gl.uniform1f(u.uSoft, Math.min(0.7, Math.max(0.06, (2 * spread) / r)));
    gl.drawElements(gl.TRIANGLES, entry.gpu.count, entry.gpu.indexType, 0);
  }

  _drawBody(entry) {
    const gl = this.gl;
    const { prog, u } = this.bodyProg;
    const r = this._inradiusWorld(entry);
    const m = entry.material;
    const tint = m.tint || DEFAULT_TINT;
    gl.useProgram(prog);
    gl.uniform2f(u.uView, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.gpu.tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniform3f(u.uTint, tint[0], tint[1], tint[2]);
    gl.uniform1f(u.uGloss, m.gloss ?? 0.85);
    gl.uniform1f(u.uHeight, DOME_HEIGHT * r);
    gl.uniform1f(u.uRefract, REFRACTION * r);
    const solid = m.solid === true;
    gl.uniform1f(u.uSolid, solid ? 1 : 0);
    gl.uniform1f(u.uPhoto, m.photo === true ? 1 : 0);
    // Bevel ≈ SOLID_BEVEL px wide (in depth units of this body), never the whole body.
    gl.uniform1f(u.uBevel, solid ? Math.min(0.6, Math.max(0.08, SOLID_BEVEL / Math.max(r, 1))) : 0.3);
    // Free-mode extras (body fields; absent = the default look).
    const b = entry.body, glow = b.glow;
    const gk = glow ? (Number.isFinite(b.glowStrength) ? b.glowStrength : 0.55) : 0;
    if (glow) gl.uniform4f(u.uGlow, glow[0], glow[1], glow[2], gk);
    else gl.uniform4f(u.uGlow, 0, 0, 0, 0);
    gl.uniform1f(u.uFinish, FINISH_IDS[b.finish] || 0);
    gl.uniform1f(u.uTime, this._time % 1000);
    gl.uniform1f(u.uAmbient, Number.isFinite(this.ambient) ? this.ambient : 1);
    const eyes = b.eyes;
    const ne = eyes && !solid ? Math.min(4, eyes.length) : 0;
    if (ne) {
      const buf = this._eyeBuf;
      for (let k = 0; k < ne; k++) for (let c = 0; c < 4; c++) buf[4 * k + c] = eyes[k][c];
      gl.uniform4fv(u.uEyes, buf);
    } else gl.uniform4fv(u.uEyes, NO_EYES);
    gl.uniform1f(u.uEyeCount, ne);
    gl.uniform1f(u.uLid, ne ? Math.min(1, Math.max(0, b.lid || 0)) : 0);
    gl.uniform1f(u.uWide, ne ? Math.min(1, Math.max(0, b.eyeWide || 0)) : 0);
    gl.drawElements(gl.TRIANGLES, entry.gpu.count, entry.gpu.indexType, 0);
  }
}
