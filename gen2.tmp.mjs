import { loadImage } from './tools/image.js';
import { encode } from './src/encode.js';
import { CODEC } from './src/constants.js';
import { writeFileSync } from 'node:fs';
const A = 0.61;
const specs = [
  ['koala','images/koala.jpg', 65, 0.61, 't65'],
  ['koala','images/koala.jpg', 65, 1.00, 'o65'],
  ['koala','images/koala.jpg', 103, 0.61, 't103'],
  ['truck','images/1977-dodge-macho-power-wagon-7-2936990200.jpg', 103, 0.61, 't103'],
  ['nature','images/selfie-nature-4-1024x683.jpg', 80, 0.61, 't80'],
];
const out = [];
for (const [name, src, cols, lh, cls] of specs) {
  const img = await loadImage(src);
  const aspect = (img.w / img.h) * (lh / A);
  const r = encode(img.rgba, img.w, img.h, { cols, codec: CODEC.RAMP, aspect, invert: true });
  const body = r.lines.join('\n');
  out.push({ name, src, cols, lh, cls, rows: r.lines.length, body, bytes: Buffer.byteLength(body,'utf8') });
  console.log(name, cols, 'lh', lh, 'rows', r.lines.length, 'bytes', Buffer.byteLength(body,'utf8'));
}
writeFileSync('/tmp/pt/blocks.json', JSON.stringify(out));
