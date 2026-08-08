// Plane Text: the encode pipeline (spec 4.5, 11.7).
//
//   capture -> luminance -> unsharp -> auto-levels -> gamma -> contrast
//           -> downscale to dot grid -> dither -> cell grid
//           -> serialise, one row per line -> <pre> wrapper
//
// What is absent: no budget-driven retry loop. Grid size comes from the
// viewport, not from a character count, so there is nothing to iterate
// against. Character count is measured once and reported, never targeted.

import {
  CODEC, DEFAULT_CODEC, DEFAULT_RAMP, TONE, DITHER_DEFAULT, INK_TARGET, CELL_DOTS,
  INVERT_DEFAULT, RAMP_CLIP_MAX, RAMP_ENTROPY_MIN,
} from './constants.js';
import { rampHealth } from './metrics.js';
import { toLuma, unsharp, measureLevels, applyLevels, gamma } from './tone.js';
import { buildGrid, gridToRows } from './cells.js';
import { buildMessage, wrapperCost } from './wrap.js';
import { defaultCols, rowsFor, describe, legibleColsFor } from './sizing.js';
import { fitToAspect } from './fit.js';
import { CAPTURE_ASPECT } from './constants.js';

// Gentle contrast compression toward mid grey. For a 1-bit codec this is the
// opposite of what auto-levels wants, and it is correct: dot density carries
// tone, so values pushed to the extremes become flat regions with no texture.
function compress(luma, amount) {
  if (amount >= 1) return luma;
  const offset = (1 - amount) / 2;
  const out = new Float64Array(luma.length);
  for (let i = 0; i < luma.length; i++) out[i] = luma[i] * amount + offset;
  return out;
}

// Fraction of dots that are ink. A cheap objective check that the tone curve
// is not crushing: a well-exposed 1-bit halftone of an average photo lands
// near 40-45%. The old defaults produced 32%, meaning a third of the frame was
// flat white and carrying nothing.
export function inkCoverage(grid) {
  const cell = CELL_DOTS[grid.codec];
  if (grid.codec === CODEC.RAMP) {
    let sum = 0;
    for (const v of grid.values) sum += v / (grid.ramp.length - 1);
    return sum / grid.values.length;
  }
  const bitsPerCell = cell.w * cell.h;
  let set = 0;
  for (const v of grid.values) {
    let b = v;
    while (b) { set += b & 1; b >>= 1; }
  }
  return set / (grid.values.length * bitsPerCell);
}

