#!/usr/bin/env node
// Plane Text: generate the Test D fit-test artifact (spec 7, build step 0).
//
//   node tools/make-test-d.js [photo.jpg] -o out/test-d.html
//
// One self-contained HTML file. Open it on every target platform. It answers,
// by measurement rather than by eye where possible:
//
//   1. What is the real monospace advance ratio, per platform and per codec?
//   2. Is the blank braille cell the same width as a dotted one? (shear)
//   3. Does braille have a glyph at all, or is it tofu?
//   4. What is the smallest font size at which the image still reads?
//   5. Does the grid ever overflow the viewport width?
//   6. Do accessibility minimum-font-size settings override it?
//   7. Is the picture the right shape? (aspect, which font-size cannot fix)
//   8. At 65 / 78 / 108 columns, does it read as text art or just as a photo?

import { writeFileSync } from 'node:fs';
import { loadImage } from './image.js';
import { toLuma, unsharp, autoLevels, gamma } from '../src/tone.js';
import { buildGrid, gridToRows } from '../src/cells.js';
import {
  CODEC, CELL_DOTS, advanceCssFor, DEFAULT_RAMP, RAMP_ART, RAMP_FIDELITY,
  RAMP_CONVENTIONAL, INVERT_DEFAULT, TONE, TEXT_STROKE_EM, CAPTURE_ASPECT,
} from '../src/constants.js';
import { QUADRANT_CHARS } from '../src/cells.js';
import { fitToAspect } from '../src/fit.js';
import { rowsFor, lineHeightFor, colsForChars, baseLineHeight, describe as describeGrid } from '../src/sizing.js';

// ---------------------------------------------------------------------------
// A geometry target. Every feature has a known, exact shape in source pixels,
// so any deviation on screen was introduced by the renderer.
//
// The circle is the instrument: it arrives as an ellipse exactly when the
// aspect ratio is wrong, and the ratio of its axes is the advance error.
// ---------------------------------------------------------------------------
function geometryTarget(size = 864) {
  // 4:3 portrait, matching the fixed capture aspect. The circle stays a circle:
  // it is the instrument, and a non-square frame does not change it.
  const w = size, h = Math.round(size / CAPTURE_ASPECT);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const set = (x, y, v) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  };
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = 255;
  }

  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) * 0.36;

  // Circle outline, thick enough to survive an aggressive downscale.
  for (let a = 0; a < 3600; a++) {
    const t = (a / 3600) * Math.PI * 2;
    for (let d = -3; d <= 3; d++) {
      set(Math.round(cx + (R + d) * Math.cos(t)), Math.round(cy + (R + d) * Math.sin(t)), 0);
    }
  }
  // Inscribed square: side = 2R/sqrt(2). If the render is square, this square
  // touches the circle at exactly four points.
  const s = Math.round((2 * R) / Math.SQRT2 / 2);
  for (let d = -3; d <= 3; d++) {
    for (let x = cx - s; x <= cx + s; x++) { set(x, cy - s + d, 0); set(x, cy + s + d, 0); }
    for (let y = cy - s; y <= cy + s; y++) { set(cx - s + d, y, 0); set(cx + s + d, y, 0); }
  }
  // Crosshair through the centre.
  for (let x = 0; x < w; x++) { set(x, cy, 0); set(x, cy - 1, 0); }
  for (let y = 0; y < h; y++) { set(cx, y, 0); set(cx - 1, y, 0); }

  // Ruler ticks on all four edges, every 1/12 of the span. If horizontal and
  // vertical ticks do not stay square with each other, the aspect is off.
  const stepX = w / 12, stepY = h / 12;
  for (let k = 0; k <= 12; k++) {
    const px = Math.round(k * stepX), py = Math.round(k * stepY);
    const len = k % 3 === 0 ? 26 : 13;
    for (let d = 0; d < len; d++) {
      for (let t = 0; t < 3; t++) {
        set(px + t, d, 0); set(px + t, h - 1 - d, 0);
        set(d, py + t, 0); set(w - 1 - d, py + t, 0);
      }
    }
  }
  // Corner blocks: the first thing to disappear if rows are being clipped.
  for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
    set(x, y, 0); set(w - 1 - x, y, 0); set(x, h - 1 - y, 0); set(w - 1 - x, h - 1 - y, 0);
  }
  return { rgba, w, h };
}

function render(src, codec, cols, { useDither = true, invert = INVERT_DEFAULT, ramp = DEFAULT_RAMP } = {}) {
  const img = fitToAspect(src.rgba, src.w, src.h, CAPTURE_ASPECT, 0.48, 0.42);
  let luma = toLuma(img.rgba, img.w, img.h);
  const t = TONE[codec];
  luma = unsharp(luma, img.w, img.h, t.unsharp, 1);
  luma = autoLevels(luma, t.clipLo, t.clipHi);
  if (t.gamma !== 1) luma = gamma(luma, t.gamma);
  if (t.compress < 1) {
    const o = (1 - t.compress) / 2, c2 = new Float64Array(luma.length);
    for (let i = 0; i < luma.length; i++) c2[i] = luma[i] * t.compress + o;
    luma = c2;
  }
  // Polarity flips in the encoder. On a dark ground a dot marks a bright source
  // pixel; flipping only the CSS gives a negative.
  if (invert) {
    const f = new Float64Array(luma.length);
    for (let i = 0; i < luma.length; i++) f[i] = 1 - luma[i];
    luma = f;
  }
  const rows = rowsFor(cols, img.w, img.h, codec);
  const grid = buildGrid(luma, img.w, img.h, { codec, cols, rows, ramp, useDither });
  return { text: gridToRows(grid).join('\n'), cols, rows, codec };
}

// ---------------------------------------------------------------------------
// Cell luminance, base64, for the client-side ramp preview (section 6).
//
// Section 6 chooses a ramp at runtime from glyph coverage measured on the
// device, so the art cannot be pre-rendered here: the generator does not know
// which glyphs will be picked. What it can ship is the tone-mapped cell grid,
// one byte per cell, and let the client map bytes through whichever ramp it
// selects. Same pipeline as render(), stopping one step short of the charset.
// ---------------------------------------------------------------------------
function lumaCellsB64(src, cols, rows, codec = CODEC.RAMP) {
  const img = fitToAspect(src.rgba, src.w, src.h, CAPTURE_ASPECT, 0.48, 0.42);
  let luma = toLuma(img.rgba, img.w, img.h);
  const t = TONE[codec];
  luma = unsharp(luma, img.w, img.h, t.unsharp, 1);
  luma = autoLevels(luma, t.clipLo, t.clipHi);
  if (t.gamma !== 1) luma = gamma(luma, t.gamma);
  if (t.compress < 1) {
    const o = (1 - t.compress) / 2, c2 = new Float64Array(luma.length);
    for (let i = 0; i < luma.length; i++) c2[i] = luma[i] * t.compress + o;
    luma = c2;
  }
  if (INVERT_DEFAULT) {
    const f = new Float64Array(luma.length);
    for (let i = 0; i < luma.length; i++) f[i] = 1 - luma[i];
    luma = f;
  }
  const out = new Uint8Array(cols * rows);
  for (let ry = 0; ry < rows; ry++) {
    const y0 = Math.floor((ry * img.h) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * img.h) / rows));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * img.w) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * img.w) / cols));
      let s = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += luma[y * img.w + x]; n++; }
      out[ry * cols + cx] = Math.max(0, Math.min(255, Math.round((s / n) * 255)));
    }
  }
  return Buffer.from(out).toString('base64');
}

