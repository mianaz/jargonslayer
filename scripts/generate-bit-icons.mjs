// Generates every app icon from Bit's own pixel art, so the icon and
// the mascot are literally the same character (Miana's v0.2.2 E2E
// finding #3: the old icons were a leftover white cartoon dragon).
//
// The rect list below is Bit's awake pose serialized from the running
// PixelDragon.tsx SVG (36×26 grid, facing left): body + cursor-block
// pupil (the signature) + raised tail variant + lit dorsal fins.
// If PixelDragon.tsx's art changes, re-serialize and update here, then
// run: node scripts/generate-bit-icons.mjs
//
// Outputs (all overwritten in place):
//   public/icon-192.png  (192 = 64-unit canvas × 3 — integer scale, crisp)
//   public/icon-512.png  (512 = 64 × 8)
//   src/app/apple-icon.png (180)
//   src/app/icon.png     (64, head-crop — a full 36-wide body is mush at
//                         favicon sizes; the green cursor-block eye is
//                         the recognizable pixel)

import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const BG = "#0a0a0a"; // --ink, the app's page canvas

// [x, y, w, h, fill, opacity?]
const BODY = [
  // head fins
  [7, 2, 2, 1, "#4ADE80"], [10, 2, 2, 1, "#4ADE80"],
  // head slab
  [7, 3, 5, 1, "#3A3A3A"], [4, 4, 9, 1, "#3A3A3A"], [3, 5, 10, 1, "#3A3A3A"],
  [2, 6, 11, 1, "#3A3A3A"], [2, 7, 11, 1, "#3A3A3A"], [2, 8, 11, 1, "#3A3A3A"],
  [3, 9, 10, 1, "#3A3A3A"], [4, 10, 5, 1, "#3A3A3A"],
  // snout/jaw shading
  [1, 7, 1, 1, "#2E2E2E"], [2, 9, 4, 1, "#2E2E2E"],
  // neck
  [11, 9, 6, 1, "#3A3A3A"], [11, 10, 6, 1, "#3A3A3A"], [12, 11, 6, 1, "#3A3A3A"],
  // body mass
  [14, 10, 8, 1, "#3A3A3A"], [13, 11, 12, 1, "#3A3A3A"], [12, 12, 14, 1, "#3A3A3A"],
  [12, 13, 15, 1, "#3A3A3A"], [12, 14, 15, 1, "#3A3A3A"], [12, 15, 15, 1, "#3A3A3A"],
  [13, 16, 14, 1, "#3A3A3A"], [14, 17, 12, 1, "#3A3A3A"],
  // belly glow
  [13, 13, 2, 1, "#4ADE80", 0.55], [13, 14, 2, 1, "#4ADE80", 0.45],
  // foreleg + chest glow
  [11, 14, 3, 1, "#3A3A3A"], [9, 15, 3, 1, "#3A3A3A"],
  [8, 15, 1, 1, "#4ADE80", 0.75], [8, 16, 1, 1, "#4ADE80", 0.55],
  // legs + feet
  [14, 18, 3, 3, "#3A3A3A"], [14, 21, 4, 1, "#333333"],
  [14, 22, 1, 1, "#2C2C2C"], [16, 22, 1, 1, "#2C2C2C"],
  [21, 17, 4, 4, "#3A3A3A"], [21, 21, 5, 1, "#333333"],
  [21, 22, 1, 1, "#2C2C2C"], [23, 22, 1, 1, "#2C2C2C"], [25, 22, 1, 1, "#2C2C2C"],
  // eye — cursor-block pupil (signature)
  [5, 6, 3, 3, "#4ADE80"], [6, 7, 1, 1, "#2E2E2E", 0.5],
  // tail (raised variant), green half-block tip
  [25, 14, 3, 1, "#3A3A3A"], [27, 12, 3, 1, "#3A3A3A"], [29, 11, 3, 1, "#3A3A3A"],
  [31, 10, 2, 1, "#3A3A3A"], [32, 9, 1, 1, "#3A3A3A"], [32, 8, 1, 1, "#4ADE80"],
  // dorsal fins, lit (listening "signal meter" look)
  [15, 9, 1, 1, "#4ADE80"], [18, 8, 2, 2, "#4ADE80"], [21, 9, 1, 1, "#4ADE80"],
  [23, 10, 1, 1, "#4ADE80"], [25, 11, 1, 1, "#4ADE80"],
];

function rectsToSvg(rects) {
  return rects
    .map(
      ([x, y, w, h, fill, opacity]) =>
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${
          opacity !== undefined ? ` opacity="${opacity}"` : ""
        }/>`,
    )
    .join("");
}

// Full-body icon: 64×64 canvas, Bit centered (36×26 → pad 14/19).
const fullIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" shape-rendering="crispEdges"><rect width="64" height="64" fill="${BG}"/><g transform="translate(14,19)">${rectsToSvg(BODY)}</g></svg>`;

// Favicon: head crop (grid x1–13, y2–10) on a 16×16 canvas.
const HEAD = BODY.filter(([x, y]) => x <= 13 && y <= 10);
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" fill="${BG}"/><g transform="translate(1,2)">${rectsToSvg(HEAD)}</g></svg>`;

const jobs = [
  { svg: fullIcon, size: 192, out: "public/icon-192.png" },
  { svg: fullIcon, size: 512, out: "public/icon-512.png" },
  { svg: fullIcon, size: 180, out: "src/app/apple-icon.png" },
  { svg: favicon, size: 64, out: "src/app/icon.png" },
];

for (const { svg, size, out } of jobs) {
  const png = await sharp(Buffer.from(svg), { density: 72 })
    .resize(size, size, { kernel: "nearest" })
    .png()
    .toBuffer();
  writeFileSync(join(ROOT, out), png);
  console.log(`wrote ${out} (${size}×${size}, ${png.length} bytes)`);
}
