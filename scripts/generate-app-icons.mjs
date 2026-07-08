// App icons = the original illustrated dragon (branding/icon-cropped.png)
// palette-matched to the v3 terminal palette (Miana's direction after the
// pixel-Bit icons were rejected as too ugly): navy bg -> neutral ink-dark,
// blue horns/eye -> phosphor-green hue (#4ADE80 family), fire -> phosphor
// green ("phosphor breath" melting the jargon bubble), silver-white body
// unchanged (white is the palette's one sanctioned large-area accent).
// Regenerate all four outputs with: node scripts/generate-app-icons.mjs
import sharp from "sharp";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "branding/icon-cropped.png");
const MODE = "A"; // green fire (candidate B = warm fire was considered and parked)

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255].map((v) => Math.round(Math.max(0, Math.min(255, v))));
}

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const PHOS_HUE = 145; // #4ADE80 ≈ hsl(145, 68%, 58%)

for (let i = 0; i < data.length; i += 4) {
  const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
  let out = null;
  if (h >= 185 && h <= 265) {
    if (l < 0.18) {
      // navy bg + dark glyph strokes -> neutral ink-dark, keep shading
      const nl = Math.max(0.03, l * 0.55);
      out = hslToRgb(0, 0, nl);
    } else if (s < 0.25) {
      // cool-grey shading (mane shadows) -> neutral grey, SAME luminance
      // (darkening these was speckling the mane)
      out = hslToRgb(0, 0, l);
    } else {
      // saturated blues (horns, eye) -> phosphor green
      out = hslToRgb(PHOS_HUE, Math.min(1, s * 0.9), l);
    }
  } else if (h >= 15 && h <= 62 && s > 0.3 && MODE === "A") {
    // fire -> phosphor green, keep the flame's own light/dark shading
    out = hslToRgb(PHOS_HUE, Math.min(1, s * 0.95), l);
  }
  if (out) { data[i] = out[0]; data[i + 1] = out[1]; data[i + 2] = out[2]; }
}

const master = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
const jobs = [
  [512, "public/icon-512.png"],
  [192, "public/icon-192.png"],
  [180, "src/app/apple-icon.png"],
  [64, "src/app/icon.png"],
];
for (const [size, out] of jobs) {
  await master.clone().resize(size, size).png().toFile(join(ROOT, out));
  console.log("wrote", out, size);
}

// ── in-UI icon variants (v0.2.4) ────────────────────────────────────
// The header (Header.tsx) shows the icon INSIDE the app, where the
// baked ink-dark square clashes with any non-dark theme. Two extra
// outputs, both with the background removed, one per scheme (the
// globals.css .scheme-*-only classes swap them by <html data-scheme>):
//   icon-ui-dark.png  — the palette-matched art as-is, transparent bg.
//   icon-ui-light.png — SAME dragon, silver rendition: neutrals scaled
//     down in luminance (white body -> light silver, ramp/ordering
//     preserved, outlines stay dark) and the phosphor greens deepened
//     toward the light theme's lab-green weight. v1 luminance-INVERTED
//     the neutrals instead (white dragon -> black); Miana read that as
//     the old rejected pixel-Bit icon ("old, more ugly version") — the
//     brand mark must stay the same white/silver dragon in both
//     schemes, only contrast-adapted.
// Both UI variants are cropped to the artwork's alpha bounding box —
// the source frame carries generous margins, which at header size
// (h-9) made the glyph read ~30% smaller than its box ("logo too
// small to be seen clearly").
// The app-store/PWA icons above keep their opaque background on
// purpose (maskable-icon rules); only the in-UI pair is transparent.

