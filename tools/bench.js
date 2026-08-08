#!/usr/bin/env node
// Plane Text: the bench harness (spec 11.7, and a "build early" item that was
// never built).
//
//   node tools/bench.js photo1.jpg photo2.jpg              compare codecs
//   node tools/bench.js --sweep ramp photo1.jpg photo2.jpg tune a tone curve
//
// Fixed sample images through each encoder configuration, reporting character
// count and a perceptual score. The spec asks for exactly this and notes that
// "every ratio in this document is an estimate and should be replaced by a
// measurement". So far the estimates have been winning.
//
// THE SCORE IS TAKEN AT EQUAL DISPLAYED SIZE. Every codec is reconstructed and
// resampled to the width it will occupy on a 390px phone, then compared with
// the source at the same size. Comparing dots to cells in their own units
// measures nothing, because the phone shows both at the same width.
//
// One caveat, and it bounds every ramp number below: the reconstruction assumes
// each ramp glyph's real ink coverage matches its position in the ramp. That is
// what "calibrate the ramp to the font" (spec 5.7) is supposed to make true,
// and it is not built yet. So ramp scores here are an upper bound on a
// perfectly calibrated ramp, while braille and quadrant scores are exact: a dot
// is a dot. Read the gap accordingly.

import { loadImage } from './image.js';
import { encode } from '../src/encode.js';
import { toLuma } from '../src/tone.js';
import { fitToAspect } from '../src/fit.js';
import { reconstruct, toDisplay, ssim, rmse, rampHealth, gaussianBlur } from '../src/metrics.js';
import {
  CODEC, CAPTURE_ASPECT, TONE, INVERT_DEFAULT, PHONE_VIEWPORT_PX,
} from '../src/constants.js';
import { colsForChars } from '../src/sizing.js';

const NAMES = { [CODEC.BRAILLE]: 'braille', [CODEC.QUADRANT]: 'quadrant', [CODEC.RAMP]: 'ramp' };
const DISPLAY_W = PHONE_VIEWPORT_PX;
const DISPLAY_H = Math.round(PHONE_VIEWPORT_PX / CAPTURE_ASPECT);

function referenceOf(img) {
  const fitted = fitToAspect(img.rgba, img.w, img.h, CAPTURE_ASPECT, 0.48, 0.42);
  const luma = toLuma(fitted.rgba, fitted.w, fitted.h);
  return toDisplay({ data: luma, w: fitted.w, h: fitted.h }, DISPLAY_W, DISPLAY_H);
}

// sigma is in CSS px at the displayed size. See gaussianBlur for why this is a
// physical quantity and not a tuning knob.
const SIGMA_DEFAULT = 0.75;

function score(img, ref, { codec, cols, tone, sigma = SIGMA_DEFAULT }) {
  const out = encode(img.rgba, img.w, img.h, {
    codec, cols, tone, focusX: 0.48, focusY: 0.42,
  });
  const rec = gaussianBlur(toDisplay(reconstruct(out.grid, INVERT_DEFAULT), DISPLAY_W, DISPLAY_H), sigma);
  const refB = gaussianBlur(ref, sigma);
  const s = ssim(refB.data, rec.data, DISPLAY_W, DISPLAY_H);
  return {
    codec, cols,
    chars: out.stats.payloadChars,
    ssim: s.ssim,
    structure: s.structure,
    rmse: rmse(refB.data, rec.data),
    ink: out.stats.ink,
    health: codec === CODEC.RAMP ? rampHealth(out.grid) : null,
    warnings: out.warnings,
  };
}

const argv = process.argv.slice(2);
let sweep = null;
const paths = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--sweep') sweep = argv[++i];
  else paths.push(argv[i]);
}
if (!paths.length) {
  console.error('usage: node tools/bench.js [--sweep ramp|braille] image...');
  process.exit(1);
}

const images = paths.map((p) => {
  const img = loadImage(p);
  return { ...img, label: p.split('/').pop(), ref: referenceOf(loadImage(p)) };
});

const pad = (v, n) => String(v).padStart(n);
const pct = (v) => (v * 100).toFixed(1) + '%';

