// Plane Text: generate the app icons.
//
//   npm run icons
//
// The mark is what the app makes: a coarse halftone of a lit sphere, one
// square per cell, size following tone. Drawn from one function so the SVG and
// the three PNGs cannot drift apart. The sixth instance of this project's
// standing bug would be an icon that stopped matching its own artefact.
//
// PNGs exist because iOS ignores manifest icons and wants an apple-touch-icon,
// and because a maskable icon needs its own art with the safe zone honoured
// (content inside the central ~60%, background full bleed).
//
// No dependencies: zlib and a CRC table are enough for an 8-bit RGB PNG.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'app');

const BG = [0x0b, 0x0d, 0x10];
const INK = [0xff, 0xff, 0xff];
const N = 9; // cells across the mark

// Tone at cell (i, j), 0..1. A lit sphere plus a floor gradient.
function tone(i, j) {
  const x = (i + 0.5) / N;
  const y = (j + 0.5) / N;
  const d = (x - 0.36) ** 2 + (y - 0.34) ** 2;
  const sphere = Math.exp(-d / 0.16);
  const floor = 0.18 * (1 - y);
  return Math.max(0, Math.min(1, 0.92 * sphere + floor));
}

// Cell squares as fractions of the mark box: [x, y, side], all 0..1.
function marks() {
  const out = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const t = tone(i, j);
      const side = (0.16 + 0.72 * t) / N;
      if (side * N < 0.2) continue;
      out.push([(i + 0.5) / N - side / 2, (j + 0.5) / N - side / 2, side]);
    }
  }
  return out;
}

function svg(inset) {
  const s = 512;
  const box = s * (1 - 2 * inset);
  const rects = marks()
    .map(([x, y, w]) => {
      const px = (v) => +(v).toFixed(2);
      return `<rect x="${px(s * inset + x * box)}" y="${px(s * inset + y * box)}" width="${px(w * box)}" height="${px(w * box)}"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}">`
    + `<title>Plane Text</title>`
    + `<rect width="${s}" height="${s}" fill="rgb(${BG})"/>`
    + `<g fill="rgb(${INK})">${rects}</g></svg>\n`;
}

function raster(size, inset) {
  const px = Buffer.alloc(size * size * 3);
  for (let i = 0; i < px.length; i += 3) { px[i] = BG[0]; px[i + 1] = BG[1]; px[i + 2] = BG[2]; }
  const box = size * (1 - 2 * inset);
  for (const [x, y, w] of marks()) {
    const x0 = Math.round(size * inset + x * box);
    const y0 = Math.round(size * inset + y * box);
    const side = Math.max(1, Math.round(w * box));
    for (let j = y0; j < y0 + side; j++) {
      if (j < 0 || j >= size) continue;
      for (let i = x0; i < x0 + side; i++) {
        if (i < 0 || i >= size) continue;
        const o = (j * size + i) * 3;
        px[o] = INK[0]; px[o + 1] = INK[1]; px[o + 2] = INK[2];
      }
    }
  }
  return png(size, size, px);
}

// --- minimal PNG ------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- write ------------------------------------------------------------------

const files = [
  ['icon.svg', Buffer.from(svg(0.12), 'utf8')],
  ['icon-192.png', raster(192, 0.12)],
  ['icon-512.png', raster(512, 0.12)],
  // Maskable. The safe zone is the central 80% circle, so the mark sits inside
  // the middle 60% and the background bleeds to every edge.
  ['icon-maskable-512.png', raster(512, 0.2)],
];

for (const [name, buf] of files) {
  writeFileSync(path.join(OUT, name), buf);
  console.log(`app/${name}: ${buf.length} bytes`);
}
