// Plane Text: the Compatible wrapper (spec 4.4).
//
// Markup and CSS. No decoder. The payload is the art: one row per line inside a
// <pre>, readable in any text viewer before a browser touches it.
//
// The only script is a fit shim. Rule: JS may adjust layout, it may never be
// the rendering path. The image exists in the DOM as text before any script
// runs, and renders correctly if the script never runs at all.

import { CELL_DOTS, advanceCssFor, INVERT_DEFAULT, STROKE_EM } from './constants.js';
import { baseLineHeight } from './sizing.js';
import { lintWrapper, lintPayload, assertClean } from './lint.js';
import { emitHeader } from './wire.js';

// The fit shim, written under the banned-character rule:
//   no *        -> "v+v" instead of "v*2"
//   no _        -> single-letter identifiers only
//   no backtick -> string concatenation
//   no ~
//
// It measures the rendered art itself rather than a probe string. An earlier
// version injected a hidden span of sample glyphs; measuring the <pre> is
// shorter and more accurate, because it uses the real payload in the real
// fallback font at the real size. It requires `width:max-content` on the <pre>
// so that offsetWidth hugs the content instead of clamping to the container.
// Without that, the under-fill case (the expected case, since the CSS advance
// guess is set high) measures as a perfect fit and the shim does nothing.
//
// Two adjustments:
//   font-size    fits the grid to the container exactly, reclaiming the ~10%
//                of width the CSS baseline gives away.
//   line-height  fixes the aspect ratio. Impossible in CSS at any price: the
//                aspect ratio is invariant under font-size, and CSS cannot
//                read a font's advance width.
// What line-height cannot do (device-tested twice).
//
// There are two lattices, and only one of them is ours:
//
//   sampling lattice  the encoder treats each cell as a uniform 2x4 grid of
//                     sub-rectangles: pitch = advance/2 across, lh/4 down
//   rendered lattice  the font draws its dots wherever the designer put them,
//                     inside an ink box smaller than the em box
//
// The horizontal pitch is the font's advance and is not adjustable. That leaves
// line-height carrying two constraints at once, and it can satisfy one:
//
//   lh = 2 x advance   correct overall proportions, but dots bunch inside a
//                      cell and gap between cells   -> visible row gutters
//   lh = ink x 4/3     continuous dots, no gutters, but the block is
//                      vertically compressed        -> wrong proportions
//
// Both were observed on device. Decision 2026-08-08: keep proportions, accept
// the gutters. Inter-cell gaps are conventional in braille art and read as
// texture; a squashed face reads as broken. A third option, measure the real
// dot lattice and correct with transform: scaleY, was rejected for v1 as ~150
// extra bytes that still cannot fix the horizontal axis.
// The fit shim, transform-based since 2026-08-08.
//
// Render at whatever the CSS gives, measure the rendered block, then scale it
// per axis to the target box:
//
//   sx = containerWidth / measuredWidth    exact fit
//   sy = targetHeight   / measuredHeight   exact aspect
//
// where targetHeight = containerWidth / (dotsW / dotsH), and that ratio is a
// constant because the capture aspect is fixed (constants.js). The shim never
// reasons about advance widths, ink extents or glyph internals.
//
// Two things this buys that the font-size approach could not:
//
//   1. Immunity to hinting. Browsers snap glyph advances to whole pixels at
//      small sizes, so advance is not linear in font-size, and the old
//      font-size arithmetic silently assumed it was.
//   2. A generic aspect fix. Quadrant rendered vertically stretched on device
//      and braille needed a per-codec line-height; scaling to a known target
//      corrects both without knowing why either was wrong.
//
// What it still cannot do: close the row gutters. Scaling multiplies intra-cell
// and inter-cell spacing by the same factor, so their ratio is invariant.
// Gutters were re-confirmed as acceptable 2026-08-09, this time on art that was
// the right shape: Test D section 7 ranked correct proportions with visible
// gutters (P2) above closed gutters with a squashed picture (P3). The round-2
// decision was right; it had been taken while a line-height bug squashed every
// panel 40% and thereby hid the gutters it claimed to accept.
//
// ---------------------------------------------------------------------------
// Measured line-height, added 2026-08-09 (Test D section 7, panel P2).
//
// The transform makes geometry immune to a wrong advance. It does not make
// glyph shape immune: sy/sx reduces to a_real / a_css, so a CSS advance that is
// 12% high squashes every glyph by 12% while the picture stays correctly
// proportioned. Measuring the advance and setting line-height from it before
// scaling makes sx equal sy, and the distortion goes to zero.
//
// Why it ships. On braille it is nearly invisible: glyph distortion at the
// per-codec baselines is 1.4% on Android and 3.9% on iPad, and the device
// verdict on P1 versus P2 was "very slight, but for sanity's sake keep P2". It
// earns its ~60 characters on the other two codecs:
//   ramp      was distorted 11.8% at the old shared 0.68 guess
//   quadrant  advance spans 0.6021-0.7080 across two devices, so no fixed CSS
//             value works and only a runtime measurement recovers it
//
// Written under the banned-character rule, which shapes the arithmetic: there
// is no '*', so `v x n/m` is spelled `v/(m/n)` and the ratio ships precomputed
// in data-r. Every row is exactly `cols` characters (gridToRows never trims),
// so dividing the rendered width by data-c gives the real advance.
// ---------------------------------------------------------------------------
const SHIM =
  '(function(){' +
  'var p=a,d=p.dataset,q=+d.q,b=p.parentNode;' +
  'var r=p.getBoundingClientRect();' +
  'if(!r.width||!r.height)return;' +
  // Measured advance = renderedWidth / columns / fontSize. Real font, real
  // size, hinting included. Nothing is predicted across a size change.
  'var f=parseFloat(getComputedStyle(p).fontSize),v=r.width/(+d.c)/f;' +
  'if(v>0)p.style.lineHeight=v/(+d.r);' +
  'r=p.getBoundingClientRect();' +
  // Available width comes from the container, never the viewport. 100vw and
  // innerWidth both include the scrollbar and neither knows about padding on
  // an ancestor; targeting them pushed the art off-screen on a narrow window.
  'var W=b.clientWidth,H=W/q;' +
  'if(!r.width||!r.height)return;' +
  'p.style.transformOrigin="0 0";' +
  'p.style.transform="scale("+W/r.width+","+H/r.height+")";' +
  'b.style.height=H+"px"' +
  '})()';