// Background removal: BFS flood fill from the four corners across
// dark, unsaturated pixels. Interior dark strokes (#%@ glyphs, the
// eye) are enclosed by the bubble/body and stay untouched; the gaps
// between fire droplets connect to the outer field and clear as they
// should. Antialiased boundary pixels blend toward the body's own
// colors and fall outside the fill criterion — at the 28px display
// size the surviving 1px blend reads as a soft outline, not a halo.
function removeBackground(px, width, height) {
  const isBg = (i) => {
    if (px[i + 3] === 0) return false; // already cleared
    const [, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    // Near-black always counts: compression noise like rgb(1,0,0) has
    // a mathematical saturation of 1.0 at l≈0.002 and was surviving
    // the s-gate as opaque specks along the frame edges.
    return l < 0.05 || (s < 0.35 && l < 0.17);
  };
  const queue = [];
  const seen = new Uint8Array(width * height);
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (seen[p]) return;
    seen[p] = 1;
    if (isBg(p * 4)) queue.push(p);
  };
  push(0, 0); push(width - 1, 0); push(0, height - 1); push(width - 1, height - 1);
  while (queue.length) {
    const p = queue.pop();
    px[p * 4 + 3] = 0;
    const x = p % width, y = (p / width) | 0;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
}

const uiDark = Buffer.from(data);
removeBackground(uiDark, info.width, info.height);

const uiLight = Buffer.from(uiDark);
for (let i = 0; i < uiLight.length; i += 4) {
  if (uiLight[i + 3] === 0) continue;
  const [h, s, l] = rgbToHsl(uiLight[i], uiLight[i + 1], uiLight[i + 2]);
  let out = null;
  if (h >= 120 && h <= 170 && s > 0.3) {
    // phosphor greens -> deep green, shading order preserved (plain
    // scale, not inversion — inverting would turn the bright flame
    // core into the darkest region and hollow the fire out)
    out = hslToRgb(PHOS_HUE, Math.min(1, s * 1.05), Math.min(0.42, l * 0.5));
  } else if (s < 0.3) {
    // neutrals -> single downward luminance scale: ordering preserved,
    // so the white dragon becomes a light-SILVER dragon (not charcoal)
    // whose dark outlines carry the silhouette on paper surfaces.
    out = hslToRgb(0, 0, l * 0.74);
  }
  if (out) { uiLight[i] = out[0]; uiLight[i + 1] = out[1]; uiLight[i + 2] = out[2]; }
}

// Alpha bounding box (shared: uiLight derives from uiDark's mask),
// padded ~3% so antialiased edges don't kiss the frame. Robust form:
// a row/column only counts as occupied with ≥3 near-opaque pixels —
// the navy field carries a few isolated specks that survive the
// flood-fill criterion, and a min/max bbox over raw alpha>0 was
// getting stretched to the full frame by them (the extract below then
// simply cuts them away along with the margins).
const rowHits = new Uint32Array(info.height);
const colHits = new Uint32Array(info.width);
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (uiDark[(y * info.width + x) * 4 + 3] >= 200) {
      rowHits[y]++;
      colHits[x]++;
    }
  }
}
const MIN_HITS = 3;
let minX = 0, maxX = info.width - 1, minY = 0, maxY = info.height - 1;
while (minY < maxY && rowHits[minY] < MIN_HITS) minY++;
while (maxY > minY && rowHits[maxY] < MIN_HITS) maxY--;
while (minX < maxX && colHits[minX] < MIN_HITS) minX++;
while (maxX > minX && colHits[maxX] < MIN_HITS) maxX--;
const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03);
const crop = {
  left: Math.max(0, minX - pad),
  top: Math.max(0, minY - pad),
};
crop.width = Math.min(info.width, maxX + pad + 1) - crop.left;
crop.height = Math.min(info.height, maxY + pad + 1) - crop.top;

// The artwork is naturally WIDE (dragon + jargon bubble side by side,
// ~1.75:1) — keep that aspect instead of re-padding into a square, and
// let the header render it h-9 w-auto. Fixed height 192, width by
// aspect ratio.
for (const [buf, out] of [
  [uiDark, "public/icon-ui-dark.png"],
  [uiLight, "public/icon-ui-light.png"],
]) {
  await sharp(buf, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract(crop)
    .resize({ height: 192 })
    .png()
    .toFile(join(ROOT, out));
  console.log("wrote", out, `h192 (crop ${crop.width}x${crop.height}@${crop.left},${crop.top})`);
}