// ---------------------------------------------------------------------------
if (!sweep) {
  const TARGET = 15100;
  console.log(`\nCODEC COMPARISON at ~${TARGET.toLocaleString()} characters, scored at ${DISPLAY_W}x${DISPLAY_H} displayed px\n`);
  for (const img of images) {
    console.log(`  ${img.label}  (${img.w}x${img.h})`);
    console.log(`    ${'codec'.padEnd(9)}${pad('cols', 5)}${pad('chars', 8)}${pad('ssim', 8)}${pad('struct', 8)}${pad('rmse', 8)}   ramp health`);
    const rows = [];
    for (const codec of [CODEC.RAMP, CODEC.BRAILLE, CODEC.QUADRANT]) {
      const cols = colsForChars(codec, TARGET, CAPTURE_ASPECT);
      rows.push(score(img, img.ref, { codec, cols, tone: null }));
    }
    const best = rows.reduce((a, b) => (b.ssim > a.ssim ? b : a));
    for (const r of rows) {
      const h = r.health
        ? `${r.health.levels}/${r.health.levelsAvailable} levels, H=${r.health.entropy.toFixed(2)}, clipped ${pct(r.health.clipped)}`
        : `ink ${pct(r.ink)}`;
      console.log(
        `    ${NAMES[r.codec].padEnd(9)}${pad(r.cols, 5)}${pad(r.chars, 8)}` +
        `${pad(r.ssim.toFixed(4), 8)}${pad(r.structure.toFixed(4), 8)}${pad(r.rmse.toFixed(4), 8)}   ${h}` +
        (r === best ? '  <-- best' : ''),
      );
    }
    console.log('');
  }
  // -------------------------------------------------------------------------
  // The crossover.
  //
  // Braille spends its characters on more, coarser samples; ramp spends them on
  // fewer, more accurate ones. So the ranking depends on how much the eye
  // integrates the halftone, and a single score at a single blur is a claim
  // disguised as a measurement. Sweeping the blur shows where the answer
  // changes, and whether that point is near a real viewing distance.
  console.log(`  CROSSOVER: SSIM vs viewing blur, mean across ${images.length} image(s)\n`);
  console.log(`    ${'sigma'.padEnd(8)}${pad('ramp', 9)}${pad('braille', 9)}${pad('quadrant', 10)}   winner`);
  const sigmas = [0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];
  let crossed = null;
  for (const sigma of sigmas) {
    const row = {};
    for (const codec of [CODEC.RAMP, CODEC.BRAILLE, CODEC.QUADRANT]) {
      const cols = colsForChars(codec, TARGET, CAPTURE_ASPECT);
      row[codec] = images.reduce((a, img) => a + score(img, img.ref, { codec, cols, tone: null, sigma }).ssim, 0) / images.length;
    }
    const win = [CODEC.RAMP, CODEC.BRAILLE, CODEC.QUADRANT].reduce((a, b) => (row[b] > row[a] ? b : a));
    if (crossed === null && win !== CODEC.RAMP) crossed = sigma;
    const band = sigma >= 0.5 && sigma <= 1.0 ? '  <-- plausible viewing band' : '';
    console.log(
      `    ${String(sigma).padEnd(8)}${pad(row[CODEC.RAMP].toFixed(4), 9)}` +
      `${pad(row[CODEC.BRAILLE].toFixed(4), 9)}${pad(row[CODEC.QUADRANT].toFixed(4), 10)}   ${NAMES[win]}${band}`,
    );
  }
  console.log('');
  console.log(crossed === null
    ? '  Ramp wins at every blur tested, including one heavy enough that individual\n'
      + '  dots are gone. That is a stronger result than the ramp default needed.'
    : `  Ramp stops winning at sigma ${crossed}. The physically plausible band is\n`
      + '  0.5-1.0 CSS px at arm\'s length, so check which side of it that falls on.');
  console.log('');
  console.log('  Ramp scores assume a perfectly calibrated ramp (spec 5.7, not built).');
  console.log('  Braille and quadrant scores are exact.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Tone sweep. The default codec's curve has never been measured against
// anything; this is what replaces "reasoned for the ramp codec" with a number.
const codec = sweep === 'braille' ? CODEC.BRAILLE : sweep === 'quadrant' ? CODEC.QUADRANT : CODEC.RAMP;
const cols = colsForChars(codec, 15100, CAPTURE_ASPECT);
const base = TONE[codec];

const variants = [];
for (const clip of [[0, 100], [1, 99], [2, 98], [4, 96], [6, 94]]) {
  for (const g of [1.0, 1.1, 1.2, 1.35]) {
    for (const c of [1.0, 0.92, 0.85]) {
      for (const u of [0.3, 0.6, 0.9]) {
        variants.push({ unsharp: u, clipLo: clip[0], clipHi: clip[1], gamma: g, compress: c });
      }
    }
  }
}

console.log(`\nTONE SWEEP: ${NAMES[codec]} at ${cols} cols, ${variants.length} variants, ${images.length} image(s)`);
console.log('Ranked by mean SSIM structure across all images: structure is invariant to');
console.log('linear brightness and contrast changes, so it rewards a curve that remaps');
console.log('levels while preserving detail and punishes one that crushes regions flat.\n');

const results = variants.map((tone) => {
  const per = images.map((img) => score(img, img.ref, { codec, cols, tone }));
  const mean = (k) => per.reduce((a, r) => a + r[k], 0) / per.length;
  const meanH = (k) => per.reduce((a, r) => a + (r.health ? r.health[k] : 0), 0) / per.length;
  return {
    tone,
    ssim: mean('ssim'),
    structure: mean('structure'),
    rmse: mean('rmse'),
    entropy: meanH('entropy'),
    clipped: meanH('clipped'),
    spread: Math.max(...per.map((r) => r.ssim)) - Math.min(...per.map((r) => r.ssim)),
  };
});

// Ranking by structure alone is wrong, and the first run of this sweep proved
// it. Structure is invariant to brightness and contrast, which is why it does
// not punish a tone curve for remapping levels. That same invariance means it
// does not punish clipping either, so the top of the list filled up with curves
// that expand contrast until a quarter of the cells are pinned to an end glyph.
// High structure, flat picture.
//
// There is no single scalar here, so the sweep reports the trade rather than
// hiding it in a sort order. Four questions, four winners:
//   structure   most detail preserved, ignoring brightness and contrast
//   ssim        closest to the original overall, punishes clipping
//   clipped     fewest cells thrown away on the end glyphs
//   spread      most consistent across subjects, the one that generalises
//
// A balanced pick is offered too: best structure subject to not destroying
// more than 15% of cells and not varying more than 0.03 between subjects.
results.sort((a, b) => b.structure - a.structure);
const isBase = (t) => JSON.stringify(t) === JSON.stringify(base);
const baseRank = results.findIndex((r) => isBase(r.tone));
const bestBy = (k, dir = 1) => results.reduce((a, b) => ((b[k] - a[k]) * dir > 0 ? b : a));
const balanced = results.filter((r) => r.clipped <= 0.15 && r.spread <= 0.03)
  .reduce((a, b) => (!a || b.structure > a.structure ? b : a), null);

const head = `${'clip'.padEnd(9)}${'gam'.padEnd(6)}${'comp'.padEnd(6)}${'unsh'.padEnd(6)}` +
  `${pad('struct', 8)}${pad('ssim', 8)}${pad('rmse', 8)}${pad('H', 7)}${pad('clip%', 8)}${pad('spread', 8)}`;
console.log('  ' + head);
const show = (r, tag) => console.log(
  '  ' + `${(r.tone.clipLo + '/' + r.tone.clipHi).padEnd(9)}${String(r.tone.gamma).padEnd(6)}` +
  `${String(r.tone.compress).padEnd(6)}${String(r.tone.unsharp).padEnd(6)}` +
  `${pad(r.structure.toFixed(4), 8)}${pad(r.ssim.toFixed(4), 8)}${pad(r.rmse.toFixed(4), 8)}` +
  `${pad(r.entropy.toFixed(3), 7)}${pad(pct(r.clipped), 8)}${pad(r.spread.toFixed(4), 8)}${tag || ''}`,
);
results.slice(0, 12).forEach((r) => show(r, isBase(r.tone) ? '   <-- CURRENT DEFAULT' : ''));
if (baseRank >= 12) {
  console.log('  ...');
  show(results[baseRank], `   <-- CURRENT DEFAULT, rank ${baseRank + 1}/${results.length}`);
}
console.log('');
console.log('  Best by each criterion:');
show(bestBy('structure'), '   <-- most detail preserved');
show(bestBy('ssim'), '   <-- closest to the original');
show(bestBy('clipped', -1), '   <-- fewest cells thrown away');
show(bestBy('spread', -1), '   <-- most consistent across subjects');
if (balanced) show(balanced, '   <-- BALANCED: best structure with clipped<=15% and spread<=0.03');
console.log('');
console.log('  spread = SSIM range across the images. A large spread means the curve suits');
console.log('  one subject and not the other, which is worth more than a small score win --');
console.log('  a default has to work on a photo nobody has taken yet.');
console.log('  clipped = share of cells pinned to the first or last glyph. Those cells carry');
console.log('  no gradient at all, which is the ramp\'s version of "a third of the frame');
console.log('  carrying nothing" that the ink-coverage band was invented to catch.\n');
