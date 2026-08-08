import { loadImage } from './tools/image.js';
import { encode } from './src/encode.js';
import { CODEC } from './src/constants.js';
import { writeFileSync } from 'node:fs';

const specs = [
  ['images/koala.jpg', 65], ['images/koala.jpg', 80], ['images/koala.jpg', 103],
  ['images/selfie-nature-4-1024x683.jpg', 80],
  ['images/1977-dodge-macho-power-wagon-7-2936990200.jpg', 103],
];
const out = {};
for (const [src, cols] of specs) {
  const img = await loadImage(src);
  const r = encode(img.rgba, img.w, img.h, { cols, codec: CODEC.RAMP, aspect: img.w / img.h, invert: true });
  const body = r.lines.join('\n');
  out[`${src}|${cols}`] = { cols, rows: r.lines.length, body, bytes: Buffer.byteLength(body, 'utf8'), warnings: r.warnings, stats: r.stats };
  console.log(src, cols, 'rows', r.lines.length, 'bytes', Buffer.byteLength(body,'utf8'), 'warn', JSON.stringify(r.warnings));
}
writeFileSync('/tmp/pt/blocks.json', JSON.stringify(out));
