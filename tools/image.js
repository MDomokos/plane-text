// Minimal dependency-free image decoding for the Node tools.
//
// No npm dependencies: this project has to be auditable and has to keep working
// offline. Supports BMP and PPM directly, and shells out to Python/Pillow for
// anything else if it is available.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function loadImage(path) {
  const buf = readFileSync(path);
  if (buf[0] === 0x42 && buf[1] === 0x4d) return decodeBMP(buf);
  if (buf[0] === 0x50 && (buf[1] === 0x36 || buf[1] === 0x35)) return decodePNM(buf);
  return viaPython(path);
}

function decodePNM(buf) {
  // P6 (binary RGB) and P5 (binary grey).
  const type = buf[1];
  let pos = 2;
  const fields = [];
  while (fields.length < 3) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (buf[pos] === 0x23) {
      while (buf[pos] !== 0x0a) pos++;
      continue;
    }
    let tok = '';
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) tok += String.fromCharCode(buf[pos++]);
    fields.push(parseInt(tok, 10));
  }
  pos++;
  const [w, h] = fields;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const stride = type === 0x36 ? 3 : 1;
  for (let i = 0; i < w * h; i++) {
    const s = pos + i * stride;
    const r = buf[s];
    const g = stride === 3 ? buf[s + 1] : r;
    const b = stride === 3 ? buf[s + 2] : r;
    rgba.set([r, g, b, 255], i * 4);
  }
  return { rgba, w, h };
}

function decodeBMP(buf) {
  const dataOffset = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  const hRaw = buf.readInt32LE(22);
  const h = Math.abs(hRaw);
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw new Error(`BMP must be 24 or 32 bpp, got ${bpp}`);
  const bytes = bpp / 8;
  const rowSize = Math.floor((bpp * w + 31) / 32) * 4;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcY = hRaw > 0 ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const s = dataOffset + srcY * rowSize + x * bytes;
      const d = (y * w + x) * 4;
      rgba[d] = buf[s + 2];
      rgba[d + 1] = buf[s + 1];
      rgba[d + 2] = buf[s];
      rgba[d + 3] = 255;
    }
  }
  return { rgba, w, h };
}

function viaPython(path) {
  const dir = mkdtempSync(join(tmpdir(), 'txcam-'));
  const out = join(dir, 'x.ppm');
  try {
    execFileSync('python3', [
      '-c',
      'import sys;from PIL import Image;Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2])',
      path,
      out,
    ]);
  } catch (e) {
    throw new Error(
      `cannot decode ${path}. Built-in support covers BMP and PPM only; ` +
        `anything else needs python3 with Pillow installed.`,
    );
  }
  return decodePNM(readFileSync(out));
}

// Write a PPM, for eyeballing intermediate stages.
export function savePGM(path, luma, w, h) {
  const header = Buffer.from(`P5\n${w} ${h}\n255\n`, 'ascii');
  const body = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) body[i] = Math.round(Math.min(1, Math.max(0, luma[i])) * 255);
  writeFileSync(path, Buffer.concat([header, body]));
}