// A <pre> panel. `mode` selects the fit strategy under test.
function panel(block, mode, label, note = '') {
  const { text, cols, codec } = block;

  // hRatio comes from CELL_DOTS, never from a hand-written conditional.
  // 2026-08-08: it was a hand-written conditional, and the transform panels
  // then used the raw ratio as a line-height instead of advance x ratio. See
  // the base line-height note below.
  const hRatio = CELL_DOTS[codec].h / CELL_DOTS[codec].w;

  // The base line-height. Must match wrap.js:baseLh. It is the single source of
  // the round-5 bug: this file used `hRatio` alone (2.0 for braille, 1.0 for
  // quadrant and ramp) where the shipping wrapper uses advance x hRatio
  // (1.36 / 0.68). Every transform panel therefore rendered ~1.47x too tall and
  // the shim's sy quietly crushed it back to 60%.
  //
  // The crush was invisible on braille (a squashed dot is an ellipse and reads
  // as halftone) and obvious on ramp, where a squashed glyph reads as broken. It
  // also closed the braille row gutters, so the "gutters accepted as texture"
  // decision had been getting help from a bug.
  const lh = baseLineHeight(codec).toFixed(3);
  const cls = mode === 'svg' ? 'art svgart' : 'art';

  if (mode === 'svg') {
    // SVG variant: textLength forces each row to an exact width regardless of
    // the font's real advance. Solves the metric problem with no JS, and
    // destroys the plain-text-viewer property, which is why it is not the
    // default. Measured here rather than argued about.
    const lines = text.split('\n');
    const vbW = 1000;
    const rowH = (vbW / cols) * hRatio;
    const body = lines
      .map((l, i) =>
        `<text x="0" y="${((i + 0.8) * rowH).toFixed(2)}" textLength="${vbW}" ` +
        `lengthAdjust="spacingAndGlyphs">${l}</text>`)
      .join('');
    return section(label, note,
      `<svg class="svgart" style="background:#000" viewBox="0 0 ${vbW} ${(lines.length * rowH).toFixed(2)}" ` +
      `preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">` +
      `<g font-family="monospace" font-size="${rowH.toFixed(2)}" fill="#fff">${body}</g></svg>`);
  }

  const n = CELL_DOTS[codec].h;                        // dot rows per cell
  const m = CELL_DOTS[codec].w;                        // dot columns per cell
  const g = codec === CODEC.BRAILLE ? '\u28FF' : codec === CODEC.QUADRANT ? '\u2588' : '@';
  const rowCount = block.rows;
  const dotsW = cols * m, dotsH = rowCount * n;

  // Transform modes. Render at a reference font-size, measure the block, then
  // scale per axis. No advance arithmetic anywhere:
  //   sx = containerWidth / measuredWidth   -> exact fit, immune to hinting
  //   sy = targetHeight   / measuredHeight  -> proportions, independent of
  //                                            line-height
  // 'tf'  keeps advance-based line-height (gutters remain)
  // 'tfi' uses ink-based line-height (gutters closed; sy restores proportions)
  //
  // sy/sx is not incidental. With the base line-height above it reduces
  // algebraically to a_real / the codec's ADVANCE_CSS for every codec, so each
  // panel measures the real advance in the real fallback font at the real size,
  // hinting included. It is also the exact factor by which the shim distorts
  // glyph shapes: the transform is immune to hinting for geometry, not for
  // shape, and that price is zero only when the CSS advance guess is right.
  // Reported under every panel.
  if (mode === 'shim' || mode === 'tf' || mode === 'tfi' || mode === 'tfa' || (mode && mode.stroke !== undefined)) {
    return section(label, note,
      `<div class="tfbox"><pre class="art tf" data-c="${cols}" data-n="${n}" ` +
      `data-w="${dotsW}" data-dh="${dotsH}" data-g="${g}" data-ink="${mode === 'tfi' ? 1 : 0}" ` +
      `data-lh="${mode === 'tfa' ? 'auto' : ''}" ` +
      `style="${(mode && mode.stroke) ? `-webkit-text-stroke:${mode.stroke}em #fff;` : ''}` +
      `font-size:24px;line-height:${lh}">${text}</pre></div><div class=srep></div>`);
  }

  // CSS-only baseline (mode 'css'): no script touches it.
  //
  // Wrapped full-bleed. Its font-size is calc(100vw/...), so the only honest
  // container to measure it against is one 100vw wide. See .bleed.
  return section(label, note,
    `<div class="bleed"><pre class="${cls}" data-c="${cols}" data-h="${hRatio}" data-n="${n}" data-g="${g}" ` +
    `style="font-size:calc(100vw/${cols}/${advanceCssFor(codec)});line-height:${lh}">${text}</pre></div>`);
}

// Wrap every <h2>-delimited run in a <details> so the page opens as a table of
// contents rather than as forty screens of art.
//
// Split the joined string, not the parts array: some pushes emit two or three
// <h2>s at once (3b/3c/4), so grouping by array index would nest them wrongly.
//
// The measurement code requires these open. A collapsed <details> reports
// clientWidth 0, which would silently zero the advance, the shim and the
// overflow check. The script opens everything, measures, and closes again; see
// the top and bottom of the inline script.
function collapsible(joined) {
  const chunks = joined.split(/(?=<h2>)/);
  const lead = chunks.length && !chunks[0].startsWith('<h2>') ? chunks.shift() : '';
  const wrapped = chunks.map((c) => {
    const m = c.match(/^<h2>([\s\S]*?)<\/h2>/);
    if (!m) return c;
    return `<details><summary>${m[1]}</summary><div class=dbody>${c.slice(m[0].length)}</div></details>`;
  });
  return lead + wrapped.join('\n');
}

function section(label, note, inner) {
  return `<section><h3>${label}</h3>${note ? `<p class=note>${note}</p>` : ''}${inner}</section>`;
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const photoPaths = [];
let outPath = 'out/test-d.html';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-o') outPath = argv[++i];
  else if (!argv[i].startsWith('-')) photoPaths.push(argv[i]);
}

const geo = geometryTarget(864);

// Several sources, because the codec comparison cannot be decided on one.
// Braille buys resolution and ramp buys tone, so a face and a detail-heavy
// scene should rank them differently. A default chosen from one photo is a
// default that is right for that photo.
const photos = photoPaths.map((p) => {
  const img = loadImage(p);
  return { ...img, path: p, label: `${p.split('/').pop()} (${img.w}x${img.h})` };
});

// The legibility ladders stay on the highest-resolution source. At 200 columns
// braille needs 400 dots across, and a 640x480 source cropped to 3:4 has only
// 360. A smaller source would be upsampled and the top of the ladder would look
// soft for reasons that have nothing to do with legibility.
const ladderSrc = photos.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0] || geo;
const photoLabel = photos.length
  ? photos.map((p) => p.label).join(' + ')
  : 'no photo supplied';

const parts = [];

parts.push(`<h2>1 &middot; Geometry: is the picture the right shape?</h2>
<p class=note>The circle is the instrument. It is a perfect circle in the source, so if it
arrives as an ellipse the advance ratio is wrong, and the ratio of its axes is the size of the
error. <b>font-size cannot fix this</b>. Only line-height can, and only with JS. The
inscribed square should touch the circle at exactly four points; the edge ticks should stay
square with each other.</p>`);

parts.push(panel(render(geo, CODEC.BRAILLE, 108), 'css', 'A. CSS baseline, no JS',
  `Advance baseline for this codec: ${advanceCssFor(CODEC.BRAILLE)} (per-codec since 2026-08-09, rounded up from the measurement). Expect a small gap on the right. If the circle is an ellipse here, that is the CSS-only failure mode.`));
parts.push(panel(render(geo, CODEC.BRAILLE, 108), 'shim', 'B. With the JS fit shim',
  'Should fill the width exactly <b>and</b> be round. If A was an ellipse and B is a circle, the shim works and is worth keeping.'));
parts.push(panel(render(geo, CODEC.BRAILLE, 108), 'tf', 'D. Transform fit, advance line-height',
  'Rendered at 24px then scaled per axis. Width should be exact and proportions correct, with no advance arithmetic at all. Gutters should still be present: scaling cannot remove them.'));
parts.push(panel(render(geo, CODEC.BRAILLE, 108), 'tfi', 'E. Transform fit + ink line-height  \u2190 the new one',
  'Line-height closes the gutters; sy independently restores proportions. <b>This is the combination that was impossible before.</b> Expect a round circle <b>and</b> continuous dots. Dots will be slightly elliptical. Check whether that reads as a halftone screen or as a defect. Check sharpness too: the text is rasterised at 24px and scaled down.'));
parts.push(panel(render(geo, CODEC.RAMP, 78), 'shim', 'F1. Ramp, shipping shim: the squish panel',
  'Ramp at the shipping base line-height. <b>Look at the glyph shapes, not the picture.</b> The picture geometry is exact by construction. The characters are squashed vertically by exactly the CSS advance guess error, because the shim makes sy differ from sx. Round 4 had this at 40% squash from a line-height bug; the residual here is the honest one.'));
parts.push(panel(render(geo, CODEC.RAMP, 78), 'tfa', 'F2. Ramp, line-height measured before scaling: the proposed fix',
  'Same panel, but the shim measures the rendered advance and sets line-height from it <i>before</i> scaling, which forces sy to equal sx. Expect identical picture geometry and <b>undistorted glyphs</b>. If F2 reads better than F1, the wrapper should adopt it. The cost is roughly 60 characters of shim and one extra reflow.'));
parts.push(panel(render(geo, CODEC.BRAILLE, 108), 'tfa', 'F3. Braille, same fix',
  'The same change on braille. Dots should go from vertically squashed ellipses to round. Watch whether the row gutters come back: the round-4 line-height bug was closing them by accident, so “gutters accepted as texture” was a decision made against art that was being squashed.'));
parts.push(panel(render(geo, CODEC.BRAILLE, 108), 'svg', 'C. SVG textLength, no JS',
  'Forces exact row width regardless of the font. Should be round and exactly full width. If A and B both fail and this passes, reconsider the plain-text-viewer tradeoff.'));

parts.push(`<h2>2a &middot; Ramp legibility: re-taking the 78-column cap</h2>
<p class=note><b>Ramp is now the default codec, and its column cap is the least trustworthy
number in the project.</b> 78 was recorded as measured on device in round 4, the same round
whose panels were all being squashed to 60% of their height by a line-height bug. Squashed glyphs
stop being readable sooner, so <b>the real cap is probably above 78</b>. This ladder is how we
find out.<br>
Question 1: at which of these can you still read the picture? Question 2, which matters more: at
which does it still look like <i>text art</i> rather than a grey photograph?</p>`);
for (const c of [65, 78, 106, 130]) {
  const px = (390 / c).toFixed(2);
  parts.push(panel(render(ladderSrc, CODEC.RAMP, c), 'shim',
    `${c} columns`, `${px}px per cell on a 390px phone.` +
    (c === 78 ? ' <b>The current cap, judged on squashed art.</b>' : '') +
    (c === 106 ? ' The equal-character point in section 3.' : '')));
}

