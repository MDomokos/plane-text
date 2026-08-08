#!/usr/bin/env node
// Plane Text: image to message.
//
//   node tools/encode-cli.js photo.jpg --cols 108 --codec braille -o out/msg.txt
//
// Also the seed of the bench harness: --sweep prints a table of grid sizes so
// character counts and dot resolutions can be compared without guessing.

import { writeFileSync } from 'node:fs';
import { loadImage } from './image.js';
import { encode } from '../src/encode.js';
import {
  CODEC, TRANSPORT_CEILING, DEFAULT_RAMP, DEFAULT_CODEC, INVERT_DEFAULT,
  MIN_ADVANCE_CELL_PX, MIN_ADVANCE_GLYPH_PX,
} from '../src/constants.js';
import { defaultCols, rowsFor, describe, legibleColsFor, maxColsFor, sizeRange } from '../src/sizing.js';

const NAMES = { braille: CODEC.BRAILLE, quadrant: CODEC.QUADRANT, ramp: CODEC.RAMP };
const CODEC_NAME = Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [v, k]));

// Three stale defaults, all fixed 2026-08-09, all the same shape of bug: a
// value chosen for one path and applied to another.
//
//   codec    was hardcoded 'braille' months after DEFAULT_CODEC became ramp
//   cols     was defaultCols(), computed for the default codec and then handed
//            to whatever codec the flag selected. Asking for braille got a
//            ramp-sized grid.
//   invert   was false while INVERT_DEFAULT is true, so the CLI emitted light
//            polarity while the app emits dark, and the tone curves are tuned
//            for dark only. Every message this tool produced was mistuned.
//
// `cols: null` is the fix for the second one: it cannot be resolved until the
// codec is known, so it is resolved after parsing rather than before.
function parseArgs(argv) {
  const a = {
    cols: null,
    codec: CODEC_NAME[DEFAULT_CODEC],
    out: null,
    sweep: false,
    invert: INVERT_DEFAULT,
    noDither: false,
    src: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--cols') a.cols = parseInt(argv[++i], 10);
    else if (t === '--codec') a.codec = argv[++i];
    else if (t === '-o' || t === '--out') a.out = argv[++i];
    else if (t === '--sweep') a.sweep = true;
    else if (t === '--invert') a.invert = true;
    else if (t === '--light') a.invert = false;
    else if (t === '--no-dither') a.noDither = true;
    else if (!t.startsWith('-')) a.src = t;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.src) {
  console.error('usage: encode-cli.js <image> [--cols N] [--codec braille|quadrant|ramp] [--invert] [--no-dither] [--sweep] [-o file]');
  process.exit(1);
}

const codec = NAMES[args.codec];
if (!codec) {
  console.error(`unknown codec "${args.codec}" -- expected braille, quadrant or ramp`);
  process.exit(1);
}

// Resolved here, not in the defaults, so --codec braille gets braille's column
// count rather than the default codec's. See parseArgs.
if (args.cols == null) args.cols = defaultCols(codec);

const { rgba, w, h } = loadImage(args.src);

if (args.sweep) {
  console.log(`source ${w}x${h}, codec ${args.codec}\n`);
  console.log('  cols  rows      dots   payload   message   util   fits unzoomed on');
  console.log('  ----  ----  --------  --------  --------  -----   -----------------');
  for (const cols of [40, 65, 78, 108, 150, 222, 355]) {
    const rows = rowsFor(cols, w, h, codec);
    const d = describe(cols, rows, codec);
    // From the constants, never a second copy. Hardcoding 5.0 and 3.6 here was
    // a duplicate of the legibility floors, and duplicated legibility figures
    // are how the last three of them drifted apart.
    const px = Math.round(cols * (codec === CODEC.RAMP ? MIN_ADVANCE_GLYPH_PX : MIN_ADVANCE_CELL_PX));
    const cap = cols <= legibleColsFor(codec) ? '' : '  (needs zoom)';
    console.log(
      `  ${String(cols).padStart(4)}  ${String(rows).padStart(4)}  ` +
        `${(d.dotsW + 'x' + d.dotsH).padStart(8)}  ${String(d.payloadChars).padStart(8)}  ` +
        `${String(d.messageChars).padStart(8)}  ${(d.utilisation * 100).toFixed(1).padStart(4)}%   ` +
        `${px}px wide${cap}`,
    );
  }
  const r = sizeRange();
  console.log(`\n  transport ceiling ${TRANSPORT_CEILING} (provisional, Test A re-promoted:`);
  console.log(`    the 7% utilisation that demoted it was braille at 108 landscape, not this)`);
  console.log(`  size slider, in characters, shared by every codec: ${r.minChars} .. ${r.maxChars}`);
  console.log(`    which is ${defaultCols(codec)} .. ${maxColsFor(codec)} columns for ${args.codec}`);
  console.log(`  legibility estimate for ${args.codec}: ${legibleColsFor(codec)} columns on a 390px phone`);
  console.log(`    (a warning, not a clamp. The slider is allowed past it.)`);
  process.exit(0);
}

const out = encode(rgba, w, h, {
  codec,
  cols: args.cols,
  invert: args.invert,
  useDither: !args.noDither,
  ramp: DEFAULT_RAMP,
});

for (const warning of out.warnings) console.error(`warning: ${warning}`);

const s = out.stats;
console.error(
  `${w}x${h} -> ${s.cols}x${s.rows} cells (${s.dotsW}x${s.dotsH} dots)\n` +
    `payload ${s.payloadChars}  wrapper ${s.wrapperChars}  message ${s.messageChars}  ` +
    `= ${((s.messageChars / TRANSPORT_CEILING) * 100).toFixed(1)}% of ceiling\n` +
    `dithered: ${s.dithered}  line-height: ${s.lineHeight}`,
);

if (args.out) {
  writeFileSync(args.out, out.message, 'utf8');
  console.error(`wrote ${args.out}`);
} else {
  process.stdout.write(out.message);
}
