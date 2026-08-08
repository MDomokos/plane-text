#!/usr/bin/env node
// Independent verification: take the serialised text, decode it back to dots
// with no reference to the encoder's internals, and rasterise. If the encoder
// has a bit-order or geometry bug, the picture comes out scrambled here.
import { writeFileSync } from 'node:fs';
import { loadImage } from './image.js';
import { encode } from '../src/encode.js';
import { CODEC } from '../src/constants.js';

const [src, colsArg, outPng] = process.argv.slice(2);
const cols = parseInt(colsArg || '108', 10);
const img = loadImage(src);
const out = encode(img.rgba, img.w, img.h, { codec: CODEC.BRAILLE, cols });

// Decode purely from the text.
const lines = out.message.split('\n').slice(2);   // skip magic + html head line
const art = out.lines;
const W = cols * 2, H = art.length * 4;
const bmp = new Uint8Array(W * H).fill(255);
const BIT = [[0,3],[1,4],[2,5],[6,7]];
art.forEach((line, cy) => {
  [...line].forEach((ch, cx) => {
    const byte = ch.charCodeAt(0) - 0x2800;
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) {
      if (byte & (1 << BIT[dy][dx])) bmp[(cy*4+dy)*W + (cx*2+dx)] = 0;
    }
  });
});
const header = Buffer.from(`P5\n${W} ${H}\n255\n`, 'ascii');
writeFileSync(outPng, Buffer.concat([header, Buffer.from(bmp)]));
console.error(`decoded ${cols}x${art.length} cells -> ${W}x${H} dots -> ${outPng}`);