parts.push(`<h2>2b &middot; Braille legibility: the same ladder</h2>
<p class=note>Braille for comparison, JS shim active. Its 150-column cap was measured in the same
round and carries the same caveat, though the effect is smaller: a squashed dot still reads as a
dot, where a squashed glyph stops being a letter.</p>`);
for (const c of [78, 108, 150, 200]) {
  const px = (390 / c).toFixed(2);
  parts.push(panel(render(ladderSrc, CODEC.BRAILLE, c), 'shim',
    `${c} columns`, `${px}px per cell on a 390px phone.` +
    (c === 108 ? ' <b>The old v1 target.</b>' : '') +
    (c === 150 ? ' The current cap, also judged on squashed art.' : '')));
}

parts.push(`<h2>2c &middot; Small dots read as grey: does stroking fix it?</h2>
<p class=note>As a braille dot approaches one device pixel, antialiasing spreads its ink across
neighbouring pixels. Total ink is conserved but <b>peak contrast is not</b>, so the dot reads as
grey rather than solid and the image loses punch. <code>-webkit-text-stroke</code> thickens the
glyph outline and restores solidity, at zero cost in the payload.<br>
All four are 4:3 portrait at 150 columns, past the legibility cap, chosen because that is where
you saw the problem. <b>Which is the first one that reads as solid without the dots merging into
each other?</b> Too much stroke destroys the sub-cell resolution braille exists for.</p>`);
for (const st of [0, 0.04, 0.07, 0.10]) {
  parts.push(panel(render(ladderSrc, CODEC.BRAILLE, 150), { stroke: st },
    st ? `stroke ${st}em` : 'no stroke (current behaviour at 150 cols)',
    st === TEXT_STROKE_EM ? '<b>The measured default.</b>' : ''));
}
parts.push(`<p class=note><b>Note the polarity interaction.</b> Light features on a dark ground
bloom (displays and eyes both over-report them), so a sub-pixel white dot on black
survives where a black dot on white washes out. Switching the default to dark should already have
raised the floor before any stroking is applied. Compare against how this looked on the white
background: if dark alone fixed it, the stroke may be unnecessary.</p>`);

// ---------------------------------------------------------------------------
// Section 3: the codec comparison, at equal character count.
//
// Decided 2026-08-08. The constant is the message size; the column count is
// what varies, because that is the choice a sender faces: "this is my file
// size, which codec makes the better picture out of it?"
//
// The rejected alternative was equal columns, which holds cell size constant
// but lets quadrant and ramp spend 2x the characters braille does. At equal
// columns braille and quadrant produce identical dot resolution, so the
// comparison would be measuring who was allowed a bigger budget.
// ---------------------------------------------------------------------------
const COMPARE_CHARS = 15100; // braille at its 150-column cap

parts.push(`<h2>3 &middot; Codecs at equal file size: ${COMPARE_CHARS.toLocaleString()} characters</h2>
<p class=note><b>Same message size, different codec.</b> The column count varies so the character
count does not: this is the comparison a sender faces, since the file is the thing they are
spending. Equal <i>columns</i> was the alternative and it is misleading. At 150 columns
braille and quadrant produce the <i>same</i> 300&times;400 dots, but quadrant costs 30,200
characters to braille's 15,100.<br>
<b>Ramp leads because it is now the default codec.</b> That decision was taken on readability and
on the ramp being the more interesting artefact: a ramp message reads as text art in a plain
text viewer, where a braille message reads as a wall of dots. <b>This section is the check on
it, not the justification for it.</b> If braille clearly wins here on both sources, the default
should move back.<br>
All three go through the shipping transform shim, so a wrong aspect is a real bug. If braille is
tofu boxes, quadrant becomes the fallback by necessity rather than by merit.</p>`);

const COMPARE_CODECS = [['Ramp', CODEC.RAMP], ['Braille', CODEC.BRAILLE], ['Quadrant', CODEC.QUADRANT]];
const COMPARE_SOURCES = photos.length ? photos : [{ ...geo, label: 'geometry target' }];

for (const src of COMPARE_SOURCES) {
  if (COMPARE_SOURCES.length > 1) {
    parts.push(`<h3 style="color:#fff;font-size:14px;margin-top:20px">Source: ${src.label}</h3>`);
  }
  for (const [name, codec] of COMPARE_CODECS) {
    const c = colsForChars(codec, COMPARE_CHARS, CAPTURE_ASPECT);
    const d = describeGrid(c, rowsFor(c, 3, 4, codec), codec);
    parts.push(panel(render(src, codec, c), 'shim',
      `${name}, ${c} cols` + (codec === CODEC.RAMP ? ' <span style="color:#7ee787">(default)</span>' : ''),
      `${c}&times;${d.rows} cells &middot; ${d.dotsW}&times;${d.dotsH} dots &middot; ` +
      `<b>${d.payloadChars.toLocaleString()} chars</b> (${(d.utilisation * 100).toFixed(1)}% of ceiling) ` +
      `&middot; ${(390 / c).toFixed(2)}px per cell on a 390px phone.`));
  }
}
parts.push(`<p class=note><b>Judge each source separately, then together.</b> Braille buys
resolution and ramp buys tone, so they should rank differently on a face than on a detail-heavy
scene. If they do, the honest answer is that the codec should follow the subject rather
than be a fixed default. That would be a real finding, not a failure to decide.</p>`);

// ---------------------------------------------------------------------------
// Section 3d: the two shipping ramps, side by side.
//
// Both are calibrated and both are monotonic. The trade is not quality against
// sloppiness, it is picture against artefact: fidelity scores +0.11 SSIM on the
// worst font measured, and renders as a page of random letters. The
// conventional ramp is included because it was the default until today and its
// failure should be visible rather than asserted.
// ---------------------------------------------------------------------------
parts.push(`<h2>3d &middot; The two shipping ramps, and the one they replaced</h2>
<p class=note>All three at the same columns, same tone curve, same everything but the charset.
<b>Art</b> is the new default: calibrated, monotonic, and it still reads as ASCII art.
<b>Fidelity</b> measures better as a photograph and reads as random letters.
<b>Conventional</b> is the ramp that shipped until today. It is not monotonic in ink
coverage in any font measured, so in four places a darker part of the photo is drawn with a
lighter glyph.<br>
<b>Which of the first two do you actually want to receive?</b> That is the whole question, and it
is a taste question rather than a measurement one. The measurement is already in.</p>`);
for (const [name, ramp] of [
  ['Art: the new default', RAMP_ART],
  ['Fidelity: best picture, worst artefact', RAMP_FIDELITY],
  ['Conventional: what shipped until today', RAMP_CONVENTIONAL],
]) {
  const c = colsForChars(CODEC.RAMP, COMPARE_CHARS, CAPTURE_ASPECT);
  parts.push(panel(render(ladderSrc, CODEC.RAMP, c, { ramp }), 'shim', name,
    `charset <code>${ramp.replace(/\u00A0/, '\u2423').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`));
}

// ---------------------------------------------------------------------------
// Section 3b: per-glyph advance audit.
//
// The previous version compared four candidate blanks against a reference row
// of U+2588, and the diagnostics bar averaged four quadrant glyphs into a
// single number. Neither could see the failure being reported, shear on some
// lines only, because neither measured the other fifteen quadrant glyphs
// against each other.
//
// The hypothesis under test: Block Elements is not one support tier. The half
// and full blocks (U+2580 2584 2588 258C 2590) are CP437-era and present in
// nearly every font; the true quadrant glyphs (U+2596-259F) arrived in Unicode
// 3.2 and are missing from many, so they fall back to a different font, often a
// CJK one at double width. Rows containing them shear; rows built only from
// half blocks do not. That is the "some lines" symptom.
//
// Still worth running now that ramp is the default: the ramp set is the one
// that has to come back clean, and it is the cheapest proof that the default
// codec carries no shear risk at all.
// ---------------------------------------------------------------------------
const GLYPH_SETS = [
  {
    name: 'Ramp charset (' + [...DEFAULT_RAMP].length + '), the default codec',
    note: 'Latin plus U+00A0, so it should be perfectly uniform. This is the set that matters most now: if it is clean, the default codec has no shear risk and no tofu risk on this platform, which is most of the font fragility in the project gone.',
    glyphs: [...DEFAULT_RAMP],
  },
  {
    name: 'Quadrant charset (16)',
    note: 'Every glyph the quadrant codec can emit. Any row that does not match the others is a shear source, and shear has no fix at render time.',
    glyphs: QUADRANT_CHARS,
  },
  {
    name: 'Braille: blank vs dotted',
    note: 'The original shear question. U+2800 must be exactly as wide as a dotted cell.',
    glyphs: ['\u2800', '\u2801', '\u2847', '\u28FF', '\u2807', '\u28C0'],
  },
  {
    name: 'Blank candidates vs a full block',
    note: 'Quadrant needs a blank and Block Elements has none. Whichever of these matches U+2588 is the only viable choice; if only U+2591 does, quadrant carries a permanent grey floor and can never render an empty area.',
    glyphs: ['\u2588', '\u00A0', '\u2800', ' ', '\u2591'],
  },
  {
    name: 'Latin monospace reference',
    note: 'The baseline every other set is compared against. A braille or block glyph far from this width is probably tofu.',
    glyphs: ['M', 'i', '@', '#', '.'],
  },
];

