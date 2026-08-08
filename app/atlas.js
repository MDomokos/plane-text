// Plane Text: the glyph atlas (spec 5.8).
//
// A 120x90 preview at 30fps is 324,000 fillText calls a second, and mobile
// Safari will not do it. fillText has to run shaping and rasterisation on every
// call; drawImage from a warm canvas does not. So every glyph the codec can
// emit is rendered once into a one-row atlas, and a frame becomes one
// drawImage per cell.
//
// The architecture is not speculative -- it is what VectorCamera ships, and it
// holds 30fps on mid-range Android (teardown 4). What has to differ is the
// atlas CONSTRUCTION, and the differences are not cosmetic. Spec 5.7 lists four
// rules, all learned from that teardown, and this file exists to obey them:
//
//   1. ANTIALIASING ON, and the alpha channel is the point. VectorCamera sets
//      isAntiAlias=false and blits with a binary keying test, so no coverage
//      information survives anywhere in its pipeline. Its atlas cannot express
//      a half-covered cell. Canvas gives us AA for free and we must not throw
//      it away by thresholding, tinting through a keying test, or drawing the
//      atlas with imageSmoothingEnabled off at a fractional scale.
//   2. MEASURE EACH GLYPH'S ADVANCE AND CENTRE IT. VectorCamera draws
//      left-aligned at i*cellWidth with no clipping, so any glyph wider than
//      the cell bleeds into its neighbour IN THE ATLAS -- a corruption that is
//      then blitted faithfully forever after.
//   3. PAD ABOVE AND BELOW THE BASELINE. Its atlas is exactly cellHeight tall
//      with the baseline at cellHeight-1, so every descender (g p y q ,) is
//      silently chopped.
//   4. EXPECT 2 AND 3 TO HAVE SHAPED ANY RAMP YOU INHERIT. VectorCamera's
//      shipped ramps are narrow, ascender-free glyphs throughout. That looks
//      like taste and is at least partly a bug.
//
// Rule 3 is handled by placing the baseline where CSS would place it in a line
// box of this height, rather than at the bottom of the cell. That has a second
// benefit worth stating plainly: the atlas then renders each glyph in the same
// position the <pre> on compose renders it, so the canvas preview and the real
// text render agree. They are two renderers of one grid, and this is the line
// that keeps them from disagreeing.

import { CODEC } from '../src/constants.js';
import { QUADRANT_CHARS } from '../src/cells.js';
import { baseLineHeight } from '../src/sizing.js';

// Keep a few atlases. An orientation change or a style swap invalidates the
// current one, and re-rendering ~256 glyphs is a few milliseconds we would
// rather not spend twice on a rotate-and-rotate-back.
const CACHE_LIMIT = 4;
const cache = new Map();

// The full glyph set a codec can emit, indexed exactly as grid.values indexes
// it. This mirrors gridToRows() in src/cells.js and must not drift from it:
// braille is 0x2800+value, quadrant is QUADRANT_CHARS[value], ramp is
// ramp[value]. If those three lines ever disagree the picture is scrambled
// per-cell while staying globally plausible, which is this project's signature
// failure mode.
export function glyphsFor(codec, ramp) {
  if (codec === CODEC.BRAILLE) {
    const out = new Array(256);
    for (let i = 0; i < 256; i++) out[i] = String.fromCharCode(0x2800 + i);
    return out;
  }
  if (codec === CODEC.QUADRANT) return [...QUADRANT_CHARS];
  // Named rather than defaulted. An unknown codec falling through to the ramp
  // branch produces a plausible atlas of the wrong glyphs, which is a picture
  // that renders and is wrong -- the failure this project spends its comments
  // on. `CODEC.WEBP` is a real member of the enum and lands here.
  if (codec !== CODEC.RAMP) throw new Error(`no glyph set for codec ${codec}`);
  if (!ramp) throw new Error('the ramp codec needs a ramp');
  return [...ramp];
}

