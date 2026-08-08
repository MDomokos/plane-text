#!/usr/bin/env node
// Plane Text: aspect crop (spec 11.4).
//
// Crop is listed as delivering more than any other single feature. The reason
// is sharper than when that was written: with the grid capped at 108 columns by
// the viewport, cropping is one of the few remaining ways to spend resolution
// on the subject instead of on the surroundings.
//
//   node tools/crop.js in.jpg 16:9 out.ppm [--focus 0.48,0.42]
//
// --focus is the point to keep, in 0..1 fractions of width and height. It
// defaults to centre. The crop window is the largest rectangle of the target
// aspect that fits, positioned so the focal point stays put where possible and
// clamped to the image edges otherwise.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadImage } from './image.js';

export function cropToAspect(img, targetAspect, focusX = 0.5, focusY = 0.5) {
  const { rgba, w, h } = img;
  const srcAspect = w / h;

  let cw, ch;
  if (srcAspect > targetAspect) {
    ch = h;
    cw = Math.round(h * targetAspect);
  } else {
    cw = w;
    ch = Math.round(w / targetAspect);
  }

  let x0 = Math.round(focusX * w - cw / 2);
  let y0 = Math.round(focusY * h - ch / 2);
  x0 = Math.max(0, Math.min(w - cw, x0));
  y0 = Math.max(0, Math.min(h - ch, y0));

  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const src = ((y0 + y) * w + x0) * 4;
    out.set(rgba.subarray(src, src + cw * 4), y * cw * 4);
  }
  return { rgba: out, w: cw, h: ch, from: { x0, y0, cw, ch } };
}

export function writePPM(path, img) {
  const header = Buffer.from(`P6\n${img.w} ${img.h}\n255\n`, 'ascii');
  const body = Buffer.alloc(img.w * img.h * 3);
  for (let i = 0; i < img.w * img.h; i++) {
    body[i * 3] = img.rgba[i * 4];
    body[i * 3 + 1] = img.rgba[i * 4 + 1];
    body[i * 3 + 2] = img.rgba[i * 4 + 2];
  }
  writeFileSync(path, Buffer.concat([header, body]));
}

// CLI.
//
// The usual `import.meta.url === 'file://' + process.argv[1]` guard is wrong on
// any path containing a space: import.meta.url percent-encodes it, argv does
// not. This project lives in a folder called "Plane Text", and the guard failed
// there with no output and no error.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const [src, aspectStr, out] = argv.filter((a) => !a.startsWith('-'));
  let fx = 0.5, fy = 0.5;
  const fi = argv.indexOf('--focus');
  if (fi !== -1) [fx, fy] = argv[fi + 1].split(',').map(Number);

  if (!src || !aspectStr || !out) {
    console.error('usage: crop.js <image> <W:H> <out.ppm> [--focus x,y]');
    process.exit(1);
  }
  const [aw, ah] = aspectStr.split(':').map(Number);
  const img = loadImage(src);
  const cropped = cropToAspect(img, aw / ah, fx, fy);
  writePPM(out, cropped);
  console.error(
    `${img.w}x${img.h} -> ${cropped.w}x${cropped.h} (${aspectStr}) ` +
      `from (${cropped.from.x0},${cropped.from.y0}) -> ${out}`,
  );
}