parts.push(`<h2>3b &middot; Per-glyph advance audit: where does the shear come from?</h2>
<p class=note><b>Measured, not eyeballed.</b> Each glyph is measured on its own and compared with
the median width of its set. <b>Anything over 0.5% is a shear source</b>: unlike a uniform wrong
advance, which the shim corrects, a per-glyph difference makes the row the wrong length wherever
that glyph appears, which is why it shows on some lines and not others.<br>
The suspicion being tested: <code>▀▄█▌▐</code> are CP437-era and in every font, while
<code>▖▗▘▙▚▛▜▝▞▟</code> arrived in Unicode 3.2 and are missing from many, so they
fall back to a different font, often at double width.</p>
<div id=glyphaudit>measuring…</div>

<h2>3c &middot; The same thing, visually</h2>
<p class=note>Each row is one glyph repeated 24 times, then a marker. <b>Every marker must land in
the same column.</b> A marker right of the others is a wide glyph; left, a narrow one. This is the
shear failure isolated to a single character.</p>
<div id=glyphcomb></div>

<h2>4 &middot; Glyph coverage</h2>
<p class=note>Large enough to inspect directly. Any tofu box is a finding on its own: that
codec has no glyph on this platform at all.</p>
<pre class="big">⠀⠁⠂⠃⠄⠅⠆⠇⡀⡁⡂⡃⡄⡅⡆⡇
⠈⠉⠊⠋⠌⠍⠎⠏⣸⣹⣺⣻⣼⣽⣾⣿
⠿⣿⠀⣿⠿⣿⠀⣿⠿⣿⠀⣿⠿⣿⠀⣿</pre>
<p class=note>Row 3 alternates dense and blank cells. If blank braille is a different width from a
dotted cell, this row will not line up with the two above it.</p>
<pre class="big">${QUADRANT_CHARS.join('')}
${DEFAULT_RAMP.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
<p class=note>Row 1 is the quadrant charset in mask order, row 2 the ramp. Read row 1 carefully: if
the five half/full blocks look right and the ten corner glyphs look wrong or differently sized,
that is the two-support-tiers hypothesis confirmed by eye.</p>`);

// ---------------------------------------------------------------------------
// Section 5: glyph coverage, measured on this device.
//
// The conventional ramp " .:-=+ox#%@" is not monotonic in ink coverage in any
// font measured off-device: '-' is lighter than the ':' before it, '+' lighter
// than '=', 'x' lighter than 'o', '%' lighter than '#'. In those bands a darker
// source pixel produces a lighter glyph. Worst error 20-22% of the tonal range
// on DejaVu Sans Mono, Liberation Mono and Latin Modern Mono alike.
//
// Those are all Linux fonts. The recipient resolves `monospace` to SF Mono on
// iOS and Roboto Mono on Android, and NOBODY HAS MEASURED THOSE. This panel
// does it with canvas, on the device, the same mechanism runtime calibration
// would use, so it doubles as a feasibility test for it.
// ---------------------------------------------------------------------------
const RAMPS_UNDER_TEST = [
  ['Art (shipping default)', RAMP_ART],
  ['Fidelity', RAMP_FIDELITY],
  ['Conventional (the old default)', RAMP_CONVENTIONAL],
];

parts.push(`<h2>5 &middot; Glyph coverage on this device: is the ramp monotonic?</h2>
<p class=note>Each ramp glyph is rasterised to a canvas and its <b>mean alpha coverage</b> read
back, then compared with the coverage the encoder assumes for that position. <b>Any negative step
is a tone inversion</b> (a darker part of the photo drawn with a lighter glyph), and no tone
curve can fix it.<br>
Off-device this was measured on three Linux monospace fonts, which all agreed: the conventional
ramp inverts four times and is 20&ndash;22% off. The fonts that matter are the ones your phone
picks, and this is the first look at them.</p>
<div id=rampcov>measuring…</div>
<p class=note>The same canvas call is how runtime calibration would work, so if this panel
produces sensible numbers the feature is feasible on this platform; if it returns nothing, the
static calibrated ramps are the only option.</p>`);

// ---------------------------------------------------------------------------
// Section 6: design a better Art ramp, on the device.
//
// Section 5 measured the three shipped ramps and found Art non-monotonic on
// Roboto Mono. The obvious next move, pick a better glyph set, cannot be done
// in this generator: the only fonts available to it are the Linux ones whose
// calibration already failed to transfer. Choosing a ramp off-device would
// repeat the mistake that produced the broken default.
//
// So the selection runs client-side: measure every candidate glyph's coverage
// in the real font, then pick the 11 that come closest to an even 0.0-1.0
// ladder. The generator ships the candidate pool and the tone-mapped cell grid;
// the device supplies the only numbers that matter.
// ---------------------------------------------------------------------------
const PREVIEW_COLS = 78;
const previewSrc = ladderSrc;
const previewRows = rowsFor(PREVIEW_COLS, previewSrc.w, previewSrc.h, CODEC.RAMP);
const previewB64 = lumaCellsB64(previewSrc, PREVIEW_COLS, previewRows);

// Candidate pools. Both exclude BANNED_MARKDOWN (* _ ~ `) and BANNED_HTML
// (< > &) because a ramp glyph lands in the payload, and also the two quote
// characters, which chat clients substitute with smart quotes (spec, Test B).
const POOL_ART = '!#$%()+,-./:;=?@[\\]^{|}';
const POOL_ANY = POOL_ART + '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

parts.push(`<h2>6 &middot; Design a better Art ramp, measured on this device</h2>
<p class=note>Section 5 found the shipping Art ramp <b>non-monotonic</b> on this platform, with
four glyph pairs so close in coverage that it delivers about <b>7 usable tone levels out of 11</b>.
Reordering fixes the inversions for free; it does not fix the clustering.<br>
<b>This section cannot be run off-device and that is the whole point.</b> Art was originally chosen
against DejaVu, Liberation and Latin Modern: three Linux fonts, none of which any phone
uses. Picking a replacement anywhere but here would repeat that mistake exactly. Every candidate
below is rasterised in the font your device actually resolves <code>monospace</code> to.</p>
<p class=note><b>Two pools, both designed and both shown.</b> This was a radio button, which was
the wrong control: it made you compare the one on screen against the one you remembered.
<b>Art</b> is punctuation and symbols only, so the message still reads as ASCII art.
<b>Any</b> adds letters and digits: better tone, and it drifts toward looking like Fidelity.
Both exclude <code>* _ ~ \` &lt; &gt; &amp;</code> (chat markdown and HTML) and both quote
characters, which clients replace with smart quotes. The blank is always U+00A0.</p>
<div id=rampdesign>measuring…</div>
<h3>The same photo, five ways</h3>
<p class=note>Rendered from a tone-mapped cell grid at ${PREVIEW_COLS} columns and dithered in the
browser, so all five differ <i>only</i> in charset: same tone curve, same dither, same
geometry. Judge two separate things and do not let them collapse into one: <b>which reads best as
a picture</b>, and <b>which still reads as art</b>.</p>
<div id=rampprev class=cmp>rendering…</div>
<div class=verdict><b>Judge:</b><br>
&#9744; Best <i>picture</i>: &nbsp; Art as shipped / Art re-sorted / Designed-art / Designed-any /
Fidelity<br>
&#9744; Best <i>artefact</i> (still looks like ASCII art rather than noise): &nbsp; same five<br>
&#9744; If those two answers differ, say so rather than picking one. That is the whole
Art-versus-Fidelity trade, restated on your own device.<br>
&#9744; Copy <b>both</b> designed strings from the green boxes above.</div>`);

// ---------------------------------------------------------------------------
// Section 7: braille proportions, the three treatments side by side.
//
// Round 2 decided "keep proportions, accept the row gutters" while every panel
// was being squashed 40% by the base-line-height bug, which was closing the
// gutters. So the decision was taken against a rendering that no longer exists.
// These three panels differ in one property and nothing else.
// ---------------------------------------------------------------------------
const BRAILLE_CMP_COLS = 108;
parts.push(`<h2>7 &middot; Braille proportions: which line-height passes?</h2>
<p class=note>All three are the same photo, same columns, same transform fit. <b>Only the
line-height rule differs.</b> Each reports its own numbers underneath, so the trade is visible
rather than remembered.<br>
The tension is fixed and cannot be designed away: braille&rsquo;s dot rows do not fill the em box,
so a line-height that makes the <i>picture</i> the right shape leaves <b>gutters</b> between dot
rows, and a line-height that closes the gutters <b>squashes the picture</b>. There is no third
option, only a choice about which artefact you would rather see.</p>`);
parts.push(panel(render(ladderSrc, CODEC.BRAILLE, BRAILLE_CMP_COLS), 'tf',
  'P1. Advance line-height, from the 0.68 CSS guess: what ships today',
  'Geometry corrected by the transform. Glyphs distorted by real advance &divide; 0.68; ' +
  'see the readout. Gutters present.'));
parts.push(panel(render(ladderSrc, CODEC.BRAILLE, BRAILLE_CMP_COLS), 'tfa',
  'P2. Advance line-height, <b>measured</b> first: the F2/F3 fix, ~60 chars',
  'Same geometry, but the line-height comes from the measured advance rather than the guess, so ' +
  'the two scale factors match and glyph distortion goes to zero. Gutters present, and now at ' +
  'their true size for the first time.'));
parts.push(panel(render(ladderSrc, CODEC.BRAILLE, BRAILLE_CMP_COLS), 'tfi',
  'P3. Ink-based line-height: gutters closed, picture squashed',
  'Rows pulled together until the ink is continuous. No gutters. The vertical scale then has to ' +
  'compress the block to restore its height, so the face is shorter than it should be. This is ' +
  'what round 2 rejected, and it is also close to what the round-4 bug was accidentally showing.'));