// The advance of a codec's own glyphs in this font, as a fraction of the font
// size. Needed BEFORE the atlas is built, because the fit has to know how wide
// a cell is before it can choose a font size to build the atlas at.
//
// Measured on the codec's own charset and not on a latin 'M'. Advance is a
// property of the charset, not of the device: latin measures 0.6001 on a Pixel
// and 0.6002 on an iPad, while Block Elements measures 0.7080 and 0.6021.
// Measuring the wrong charset reproduces exactly the bug that ADVANCE_CSS was
// split per codec to fix.
//
// Ratios are measured at a large reference size and divided, because a font
// hinted at 9px does not scale linearly and the error shows up as a grid that
// drifts a pixel every twenty columns.
const advanceCache = new Map();
export function measureAdvance(codec, ramp, font, refSize = 200) {
  const key = `${codec}|${ramp || '-'}|${font}|${refSize}`;
  const hit = advanceCache.get(key);
  if (hit !== undefined) return hit;

  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${refSize}px ${font}`;
  ctx.fontKerning = 'none';
  let widest = 0;
  for (const g of glyphsFor(codec, ramp)) {
    const w = ctx.measureText(g).width;
    if (w > widest) widest = w;
  }
  const ratio = widest > 0 ? widest / refSize : 0.6;
  advanceCache.set(key, ratio);
  return ratio;
}

// Where CSS would put the baseline inside a line box of `cellH`.
//
// A line box distributes its leading -- the difference between the line height
// and the font's own ascent+descent -- equally above and below, and the
// baseline sits at halfLeading + ascent from the top. Getting this from the
// font's real metrics rather than from a fraction of the font size is what
// makes the atlas agree with a <pre> instead of merely looking similar.
//
// fontBoundingBox* is present in Chrome 87+ and Safari 11.1+. The fallback is
// the conventional 0.8/0.2 split, which is close enough for a preview and is
// flagged on the returned object so a caller can tell.
function baselineIn(ctx, cellH) {
  const m = ctx.measureText('Mg');
  let ascent = m.fontBoundingBoxAscent;
  let descent = m.fontBoundingBoxDescent;
  let measured = true;
  if (!Number.isFinite(ascent) || !Number.isFinite(descent) || ascent <= 0) {
    const size = parseFloat(ctx.font) || cellH;
    ascent = size * 0.8;
    descent = size * 0.2;
    measured = false;
  }
  const halfLeading = (cellH - (ascent + descent)) / 2;
  return { y: halfLeading + ascent, ascent, descent, measured };
}

// Build (or fetch) an atlas.
//
//   codec     which glyph set
//   ramp      the ramp string, for CODEC.RAMP
//   fontSize  CSS px, the same number art.js would set on the <pre>
//   dpr       device pixel ratio; the atlas is built at device resolution so
//             the blit is 1:1 and never resamples a glyph
//   font      the font stack, normally var(--pt-mono)
//   ink       the glyph colour, normally var(--pt-art-ink)
//
// Cell width comes from the MEASURED advance of the font at this size, not from
// ADVANCE_CSS. That constant is the baseline the portable wrapper has to guess
// with because it cannot measure; here we can measure, so we do. Line height
// still comes from baseLineHeight(), because that is geometry the whole project
// shares and re-deriving it is how five figures have drifted so far.
export function getAtlas({ codec, ramp = null, fontSize, dpr = 1, font, ink }) {
  const key = [codec, ramp || '-', fontSize.toFixed(3), dpr, font, ink].join('|');
  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const built = build({ codec, ramp, fontSize, dpr, font, ink });
  cache.set(key, built);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return built;
}

function build({ codec, ramp, fontSize, dpr, font, ink }) {
  const glyphs = glyphsFor(codec, ramp);

  // Measure on a throwaway context first: cell width depends on the advance,
  // and we cannot size the atlas canvas before we know it.
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `${fontSize}px ${font}`;
  probe.fontKerning = 'none';

  // Per-glyph widths are needed to report overflow; the cell width itself comes
  // from measureAdvance() so that the number this atlas is built at is byte for
  // byte the number the fit was computed with. Measuring it twice, at two font
  // sizes, is how a half-pixel disagreement between the canvas size and the
  // atlas cell would creep in.
  const widths = new Array(glyphs.length);
  for (let i = 0; i < glyphs.length; i++) widths[i] = probe.measureText(glyphs[i]).width;

  const advanceRatio = measureAdvance(codec, ramp, font);
  const advancePx = advanceRatio * fontSize;
  const lineHeight = baseLineHeight(codec, advanceRatio);
  const cellW = advancePx;
  const cellH = fontSize * lineHeight;

  const dw = Math.max(1, Math.ceil(cellW * dpr));
  const dh = Math.max(1, Math.ceil(cellH * dpr));

  const canvas = document.createElement('canvas');
  canvas.width = dw * glyphs.length;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');

  ctx.scale(dpr, dpr);
  ctx.font = `${fontSize}px ${font}`;
  ctx.fontKerning = 'none';
  ctx.textAlign = 'center';       // rule 2: centre by the glyph's own advance
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  // Rule 1. Canvas antialiases text by default and there is no switch to turn
  // it off, which is exactly what we want -- but it is worth writing down that
  // its absence here is deliberate rather than an oversight.

  const base = baselineIn(ctx, cellH);

  // Glyphs wider than the cell. Recorded rather than silently clipped away,
  // because a charset that overflows is a charset that will shear the real
  // message too, and the user can edit a custom ramp.
  const overflowing = [];

  for (let i = 0; i < glyphs.length; i++) {
    const x = i * cellW;
    if (widths[i] > cellW + 0.01) overflowing.push(glyphs[i]);

    // Rule 2, the other half: clip to the cell so a wide glyph cannot bleed
    // into its neighbour's slot. Centring alone is not enough -- it halves the
    // bleed and puts it on both sides.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, cellW, cellH);
    ctx.clip();
    // Rule 3: the baseline is where a line box would put it, so descenders
    // have the room they need below it and nothing is chopped.
    ctx.fillText(glyphs[i], x + cellW / 2, base.y);
    ctx.restore();
  }

  return {
    canvas,
    codec,
    ramp,
    glyphs,
    count: glyphs.length,
    // CSS px
    cellW,
    cellH,
    fontSize,
    lineHeight,
    advance: advanceRatio,
    // device px, which is what the blit indexes with
    dw,
    dh,
    dpr,
    baseline: base.y,
    metricsMeasured: base.measured,
    overflowing,
  };
}

// Blit a grid through an atlas.
//
// One drawImage per cell, row-major. Spec 5.8 says to split the work by
// character ROW and not by cell if it ever moves off the main thread --
// cache-friendly, no per-cell synchronisation, and it maps cleanly onto
// workers. The loop is written in that shape already so that change is a
// wrapper rather than a rewrite.
//
// Source and destination rectangles are both in whole device pixels and the
// same size, so this is a straight copy with no resampling. That is where the
// speed is: the moment the destination rect is a different size from the source
// rect, the GPU starts filtering and the cost goes up.
export function blitGrid(ctx, atlas, grid, { bg = null } = {}) {
  const { cols, rows, values } = grid;
  const { canvas, dw, dh, count } = atlas;

  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cols * dw, rows * dh);
  } else {
    ctx.clearRect(0, 0, cols * dw, rows * dh);
  }

  for (let y = 0; y < rows; y++) {
    const dy = y * dh;
    const rowStart = y * cols;
    for (let x = 0; x < cols; x++) {
      let v = values[rowStart + x];
      // A value outside the glyph set means the grid and the atlas were built
      // from different ramps -- a style change that landed between the encode
      // and the blit. Clamp rather than throw: one stale frame is invisible,
      // an exception inside rAF kills the viewfinder.
      if (v >= count) v = count - 1;
      ctx.drawImage(canvas, v * dw, 0, dw, dh, x * dw, dy, dw, dh);
    }
  }
}

// Drop everything. Called when the capture screen unmounts, so a style the user
// tried once is not held in memory for the rest of the session.
export function clearAtlasCache() {
  cache.clear();
}