// The <title>, and therefore the filename the recipient's browser offers when
// they save the page. Added 2026-08-13.
//
// A bare `zap 20260809 1432` tells the recipient nothing about what they have,
// and this is the only string in the message a human reads as prose. The prefix
// names the format the way the wire magic PLANETEXT1 does.
//
// It stays prose rather than a slug -- app/words.js's argument, and right --
// because sort order barely matters on the receiving side, where there is one
// file rather than a folder of them. The sender's copy has to sort, and
// app/words.js fileName() makes that one date-first.
//
// Applied here rather than at the call site so wrapperCost() in encode.js
// measures the string this emits. A prefix added downstream would not be
// counted, and the budget would run 13 characters optimistic on every
// message.
export const TITLE_PREFIX = 'Plane Text';

export function titleFor(name) {
  const raw = String(name ?? '').trim();
  if (!raw || raw === TITLE_PREFIX) return TITLE_PREFIX;
  if (raw.startsWith(TITLE_PREFIX + ' — ')) return raw;
  return `${TITLE_PREFIX} — ${raw}`;
}

export function wrap(rows, { codec, cols, rows: nRows, invert = INVERT_DEFAULT, stroke = null, ramp = null, title = 'Plane Text' }) {
  const cell = CELL_DOTS[codec];
  if (!cell) throw new Error(`unknown codec ${codec}`);

  // Stroke is per codec and defaults to braille-only. See STROKE_EM.
  if (stroke == null) stroke = STROKE_EM[codec] ?? 0;

  // line-height = advance x (cellDotsH / cellDotsW) gives correct overall
  // proportions. See the SHIM note above for why it also leaves row gutters and
  // why that is the accepted trade.
  const hRatio = cell.h / cell.w;

  // The CSS advance baseline is per codec since 2026-08-09, and every value
  // rounds up from the largest device measurement. The old shared 0.68 was
  // below braille's real 0.7002 on Android, the fatal direction, and because
  // overflow-x:hidden is set below it did not scroll, it clipped ~3% off the
  // right edge of every braille message with JS disabled.
  //
  // Shared with the Test D harness via sizing.js. It was written out separately
  // in both places, they diverged, and the harness spent a round reporting on
  // geometry this wrapper never emits.
  //
  // The shim's sy/sx ratio still comes out as a_real / a_css, the factor by
  // which glyph shapes are distorted, but the shim now measures the advance and
  // resets line-height before scaling, so that factor collapses to 1 whenever
  // JS runs. This baseline governs the no-JS case only.
  const advanceCss = advanceCssFor(codec);
  const baseLh = baseLineHeight(codec).toFixed(3);

  // Dark is the default. The encoder must have flipped polarity to match
  // (encode.js); swapping only these two values yields a negative.
  const fg = invert ? '#fff' : '#000';
  const bg = invert ? '#000' : '#fff';

  // Synthetic bolding. As a dot nears one device pixel, antialiasing spreads
  // its ink over neighbours and it reads as grey rather than solid. Stroking
  // the outline thickens the dot and restores contrast. Costs ~40 characters
  // and nothing in the payload.
  const strokeCss = stroke
    ? '-webkit-text-stroke:' + stroke + 'em ' + fg + ';'
    : '';

  // Every declaration earns its place:
  //   width:max-content      required by the shim's measurement (see above)
  //   overflow-x:hidden      a mis-guessed advance must not produce a scrollbar
  //   font-kerning/ligatures a font altering advance between adjacent cells
  //                          would shear the grid, not merely stretch it
  //   text-size-adjust       the only available defence against mobile font
  //                          boosting. Does not cover a user-set accessibility
  //                          minimum font size (Test D question 6).
  // Target dot geometry. q = dotsW/dotsH is what the shim scales to, and it is
  // a constant of the format because the capture aspect is fixed.
  const rowCount = nRows != null ? nRows : rows.length;
  const dotsW = cols * cell.w;
  const dotsH = rowCount * cell.h;
  const q = (dotsW / dotsH).toFixed(6);

  const html =
    '<!doctype html><meta charset=utf-8>' +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    '<title>' + titleFor(title) + '</title>' +
    '<style>' +
    'html,body{margin:0;background:' + bg + ';overflow-x:hidden}' +
    '#b{overflow:hidden}' +
    '#a{margin:0;width:max-content;transform-origin:0 0;font-family:monospace;color:' + fg + ';' +
    'white-space:pre;font-size:calc(100vw/' + cols + '/' + advanceCss + ');' +
    'line-height:' + baseLh + ';font-kerning:none;font-variant-ligatures:none;' +
    strokeCss +
    'text-size-adjust:none;-webkit-text-size-adjust:none}' +
    '</style>' +
    // data-r = cellDotsW / cellDotsH. Precomputed because the shim has no '*'
    // available under the banned-character rule, so it spells the measured
    // line-height as v/(m/n) rather than v x n/m.
    '<div id=b><pre id=a role=img aria-label="Photo as text" data-c=' + cols +
    ' data-r=' + (cell.w / cell.h) + ' data-q=' + q + '>' +
    rows.join('\n') +
    '</pre></div>' +
    '<script>' + SHIM + '</script>';

  // Line 1 is the header, replacing the bare magic string (2026-08-09,
  // spec 4.1/4.2). It carries only what the rows cannot say for themselves:
  // version, codec, polarity and the ramp. Geometry goes on it too, but as
  // self-description rather than as data -- wire.js treats the rows as
  // authoritative and warns on a mismatch, so a message whose header is lost
  // or wrong still decodes.
  //
  // wrapperCost() therefore counts the header as wrapper overhead, which is
  // correct: it is exactly the cost of everything that is not the art.
  return emitHeader({ codec, cols, rows: rowCount, invert, ramp }) + '\n' + html;
}

// Wrapper overhead in characters, excluding the art.
export function wrapperCost(rows, opts) {
  return wrap(rows, opts).length - rows.join('\n').length;
}

export function buildMessage(rows, opts) {
  const message = wrap(rows, opts);
  assertClean([...lintWrapper(message), ...lintPayload(rows.join('\n'))]);
  return message;
}

export { SHIM };