export function encode(rgba, srcW, srcH, opts = {}) {
  const {
    codec = DEFAULT_CODEC,
    cols = defaultCols(opts.codec ?? DEFAULT_CODEC),
    ramp = DEFAULT_RAMP,
    invert = INVERT_DEFAULT,
    useDither = true,
    ditherMode = DITHER_DEFAULT,
    tone: toneOverride = null,
    title = 'Plane Text',
    aspect = CAPTURE_ASPECT,
    focusX = 0.5,
    focusY = 0.5,
  } = opts;

  const tone = { ...TONE[codec], ...(toneOverride || {}) };
  const warnings = [];

  // The legibility cap warns, it does not clamp (2026-08-09). Its premise, that
  // a ramp glyph fails legibility sooner than a braille cell does, was
  // disconfirmed at 130 columns / 3.16 px, and the slider now runs on a shared
  // character range with no per-codec track. The physics is still real, so the
  // user is told; they are no longer stopped.
  const cap = legibleColsFor(codec);
  if (cols > cap) {
    warnings.push(
      `${cols} columns is past the ${cap}-column legibility estimate for this codec. ` +
        `The recipient will need to zoom. Not an error: the size slider is ` +
        `allowed past this point.`,
    );
  }

  // Crop to the fixed capture aspect first. Everything downstream (row count,
  // character cost, the shim's target ratio) then follows from one constant
  // instead of from whatever shape the source happened to be.
  const fitted = fitToAspect(rgba, srcW, srcH, aspect, focusX, focusY);
  rgba = fitted.rgba; srcW = fitted.w; srcH = fitted.h;

  let luma = toLuma(rgba, srcW, srcH);
  if (tone.unsharp) luma = unsharp(luma, srcW, srcH, tone.unsharp, 1);

  // Auto-levels, with the endpoints optionally supplied by the caller.
  //
  // `opts.levels = { lo, hi }` skips the percentile pass entirely. Only the
  // live viewfinder uses it (spec 5.8): it smooths the endpoints with an EMA
  // across frames so the preview does not pulse as the subject moves, which
  // needs endpoints that outlive a single frame. It is also the expensive step
  // -- a full sort of the luma buffer -- so skipping it on most frames is where
  // the frame budget comes back.
  //
  // A still capture must NOT pass this. Spec 5.8: "capture uses the still
  // image's own un-smoothed levels, computed fresh at full resolution. The
  // preview approximates; the capture is correct." Default is undefined, so
  // every existing caller measures as before.
  //
  // Note the endpoints live in post-unsharp space, which is why they are
  // reported back rather than left for the caller to recompute. Feeding an EMA
  // from a differently-derived measurement would drift.
  // `opts.reportLevels` is the other half, and it exists because measuring and
  // applying are genuinely separate needs for a smoothed preview. A viewfinder
  // frame wants to be RENDERED with the smoothed endpoints and still learn what
  // this frame's own endpoints were, or the EMA has nothing to average. Without
  // this flag the only way to feed it is to render an unsmoothed frame
  // periodically, which pulses -- the exact artefact the smoothing is for.
  const supplied = Boolean(opts.levels && Number.isFinite(opts.levels.lo) && Number.isFinite(opts.levels.hi));
  const rawLevels = (!supplied || opts.reportLevels)
    ? measureLevels(luma, tone.clipLo, tone.clipHi)
    : null;
  const levels = supplied ? { lo: opts.levels.lo, hi: opts.levels.hi } : rawLevels;
  luma = applyLevels(luma, levels.lo, levels.hi);

  if (tone.gamma !== 1) luma = gamma(luma, tone.gamma);
  luma = compress(luma, tone.compress);

  // Polarity. The dot is the foreground colour, so on a dark ground a dot must
  // mark a BRIGHT source pixel. Flipping only the CSS gives a negative, the bug
  // this line fixes. Done after the tone chain and before quantisation so that
  // dithering distributes error in the same space the dots live in.
  if (invert) {
    const flipped = new Float64Array(luma.length);
    for (let i = 0; i < luma.length; i++) flipped[i] = 1 - luma[i];
    luma = flipped;
  }

  const rows = rowsFor(cols, srcW, srcH, codec);
  const grid = buildGrid(luma, srcW, srcH, { codec, cols, rows, ramp, useDither, ditherMode });
  const lines = gridToRows(grid);
  // The ramp goes to the wrapper as well as to the grid: it is the one field on
  // the header line that cannot be inferred from the rows, because coverage
  // order is a measurement and not a property of the characters (wire.js).
  const message = buildMessage(lines, { codec, cols, rows, invert, ramp, title });

  // Coverage as rendered, and normalised back to the light-polarity sense so
  // the band means the same thing in both modes. Flipping polarity turns x
  // into exactly 1-x, so without this the check inverts along with the image.
  const ink = inkCoverage(grid);
  const inkTone = invert ? 1 - ink : ink;

  // Health check, per codec. Applying the dot-coverage band to a ramp was
  // checking the wrong quantity: inkCoverage returns mean glyph index there,
  // and the 30-60% band was derived for the fraction of dots inked. Two
  // ordinary photos landed at 30.7% and 59.1%, both edges of a band that meant
  // nothing for them.
  //
  // The ramp's failure is not using the levels it has, so measure that instead.
  let health = null;
  if (codec === CODEC.RAMP) {
    health = rampHealth(grid);
    if (health.clipped > RAMP_CLIP_MAX) {
      warnings.push(
        `${(health.clipped * 100).toFixed(1)}% of cells are pinned to the first or last ` +
          `glyph (limit ${RAMP_CLIP_MAX * 100}%) -- those cells carry no gradient.`,
      );
    }
    if (health.entropy < RAMP_ENTROPY_MIN) {
      warnings.push(
        `ramp level occupancy ${health.entropy.toFixed(2)} is below ${RAMP_ENTROPY_MIN} ` +
          `(${health.levels} of ${health.levelsAvailable} glyphs in real use) -- ` +
          `the ramp is effectively shorter than it claims to be.`,
      );
    }
  } else if (inkTone < INK_TARGET[0] || inkTone > INK_TARGET[1]) {
    warnings.push(
      `tone coverage ${(inkTone * 100).toFixed(1)}% is outside the healthy ` +
        `${INK_TARGET[0] * 100}-${INK_TARGET[1] * 100}% band. The tone curve may be crushing.`,
    );
  }

  return {
    message,
    lines,
    grid,
    warnings,
    stats: {
      ...describe(cols, rows, codec),
      wrapperChars: wrapperCost(lines, { codec, cols, rows, invert, ramp, title }),
      cropped: fitted.cropped,
      aspect,
      messageChars: message.length,
      dithered: grid.dithered,
      ditherMode: grid.dithered ? ditherMode : 'none',
      ink,
      inkTone,
      health,
      invert,
      tone,
      // The clip endpoints actually used, in post-unsharp space, and whether
      // they were measured here or handed in. The viewfinder's EMA reads these.
      levels,
      levelsSupplied: supplied,
      // This frame's own endpoints, whether or not they were the ones used.
      // null when nothing was measured. The viewfinder's EMA reads this.
      rawLevels,
    },
  };
}
