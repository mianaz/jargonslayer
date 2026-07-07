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