parts.push(`<div class=verdict><b>Judge, and only this:</b><br>
&#9744; <b>P1</b>: leave the wrapper alone, the distortion is invisible on dots<br>
&#9744; <b>P2</b>: adopt the measured line-height; gutters are acceptable texture<br>
&#9744; <b>P3</b>: gutters are worse than the squash, close them<br>
Gutter size is printed per panel and differs by device. It measured 12.7% of the cell on a
Pixel and 18.2% on an iPad, so <b>if you only check one device, check the phone.</b></div>`);

const html = `<!doctype html>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Plane Text: Test D</title>
<style>
:root{color-scheme:dark}
html,body{margin:0;background:#000;color:#ddd;overflow-x:hidden;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.pad{padding:12px}
/* The CSS-only baseline panel must be measured in the same box the shipping
   wrapper gives it, which has no padding at all (wrap.js: html,body{margin:0}).
   Inside .pad it was being compared against a container 24px narrower than the
   100vw its own font-size calc is written against, so it reported 24px of
   overflow that does not exist in a real message, on top of the few px that
   genuinely do. Full-bleed restores the shipping geometry. */
.bleed{margin-left:-12px;margin-right:-12px}
.cmp{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start}
.cmp>div{flex:1 1 280px;min-width:0;max-width:100%;overflow:hidden}
/* Preview <pre> must not reuse .art: that class sets width:max-content, which
   stops the element shrinking to its flex parent and spills the art across the
   page regardless of font-size. */
pre.rp{margin:0;white-space:pre;font-family:monospace;color:#fff;background:#000;
  font-kerning:none;font-variant-ligatures:none;overflow:hidden;
  text-size-adjust:none;-webkit-text-size-adjust:none}
details{border-top:2px solid #444;margin:0}
details>summary{cursor:pointer;padding:10px 0;font-size:15px;color:#fff;font-weight:600;
  list-style:none;display:flex;align-items:center;gap:8px}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"\\25B8";color:#7ee787;font-size:13px;transition:transform .12s}
details[open]>summary::before{transform:rotate(90deg)}
.dbody{padding-bottom:14px}
.dbody h2{display:none}
/* Not sticky: #diag already owns top:0, and two sticky bars at the same offset
   overlap. With the sections collapsed the page is short enough that these
   buttons are never far away. */
#toc{background:#0d1117;border:1px solid #30363d;border-radius:6px;
  padding:8px 10px;margin:10px 0;display:flex;gap:8px;flex-wrap:wrap}
#toc button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;
  padding:5px 10px;font:12px/1 inherit;cursor:pointer}
.verdict{background:#111;border-left:2px solid #e3b341;padding:8px 10px;margin:10px 0;
  font-size:12px;line-height:1.6}
.verdict b{color:#fff}
.pick{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0d1117;
  border:1px solid #30363d;color:#7ee787;padding:8px 10px;margin:6px 0;
  white-space:pre-wrap;word-break:break-all;-webkit-user-select:all;user-select:all}
h2{font-size:15px;margin:28px 0 6px;padding-top:14px;border-top:2px solid #444;color:#fff}
h3{font-size:13px;margin:16px 0 4px;color:#9aa;font-weight:600}
.note{margin:4px 0 8px;color:#8a8f96;font-size:12px}
pre.art{margin:0 0 4px;font-family:monospace;white-space:pre;width:max-content;
  color:#fff;background:#000;font-kerning:none;font-variant-ligatures:none;
  text-size-adjust:none;-webkit-text-size-adjust:none}
svg.svgart{display:block;width:100%;height:auto;margin-bottom:4px}
.tfbox{overflow:hidden;margin-bottom:4px}
pre.tf{margin:0;font-family:monospace;white-space:pre;width:max-content;color:#fff;
  background:#000;font-kerning:none;font-variant-ligatures:none;transform-origin:0 0}
pre.big{font-family:monospace;font-size:26px;line-height:1.2;white-space:pre;overflow-x:auto;
  background:#111;color:#fff;padding:8px;font-kerning:none;font-variant-ligatures:none}
#diag{position:sticky;top:0;z-index:9;background:#111;color:#eee;padding:10px 12px;
  font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
#diag b{color:#fff}
#diag .ok{color:#7ee787}#diag .bad{color:#ff7b72}#diag .warn{color:#e3b341}
table{border-collapse:collapse;font-size:12px;margin:6px 0}
td,th{border:1px solid #444;padding:3px 7px;text-align:left}
.ruleline{height:2px;background:repeating-linear-gradient(90deg,#f00 0 8px,#fff 8px 16px);margin:2px 0}
.srep{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8a8f96;margin:0 0 10px}
.srep b{color:#fff}
.srep .ok{color:#7ee787}.srep .bad{color:#ff7b72}.srep .warn{color:#e3b341}
.gcomb{font-family:monospace;font-size:20px;white-space:pre;overflow-x:auto;background:#111;
  color:#fff;padding:8px;line-height:1.35;font-kerning:none;font-variant-ligatures:none;
  border-left:2px solid #555}
.gset{margin:10px 0 18px}
.gset h4{margin:0 0 2px;font-size:12px;color:#9aa}
</style>

<div id=diag>measuring…</div>
<div class=pad>
<p class=note><b>Plane Text: Test D, round 5.</b> Build step 0. <b>Android Chrome is the primary
target this round, iOS Safari second.</b> The red dashed line under each panel marks the true
container width: any art extending past it is overflowing, which violates the no-zoom
requirement.<br>
Photo panel source: ${photoLabel}.</p>
<p class=note><b>What changed since round 4.</b> (1) The base line-height on every transform panel
was the raw dot ratio instead of advance &times; ratio, so the shim was crushing every panel to
~60% of its height: invisible on braille, obvious on ramp. Fixed. (2) Every panel now
reports its own measured advance and glyph distortion, so the advance is a number rather than a
judgement about a circle. (3) Section 3 compares codecs at equal <i>characters</i>, not equal
columns. (4) Section 3b measures every glyph in every charset separately, which is the only way to
see shear that affects some lines and not others.</p>
<div id=toc><button id=expandall>Expand all</button><button id=collapseall>Collapse all</button>
<span class=note style="margin:0;align-self:center">Sections are collapsed. Every number in the bar
above was measured with them open, on load.</span></div>
${collapsible(parts.join('\n'))}
<h2>Recording the results</h2>
<p class=note>The diagnostics bar and the per-panel readouts now capture what used to be a table
of hand-copied numbers. Copy the bar, plus the section 3b offender list. Only four things still
need your eyes: (1) which codec in section 3 makes the best picture at equal file size, (2) the
smallest section-2 panel you can still read, (3) the largest section-2 panel that still looks like
text art rather than a grey photo, (4) whether anything overflowed the red line.</p>
</div>

<script>
(function(){
  var ADV=${advanceCssFor(CODEC.BRAILLE)};

  // Everything below measures layout, and a collapsed <details> has no layout:
  // clientWidth and getBoundingClientRect() both return 0, which would zero the
  // advance, the shim's scale factors, the ink extent and the overflow check,
  // silently and with plausible-looking output. So force every section open
  // before measuring and close them again at the end of this script.
  var allDetails=[].slice.call(document.querySelectorAll('details'));
  allDetails.forEach(function(d){ d.open=true; });

  // Measurements Test D exists to collect.
  function measureString(s,fontPx){
    var el=document.createElement('pre');
    el.style.cssText='position:absolute;visibility:hidden;white-space:pre;margin:0;'+
      'font-family:monospace;font-kerning:none;font-variant-ligatures:none;font-size:'+fontPx+'px';
    el.textContent=s;
    document.body.appendChild(el);
    var w=el.getBoundingClientRect().width/Array.from(s).length/fontPx;
    el.remove();
    return w;
  }

  var pres=[].slice.call(document.querySelectorAll('pre.art'));

  // The legacy font-size shim loop lived here and was gated on data-fit, which
  // no panel has set since round 4, so it never ran. It was also the only thing
  // that assigned inkRatio, which is why the diagnostics bar has been reporting
  // "ink extent unavailable" for two rounds. Deleted; the ink measurement is
  // taken from a live panel below, where it is needed: reopening the row-gutter
  // decision requires knowing the line-height that would close them.
  var inkRatio=0, inkFor='';

  // --- transform-fit panels -------------------------------------------
  // Render at a reference size, measure, scale per axis. No advance
  // arithmetic, so nothing here depends on advance being linear in font-size
  // (it is not: hinting snaps advances to whole pixels at small sizes).
  [].slice.call(document.querySelectorAll('pre.tf')).forEach(function(p){
    var d=p.dataset, n=+d.n, box=p.parentNode;
    var f=parseFloat(getComputedStyle(p).fontSize);

    // Ink extent, measured on a live panel in the font the panel resolved to.
    // This is the number the gutter question needs: dot-pitch continuity wants
    // line-height = ink x n/(n-1), while correct proportions want advance x n/m,
    // and the gap between them is the gutter. Round 2 chose proportions, but it
    // chose against art that was being squashed 40%, so the gutters it was
    // comparing against were not the real ones.
    if(!inkRatio&&n>1){
      try{
        var xc=document.createElement('canvas').getContext('2d');
        xc.font=f+'px '+getComputedStyle(p).fontFamily;
        var mm2=xc.measureText(d.g);
        var kk=(mm2.actualBoundingBoxAscent+mm2.actualBoundingBoxDescent)/f;
        if(kk>0){ inkRatio=kk; inkFor=d.g; }
      }catch(e){}
    }
    if(+d.ink){
      try{
        var x=document.createElement('canvas').getContext('2d');
        x.font=f+'px '+getComputedStyle(p).fontFamily;
        var m=x.measureText(d.g);
        var k=(m.actualBoundingBoxAscent+m.actualBoundingBoxDescent)/f;
        if(k>0&&n>1) p.style.lineHeight=k/((n-1)/n);
      }catch(e){}
    }
    var W=box.clientWidth, q=+d.w/+d.dh, H=W/q;
    var r=p.getBoundingClientRect();
    if(!r.width||!r.height) return;

    // 'auto' line-height: measure the advance of the block as rendered, then
    // set line-height from it before scaling. This is not the old font-size
    // arithmetic. Nothing is predicted across a size change, so hinting cannot
    // bite. It makes sy equal sx, so the geometry is still exact and the glyphs
    // are no longer squashed by the guess error.
    if(d.lh==='auto'){
      var mm=+d.w/(+d.c), a0=r.width/(+d.c)/parseFloat(getComputedStyle(p).fontSize);
      p.style.lineHeight=(a0*(+d.n)/mm);
      r=p.getBoundingClientRect();
      if(!r.width||!r.height) return;
    }
    var sx=W/r.width, sy=H/r.height;
    p.style.transform='scale('+sx+','+sy+')';
    box.style.height=H+'px';

    // sy/sx is a measurement, not a diagnostic afterthought.
    //
    // With the base line-height set to ADVANCE_CSS[codec] x (dotsH/dotsW), the
    // shipping value, this reduces algebraically to
    //     sy/sx = a_real / the codec's ADVANCE_CSS
    // for every codec. So each panel reports the real advance in the real
    // fallback font at the real size, hinting included, with no probe string.
    //
    // It is also the exact factor by which the shim distorts glyph shape. The
    // transform is immune to hinting for geometry, not for shape, and that
    // price is zero only when the CSS guess is right. Spelled out here, because
    // "no advance arithmetic" was starting to sound like "the advance no longer
    // matters", and it still does.
    var rep=box.nextElementSibling;
    if(rep&&rep.className==='srep'){
      var a=(sy/sx)*ADV, dist=Math.abs(sy/sx-1);
      var k=dist>0.08?'bad':(dist>0.03?'warn':'ok');
      rep.innerHTML=
        'measured advance <b>'+a.toFixed(4)+'</b> (css guess '+ADV+')'+
        ' &middot; cell '+(W/(+d.c)).toFixed(2)+'px'+
        ' &middot; scale '+sx.toFixed(3)+' x '+sy.toFixed(3)+
        ' &middot; glyph distortion <span class='+k+'>'+
        ((sy/sx-1)>=0?'+':'')+((sy/sx-1)*100).toFixed(1)+'%</span>';
    }
  });

  // --- per-glyph advance audit ----------------------------------------
  // Measures every glyph in every charset separately. The old diagnostics
  // averaged four quadrant glyphs into one number, which is how a charset
  // containing one double-width glyph reports a plausible average and passes.
  // A per-glyph median plus deviation names the offender instead.
  var SETS=${JSON.stringify(GLYPH_SETS)};
  var GF=40, REPS=16;

  function glyphAdvance(ch){
    var el=document.createElement('span');
    el.style.cssText='position:absolute;visibility:hidden;white-space:pre;'+
      'font-family:monospace;font-kerning:none;font-variant-ligatures:none;'+
      'font-size:'+GF+'px';
    var s=''; for(var i=0;i<REPS;i++) s+=ch;
    el.textContent=s;
    document.body.appendChild(el);
    var w=el.getBoundingClientRect().width/REPS/GF;
    el.remove();
    return w;
  }
  function median(a){
    var b=a.slice().sort(function(x,y){return x-y;});
    var h=b.length>>1;
    return b.length%2?b[h]:(b[h-1]+b[h])/2;
  }
  function cp(ch){
    var v=ch.codePointAt(0).toString(16).toUpperCase();
    while(v.length<4) v='0'+v;
    return 'U+'+v;
  }

  var auditHost=document.getElementById('glyphaudit');
  var combHost=document.getElementById('glyphcomb');
  var worstOverall=0, worstSet='';
  if(auditHost) auditHost.innerHTML='';

  SETS.forEach(function(set){
    var glyphs=set.glyphs;
    var adv=glyphs.map(glyphAdvance);
    var med=median(adv);
    var worst=0, offenders=[];
    var rowsHtml='';
    glyphs.forEach(function(ch,i){
      var dev=med?(adv[i]-med)/med:0;
      var ad=Math.abs(dev);
      if(ad>worst) worst=ad;
      if(ad>0.005) offenders.push(cp(ch));
      var k=ad>0.02?'bad':(ad>0.005?'warn':'ok');
      rowsHtml+='<tr><td style="font-family:monospace;font-size:18px">'+
        (ch===' '?'&nbsp;':ch)+'</td><td>'+cp(ch)+'</td><td>'+adv[i].toFixed(4)+
        '</td><td class='+k+'>'+((dev>=0?'+':'')+(dev*100).toFixed(2))+'%</td></tr>';
    });
    if(worst>worstOverall){worstOverall=worst;worstSet=set.name;}
    var wk=worst>0.02?'bad':(worst>0.005?'warn':'ok');
    var d=document.createElement('div');
    d.className='gset';
    d.innerHTML='<h4>'+set.name+': median advance <b>'+med.toFixed(4)+
      '</b>, worst deviation <span class='+wk+'>'+(worst*100).toFixed(2)+'%</span>'+
      (offenders.length?', <span class=bad>offenders: '+offenders.join(' ')+'</span>':
        ' <span class=ok>uniform</span>')+'</h4>'+
      '<p class=note>'+set.note+'</p>'+
      '<table><tr><th>glyph</th><th>code</th><th>advance</th><th>vs median</th></tr>'+
      rowsHtml+'</table>';
    if(auditHost) auditHost.appendChild(d);

    // Visual comb: same glyph repeated, then a marker. Misalignment is the
    // shear, isolated to one character.
    if(combHost){
      var pre=document.createElement('pre');
      pre.className='gcomb';
      var txt='';
      glyphs.forEach(function(ch){
        var line=''; for(var i=0;i<24;i++) line+=ch;
        txt+=line+'|  '+cp(ch)+'\\n';
      });
      var h=document.createElement('h4');
      h.style.cssText='margin:14px 0 2px;font-size:12px;color:#9aa';
      h.textContent=set.name;
      pre.textContent=txt;
      combHost.appendChild(h);
      combHost.appendChild(pre);
    }
  });

  // --- glyph coverage, measured on this device ------------------------
  // Same canvas call runtime calibration would use, so this is a feasibility
  // test as well as a measurement. Rules from spec 5.7: antialiasing on and
  // read the alpha channel (a binary keying test destroys the only information
  // being collected), centre by the glyph's own advance, and pad generously
  // above and below the baseline so descenders are not silently chopped.
  var RAMPS=${JSON.stringify(RAMPS_UNDER_TEST)};
  (function(){
    var host=document.getElementById('rampcov');
    if(!host) return;
    var F=64, cv=document.createElement('canvas');
    cv.width=Math.ceil(F*1.2); cv.height=F*2;
    var cx2=cv.getContext('2d',{willReadFrequently:true});
    if(!cx2){ host.innerHTML='<p class=note class=bad>no 2d canvas, so runtime calibration is not possible on this platform</p>'; return; }

    function coverage(g){
      cx2.setTransform(1,0,0,1,0,0);
      cx2.clearRect(0,0,cv.width,cv.height);
      cx2.fillStyle='#fff';
      cx2.font=F+'px monospace';
      cx2.textAlign='center';
      cx2.textBaseline='middle';
      cx2.imageSmoothingEnabled=true;
      cx2.fillText(g,cv.width/2,cv.height/2);
      var d=cx2.getImageData(0,0,cv.width,cv.height).data, s=0;
      for(var i=3;i<d.length;i+=4) s+=d[i];
      return s/(255*cv.width*cv.height);
    }

    var all={};
    RAMPS.forEach(function(r){ [].forEach.call(r[1],function(g){ if(!(g in all)) all[g]=coverage(g); }); });
    var vals=Object.keys(all).map(function(k){return all[k];});
    var lo=Math.min.apply(null,vals), hi=Math.max.apply(null,vals);
    if(!(hi>lo)){ host.innerHTML='<p class=note>every glyph measured identically. Canvas is not reporting alpha coverage here</p>'; return; }
    var norm=function(g){ return (all[g]-lo)/(hi-lo); };

    var html='';
    RAMPS.forEach(function(r){
      var name=r[0], ramp=r[1], n=ramp.length-1;
      var mono=true, worst=0, rows='';
      for(var i=0;i<ramp.length;i++){
        var g=ramp[i], a=norm(g), assumed=i/n, err=a-assumed;
        if(i&&norm(ramp[i-1])>a) mono=false;
        if(Math.abs(err)>worst) worst=Math.abs(err);
        var inv=i&&norm(ramp[i-1])>a;
        rows+='<tr><td style="font-family:monospace;font-size:18px">'+
          (g===' '?'&nbsp;':g)+'</td><td>'+a.toFixed(3)+'</td><td>'+assumed.toFixed(3)+
          '</td><td class="'+(Math.abs(err)>0.1?'bad':(Math.abs(err)>0.05?'warn':'ok'))+'">'+
          ((err>=0?'+':'')+err.toFixed(3))+'</td><td class=bad>'+(inv?'INVERTED':'')+'</td></tr>';
      }
      html+='<div class=gset><h4>'+name+': '+
        (mono?'<span class=ok>monotonic</span>':'<span class=bad>not monotonic: contains tone inversions</span>')+
        ', worst error <span class="'+(worst>0.1?'bad':(worst>0.05?'warn':'ok'))+'">'+
        (worst*100).toFixed(1)+'%</span> of the tonal range</h4>'+
        '<table><tr><th>glyph</th><th>measured</th><th>assumed</th><th>error</th><th></th></tr>'+
        rows+'</table></div>';
    });
    host.innerHTML=html;
  })();

  // --- section 6: design a ramp from measured coverage ------------------
  // The selection is here, on the device, and not in the generator, because the
  // generator only has Linux fonts. Calibrating against Linux fonts is what
  // produced a non-monotonic default in the first place.
  (function(){
    var host=document.getElementById('rampdesign');
    var prevHost=document.getElementById('rampprev');
    if(!host) return;
    var POOLS={art:${JSON.stringify(POOL_ART)},any:${JSON.stringify(POOL_ANY)}};
    var BLANK='\\u00A0';
    var ART=${JSON.stringify(RAMP_ART)}, FID=${JSON.stringify(RAMP_FIDELITY)};
    var COLS=${PREVIEW_COLS}, ROWS=${previewRows}, B64=${JSON.stringify(previewB64)};
    var N=11;

    var F=64, cv=document.createElement('canvas');
    cv.width=Math.ceil(F*1.2); cv.height=F*2;
    var cx2=cv.getContext('2d',{willReadFrequently:true});
    if(!cx2){ host.innerHTML='<p class=note>no 2d canvas here</p>'; return; }
    function rawCov(g){
      cx2.setTransform(1,0,0,1,0,0);
      cx2.clearRect(0,0,cv.width,cv.height);
      cx2.fillStyle='#fff'; cx2.font=F+'px monospace';
      cx2.textAlign='center'; cx2.textBaseline='middle';
      cx2.imageSmoothingEnabled=true;
      cx2.fillText(g,cv.width/2,cv.height/2);
      var d=cx2.getImageData(0,0,cv.width,cv.height).data,s=0;
      for(var i=3;i<d.length;i+=4) s+=d[i];
      return s/(255*cv.width*cv.height);
    }

    // Measure every glyph once, across both pools and both shipped ramps.
    var cov={};
    function measure(str){ for(var i=0;i<str.length;i++){ var g=str.charAt(i); if(!(g in cov)) cov[g]=rawCov(g); } }
    measure(POOLS.any); measure(ART); measure(FID); measure(BLANK);
    var mx=0; for(var k in cov) if(cov[k]>mx) mx=cov[k];
    if(!(mx>0)){ host.innerHTML='<p class=note>canvas returned no coverage</p>'; return; }
    function nc(g){ return cov[g]/mx; }

    // Pick N glyphs whose coverages sit as close as possible to an even ladder
    // 0, 1/(N-1) ... 1. Slot 0 is always the blank. Exact, by dynamic
    // programming over the coverage-sorted pool: a greedy nearest-target walk
    // gets this wrong whenever two targets want the same glyph.
    function design(poolStr){
      var pool=[];
      for(var i=0;i<poolStr.length;i++){ var g=poolStr.charAt(i); pool.push({g:g,c:nc(g)}); }
      pool.sort(function(a,b){ return a.c-b.c; });
      var n=pool.length, INF=1e9;
      var dp=[],bk=[];
      for(var s=0;s<N;s++){ dp.push([]); bk.push([]); for(var j=0;j<n;j++){ dp[s].push(INF); bk[s].push(-1); } }
      for(var j=0;j<n;j++){ var e0=pool[j].c-0; dp[0][j]=e0*e0; }
      for(var s2=1;s2<N;s2++){
        var best=INF,bi=-1;
        for(var j2=0;j2<n;j2++){
          if(j2>0&&dp[s2-1][j2-1]<best){ best=dp[s2-1][j2-1]; bi=j2-1; }
          if(bi>=0){ var t=s2/(N-1), e=pool[j2].c-t; dp[s2][j2]=best+e*e; bk[s2][j2]=bi; }
        }
      }
      var endJ=-1,endV=INF;
      for(var j3=0;j3<n;j3++) if(dp[N-1][j3]<endV){ endV=dp[N-1][j3]; endJ=j3; }
      var idx=[],cur=endJ;
      for(var s3=N-1;s3>=0;s3--){ idx.unshift(cur); cur=bk[s3][cur]; if(cur<0&&s3>0) break; }
      var out=BLANK;
      for(var q=1;q<idx.length;q++) out+=pool[idx[q]].g;
      return out;
    }

    // The three numbers that decide whether a ramp is any good.
    function stats(r){
      var v=[]; for(var i=0;i<r.length;i++) v.push(nc(r.charAt(i)));
      var mono=true,inv=[];
      for(var i2=1;i2<v.length;i2++) if(v[i2]<v[i2-1]){ mono=false; inv.push(r.charAt(i2-1)+'->'+r.charAt(i2)); }
      var sorted=v.slice().sort(function(a,b){return a-b;});
      var eff=1,gaps=[];
      for(var i3=1;i3<sorted.length;i3++){ var g=sorted[i3]-sorted[i3-1]; gaps.push(g); if(g>=0.05) eff++; }
      var worstErr=0;
      for(var i4=0;i4<v.length;i4++){ var d2=Math.abs(v[i4]-i4/(v.length-1)); if(d2>worstErr) worstErr=d2; }
      return {mono:mono,inv:inv,eff:eff,worstErr:worstErr,vals:v};
    }

    // Resort keeps the same eleven glyphs and only fixes the order. It is the
    // zero-cost half of the fix, shown separately so its limit is visible.
    function resort(r){
      var a=r.split('');
      a.sort(function(x,y){ return nc(x)-nc(y); });
      return a.join('');
    }

    // Payload bytes -> dithered text through an arbitrary ramp. Floyd-Steinberg,
    // same as the encoder, so the four previews differ only in charset.
    var bin=atob(B64), bytes=[];
    for(var b=0;b<bin.length;b++) bytes.push(bin.charCodeAt(b));
    function toText(ramp){
      var n2=ramp.length-1, buf=[];
      for(var i=0;i<bytes.length;i++) buf.push(bytes[i]/255);
      var lines=[];
      for(var y=0;y<ROWS;y++){
        var line='';
        for(var x=0;x<COLS;x++){
          var i5=y*COLS+x, val=buf[i5]; if(val<0)val=0; if(val>1)val=1;
          var kk=Math.round(val*n2), e2=val-kk/n2;
          line+=ramp.charAt(kk);
          if(x+1<COLS) buf[i5+1]+=e2*7/16;
          if(y+1<ROWS){
            if(x>0) buf[i5+COLS-1]+=e2*3/16;
            buf[i5+COLS]+=e2*5/16;
            if(x+1<COLS) buf[i5+COLS+1]+=e2*1/16;
          }
        }
        lines.push(line);
      }
      return lines.join('\\n');
    }

    function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function badge(st){
      return (st.mono?'<span class=ok>monotonic</span>':'<span class=bad>not monotonic ('+esc(st.inv.join(', '))+')</span>')+
        ', <b>'+st.eff+'</b> of '+N+' usable levels, worst error <span class="'+
        (st.worstErr>0.1?'bad':(st.worstErr>0.05?'warn':'ok'))+'">'+(st.worstErr*100).toFixed(1)+'%</span>';
    }

    function run(){
      var dArt=design(POOLS.art), dAny=design(POOLS.any);
      var cands=[
        ['Art, as shipped',ART],
        ['Art, re-sorted by measured coverage',resort(ART)],
        ['Designed, art pool',dArt],
        ['Designed, any pool',dAny],
        ['Fidelity, as shipped',FID]
      ];
      var h='<table><tr><th>ramp</th><th>glyphs</th><th>verdict</th></tr>';
      cands.forEach(function(c){
        var st=stats(c[1]);
        h+='<tr><td>'+c[0]+'</td><td style="font-family:monospace;font-size:17px">'+
           esc(c[1])+'</td><td>'+badge(st)+'</td></tr>';
      });
      h+='</table><p class=note><b>Designed from the art pool.</b> Punctuation only, keeps the '+
         'artefact reading as ASCII art:</p><div class=pick>'+esc(dArt)+'</div>'+
         '<p class=note><b>Designed from the any pool.</b> Letters and digits allowed, better '+
         'tone, drifts toward Fidelity:</p><div class=pick>'+esc(dAny)+'</div>'+
         '<p class=note>The first character of each is U+00A0 and will not show. '+
         'Both are monotonic by construction: the selector walks the pool in coverage order, '+
         'so an inversion is not reachable. What still needs your eyes is whether the glyphs read '+
         'as <i>art</i>, which no measurement decides.</p>';
      host.innerHTML=h;

      if(prevHost){
        // measureString already returns an advance ratio (width / chars /
        // fontPx), not a width. Dividing by the string length and font size
        // again yielded ~0.003, so font-size came out around 1280px and the
        // previews covered the page in white. The units of this helper are the
        // whole reason it exists. Do not re-derive them.
        var adv=measureString('MMMMMMMMMM',20)||0.6;

        // Two-pass, and both passes are load-bearing. The boxes are flex items,
        // so their width is not known until they are in the document; and the
        // <pre> must not carry .art, whose width:max-content makes it refuse to
        // shrink and overflow its flex parent no matter what font-size says.
        prevHost.innerHTML='';
        var boxes=cands.map(function(c){
          var d=document.createElement('div');
          var lab=document.createElement('div');
          lab.className='note'; lab.style.margin='0 0 3px';
          lab.innerHTML='<b>'+c[0]+'</b>';
          var clip=document.createElement('div');
          clip.style.cssText='overflow:hidden;background:#000';
          var pre=document.createElement('pre');
          pre.className='rp';
          clip.appendChild(pre);
          d.appendChild(lab); d.appendChild(clip);
          prevHost.appendChild(d);
          return {box:d,pre:pre,ramp:c[1]};
        });
        boxes.forEach(function(b){
          var w=b.box.clientWidth||prevHost.clientWidth||300;
          b.pre.style.fontSize=(w/COLS/adv)+'px';
          b.pre.style.lineHeight=String(adv);
          b.pre.textContent=toText(b.ramp);
        });
      }
    }
    run();
  })();

  // Container-width markers.
  //
  // These were being inserted as a sibling of the <pre>, inside .tfbox, which
  // has overflow:hidden and a JS-set height, while the <pre> keeps its full
  // natural layout height because transforms do not affect layout. So on every
  // transform panel the marker landed ~3000px down and was clipped away, and
  // "did anything overflow the red line?" has been unanswerable for two rounds.
  // Markers now go after the whole panel block.
  pres.forEach(function(p){
    var r=document.createElement('div');
    r.className='ruleline';
    r.style.width='100%';
    var anchor=p;
    if(p.classList.contains('tf')){
      anchor=p.parentNode;                                  // .tfbox
      if(anchor.nextElementSibling&&
         anchor.nextElementSibling.className==='srep') anchor=anchor.nextElementSibling;
    }
    anchor.parentNode.insertBefore(r,anchor.nextSibling);
  });

  // --- overflow, measured rather than eyeballed -------------------------
  // The no-zoom requirement is the whole design constraint, so whether the art
  // fits should be a number and not a judgement call. Transform panels fit by
  // construction (sx is derived from the container), so the real risks are the
  // CSS-only baseline, the big glyph blocks, and the page as a whole.
  var overflows=[];
  [].slice.call(document.querySelectorAll('pre.art,pre.big,svg.svgart')).forEach(function(el){
    var host=el.parentNode, avail=host.clientWidth;
    var wide=el.classList&&el.classList.contains('tf')
      ? el.getBoundingClientRect().width
      : (el.scrollWidth||el.getBoundingClientRect().width);
    if(avail&&wide>avail+1){
      var lab=el.dataset&&el.dataset.c?el.dataset.c+' cols':(el.className||el.tagName);
      overflows.push(lab+' by '+Math.round(wide-avail)+'px');
    }
  });
  var pageOver=document.documentElement.scrollWidth-innerWidth;

  var F=20;
  var advBraille = measureString('\\u2800\\u28FF\\u2801\\u2847', F);
  var advBlank   = measureString('\\u2800\\u2800\\u2800\\u2800', F);
  var advDotted  = measureString('\\u28FF\\u28FF\\u28FF\\u28FF', F);
  // Not a quadrant advance figure any more. Averaging four glyphs into one
  // number is how a charset containing a double-width glyph reports a plausible
  // average and passes, which is why section 3b exists. The two numbers below
  // are the CP437-era blocks and the Unicode 3.2 corner glyphs, measured
  // separately, which is the split under suspicion.
  var advQuadOld = measureString('\\u2588\\u2580\\u2584\\u258C', F); // CP437 tier
  var advQuadNew = measureString('\\u2596\\u2597\\u2598\\u259A', F); // Unicode 3.2 tier
  var quadSplit  = Math.abs(advQuadOld-advQuadNew)/advQuadOld;
  var advLatin   = measureString('MMMM', F);
  var shear = Math.abs(advBlank-advDotted)/advDotted;

  // Tofu detection: a missing glyph usually falls back to a box of a
  // different width than the Latin monospace advance.
  var tofuRisk = Math.abs(advBraille-advLatin)/advLatin;

  function pct(x){return (x*100).toFixed(1)+'%';}
  function cls(v,warn,bad){return v>bad?'bad':(v>warn?'warn':'ok');}

  // Aspect error, given the line-height the CSS baseline shipped with.
  var assumed=${advanceCssFor(CODEC.BRAILLE)};
  var aspectCss=(assumed*2/4)/(advBraille/2);

  var accessClamp='';
  var probe=document.createElement('div');
  probe.style.cssText='position:absolute;visibility:hidden;font-size:6px';
  probe.textContent='x';
  document.body.appendChild(probe);
  var got=parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  if(Math.abs(got-6)>0.51) accessClamp=' <span class=bad>MIN FONT CLAMPED to '+got.toFixed(1)+'px</span>';

  // Gutter arithmetic. Continuity wants line-height = ink x n/(n-1); correct
  // proportions want advance x n/m. The difference is the gutter, in em per
  // row, and it is what round 2 traded away while looking at art that was being
  // squashed 40% vertically, which was closing the gutters for free.
  var lhInk=inkRatio*(4/3), lhProp=advBraille+advBraille, gutter=lhProp-lhInk;
  var inkLine = inkRatio
    ? '<b>ink extent</b> of '+inkFor+': <b>'+inkRatio.toFixed(3)+'</b> em'+
      ' &middot; continuity line-height '+lhInk.toFixed(3)+
      ' vs proportion line-height '+lhProp.toFixed(3)+
      ' &middot; <span class="'+cls(Math.abs(gutter),0.05,0.15)+'">gutter '+
      gutter.toFixed(3)+' em per row ('+((gutter/lhProp)*100).toFixed(1)+'% of the cell)</span><br>'
    : '<b>ink extent</b> unavailable (measureText actualBoundingBox unsupported)<br>';

  document.getElementById('diag').innerHTML = inkLine +
    '<b>viewport</b> '+innerWidth+'x'+innerHeight+' css px &middot; <b>dpr</b> '+(devicePixelRatio||1)+accessClamp+'<br>'+
    '<b>advance</b> braille <span class="'+cls(Math.abs(advBraille-0.6),0.04,0.08)+'">'+advBraille.toFixed(4)+'</span>'+
    ' &middot; latin '+advLatin.toFixed(4)+' &middot; css guess '+assumed+
    ' &middot; <b>glyph distortion at this guess</b> <span class="'+cls(Math.abs(advBraille/assumed-1),0.03,0.08)+'">'+
      ((advBraille/assumed-1)>=0?'+':'')+pct(advBraille/assumed-1)+'</span><br>'+
    '<b>shear risk</b> blank vs dotted braille: <span class="'+cls(shear,0.001,0.01)+'">'+pct(shear)+'</span>'+
    ' &middot; quadrant CP437 vs U3.2 tier: <span class="'+cls(quadSplit,0.001,0.01)+'">'+pct(quadSplit)+'</span>'+
    ' ('+advQuadOld.toFixed(4)+' vs '+advQuadNew.toFixed(4)+')'+
    ' &middot; <b>tofu risk</b> braille vs latin: <span class="'+cls(tofuRisk,0.03,0.10)+'">'+pct(tofuRisk)+'</span><br>'+
    '<b>worst per-glyph deviation</b> <span class="'+cls(worstOverall,0.005,0.02)+'">'+pct(worstOverall)+
    '</span> in '+worstSet+', see section 3b<br>'+
    '<b>aspect error</b> with CSS-only sizing: <span class="'+cls(Math.abs(aspectCss-1),0.03,0.08)+'">'+
      ((aspectCss-1)>=0?'+':'')+pct(aspectCss-1)+'</span>'+
    ' &middot; correct line-height for this font: <b>'+(advBraille+advBraille).toFixed(3)+'</b><br>'+
    '<b>overflow</b> '+(overflows.length
      ? '<span class=bad>'+overflows.length+' panel(s): '+overflows.join(', ')+'</span>'
      : '<span class=ok>none</span>')+
    ' &middot; page '+(pageOver>1?'<span class=bad>+'+pageOver+'px</span>':'<span class=ok>fits</span>')+'<br>'+
    '<b>cols that fit</b> at 3.6px advance: '+Math.floor(innerWidth/3.6)+
    ' &middot; at this font 6px: '+Math.floor(innerWidth/(6*advBraille));

  // Measuring is done. Collapse, and wire the two controls.
  allDetails.forEach(function(d){ d.open=false; });
  var ea=document.getElementById('expandall'), ca=document.getElementById('collapseall');
  if(ea) ea.addEventListener('click',function(){ allDetails.forEach(function(d){ d.open=true; }); });
  if(ca) ca.addEventListener('click',function(){ allDetails.forEach(function(d){ d.open=false; }); });
})();
</script>`;

writeFileSync(outPath, html, 'utf8');
console.error(`wrote ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
console.error(photos.length
  ? `sources: ${photoLabel}\nladders use: ${ladderSrc.label} (largest)`
  : 'no photo supplied: sections 2 and 3 use the geometry target');
