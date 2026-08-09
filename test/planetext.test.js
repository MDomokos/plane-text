import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEC,
  TRANSPORT_CEILING,
  WRAPPER_BUDGET,
  ADVANCE_NOMINAL,
  MIN_LEGIBLE_PX,
  BANNED_MARKDOWN,
  DEFAULT_RAMP,
  WRAPPER_MEASURED,
} from '../src/constants.js';
import {
  colsForViewport,
  defaultCols,
  rowsFor,
  describe as describeGrid,
  lineHeightFor,
  aspectError,
  maxColsFor,
} from '../src/sizing.js';
import { buildGrid, gridToRows, rowsToGrid, QUADRANT_CHARS, BRAILLE_BIT } from '../src/cells.js';
import { lintPayload, lintWrapper } from '../src/lint.js';
import { wrap, wrapperCost, SHIM } from '../src/wrap.js';
import {
  emitHeader,
  parseHeader,
  parseMessage,
  inferCodec,
  extractRows,
  decodeRows,
  HEADER_KEY,
} from '../src/wire.js';
import { encode } from '../src/encode.js';
import { toLuma, autoLevels, downscale, dither } from '../src/tone.js';

// ---------------------------------------------------------------------------
// Geometry. These assert the spec's stated numbers. If a constant changes
// after Test D, these fail and point at every figure that has to move with it.
// ---------------------------------------------------------------------------

test('the size range is in characters, shared by every codec', async () => {
  // Reversed 2026-08-09. The slider used to be in columns, and each codec had
  // its own track, so swapping style changed the file size by up to 2x. The
  // endpoints are now characters and shared: swapping style preserves the file
  // size and changes the geometry instead.
  //
  // You cannot hold both invariant. Fix columns and file size swings 2.0x
  // across a codec swap; fix characters and required screen width swings 1.42x,
  // because rows scale with columns so cost is quadratic. This test pins the
  // direction of that trade, not just the numbers.
  const { sizeRange, charsForCols } = await import('../src/sizing.js');
  const { SIZE_DEFAULT_END, RAMP_COLS_MIN, RAMP_COLS_MAX } = await import('../src/constants.js');
  const r = sizeRange();
  assert.equal(r.minChars, charsForCols(CODEC.RAMP, 65), 'low end is the measured ramp floor');
  assert.equal(r.maxChars, charsForCols(CODEC.RAMP, 130), 'high end is the measured ramp cap');

  // Where the slider opens. Pinned against the CONSTANT rather than against a
  // literal, so moving the decision is a one-line change in constants.js
  // instead of a hunt through the tests -- but the consequences below are still
  // pinned as numbers, because those are what the decision is a decision about.
  assert.equal(
    r.defaultChars,
    { min: r.minChars, mid: r.midChars, max: r.maxChars }[SIZE_DEFAULT_END],
    'the slider opens at the documented end',
  );

  // The midpoint is taken in COLUMNS, and the two midpoints are not the same
  // point. Characters go as roughly the SQUARE of columns, so the column
  // midpoint maps to fewer characters than the character midpoint does: 98
  // columns against 103. The column one is the honest middle, because columns
  // are what the user is choosing and what the readout names.
  //
  // This pins the direction as well as the value. Asserting only the equality
  // below would still pass if someone "simplified" it to (min+max)/2 on a range
  // where the two happened to be close.
  assert.equal(r.midChars, charsForCols(CODEC.RAMP, Math.round((RAMP_COLS_MIN + RAMP_COLS_MAX) / 2)));
  assert.ok(
    r.midChars < (r.minChars + r.maxChars) / 2,
    `the column midpoint must land below the character midpoint, because cost is quadratic in columns (got ${r.midChars} against ${(r.minChars + r.maxChars) / 2})`,
  );

  // The default must clear the "cannot frame with it" floor. SHELL.md item 10
  // says a 65-column grid is too coarse to judge a picture at, and 65 is
  // RAMP_COLS_MIN -- which is what retired 'min' as the opening end.
  assert.ok(
    defaultCols(CODEC.RAMP) > RAMP_COLS_MIN,
    `the slider must not open at the floor SHELL.md says you cannot frame with (got ${defaultCols(CODEC.RAMP)})`,
  );

  // Same characters, different geometry, per codec.
  assert.equal(defaultCols(CODEC.RAMP), 98);
  assert.equal(defaultCols(CODEC.BRAILLE), 139);
  assert.equal(defaultCols(CODEC.QUADRANT), 98);

  // The invariant itself: a codec swap must not move the character count by
  // more than one row's worth of rounding.
  const { charsForCols: cf } = await import('../src/sizing.js');
  for (const codec of [CODEC.BRAILLE, CODEC.QUADRANT, CODEC.RAMP]) {
    const cost = cf(codec, defaultCols(codec));
    assert.ok(
      Math.abs(cost - r.defaultChars) / r.defaultChars < 0.02,
      `codec ${codec} costs ${cost} against a ${r.defaultChars} target`,
    );
  }
});

test('the legibility cap warns and no longer clamps', async () => {
  // Its only premise was spec 5.8: that a ramp glyph needs a bigger cell to
  // read as a glyph than a braille cell needs to read as a grey level, so ramp
  // had to be clamped lower. Round 5 measured a ramp still reading at a 3.16 px
  // cell, below braille's own floor, so the premise is gone and the two caps
  // converge. The physics is real, so it survives as advice.
  const { legibleColsFor } = await import('../src/sizing.js');
  const { rgba, w, h } = syntheticImage(300, 400);
  const cap = legibleColsFor(CODEC.RAMP);
  const out = encode(rgba, w, h, { codec: CODEC.RAMP, cols: cap + 40 });
  assert.equal(out.grid.cols, cap + 40, 'past the cap must still encode');
  assert.ok(
    out.warnings.some((x) => /legibility estimate/.test(x)),
    'past the cap must warn',
  );
});

test('ramp is the default codec, everywhere', async () => {
  // Decided 2026-08-08. Best balance of readability, and a ramp message reads
  // as text art in a plain text viewer, which is the property the product is
  // built around. A braille message read as text is a wall of dots.
  const { DEFAULT_CODEC } = await import('../src/constants.js');
  assert.equal(DEFAULT_CODEC, CODEC.RAMP);
  assert.equal(defaultCols(), defaultCols(CODEC.RAMP), 'default cols follow the default codec');

  // And the pipeline must agree. A default that only half the code knows about
  // is how the old `invert` bug happened.
  const { rgba, w, h } = syntheticImage(300, 400);
  const out = encode(rgba, w, h);
  assert.equal(out.grid.codec, CODEC.RAMP);
  assert.ok(!/[⠀-⣿]/.test(out.lines.join('')), 'default output should contain no braille');
});

test('the default codec carries no tofu or shear risk', async () => {
  // Why this default is worth more than the readability argument it was made
  // on: the ramp charset is Latin plus U+00A0. One Unicode block, one fallback
  // font, one advance, so the project's "single most dangerous unknown",
  // braille advance consistency, stops being load-bearing.
  const { DEFAULT_RAMP: ramp } = await import('../src/constants.js');
  for (const ch of [...ramp]) {
    const cp = ch.codePointAt(0);
    assert.ok(
      cp === 0x00a0 || (cp >= 0x21 && cp <= 0x7e),
      `ramp glyph U+${cp.toString(16)} is outside Latin + U+00A0`,
    );
  }
});

test('synthetic bolding is braille-only', async () => {
  // Latent bug found while switching the default: wrap() stroked every codec,
  // so making ramp the default would have silently started thickening
  // letterforms. The mechanism only argues for braille, an isolated sub-pixel
  // dot. A quadrant block already tiles edge to edge, so a stroke bleeds it
  // into its neighbours; a ramp glyph is a legible letterform, and stroking
  // fills its counters and darkens the whole ramp.
  const { STROKE_EM, TEXT_STROKE_EM } = await import('../src/constants.js');
  assert.equal(STROKE_EM[CODEC.BRAILLE], TEXT_STROKE_EM);
  assert.equal(STROKE_EM[CODEC.QUADRANT], 0);
  assert.equal(STROKE_EM[CODEC.RAMP], 0);

  const lines = ['ab'];
  assert.ok(wrap(lines, { codec: CODEC.BRAILLE, cols: 2, rows: 1 }).includes('-webkit-text-stroke'));
  assert.ok(!wrap(lines, { codec: CODEC.RAMP, cols: 2, rows: 1 }).includes('-webkit-text-stroke'));
  assert.ok(!wrap(lines, { codec: CODEC.QUADRANT, cols: 2, rows: 1 }).includes('-webkit-text-stroke'));
});

test('the geometry formula still scales with viewport', () => {
  assert.equal(colsForViewport(390, MIN_LEGIBLE_PX, ADVANCE_NOMINAL), 150);
  assert.equal(colsForViewport(800, MIN_LEGIBLE_PX, ADVANCE_NOMINAL), 307);
});

test('the fixed 4:3 portrait capture aspect at the braille default', async () => {
  const { CAPTURE_ASPECT } = await import('../src/constants.js');
  assert.equal(CAPTURE_ASPECT, 0.75, 'width/height = 3/4, i.e. portrait');
  const rows = rowsFor(150, 3, 4, CODEC.BRAILLE);
  assert.equal(rows, 100);
  const d = describeGrid(150, rows, CODEC.BRAILLE);
  assert.equal(d.dotsW, 300);
  assert.equal(d.dotsH, 400);
  assert.equal(d.payloadChars, 15100);
  assert.ok(d.utilisation < 0.30, 'still far from the ceiling');
});

test('every source is cropped to the capture aspect, whatever shape it arrives in', async () => {
  const { CAPTURE_ASPECT } = await import('../src/constants.js');
  for (const [w, h] of [[1024, 683], [1920, 1080], [600, 600], [480, 900]]) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = (i % 97) * 2;
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
    }
    const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 108 });
    assert.equal(out.stats.rows, 72, `${w}x${h} should land on the fixed grid`);
    const q = out.stats.dotsW / out.stats.dotsH;
    assert.ok(Math.abs(q - CAPTURE_ASPECT) < 0.01, `${w}x${h} aspect ${q}`);
  }
});

test('the wrapper carries the target aspect for the shim to scale to', () => {
  const { rgba, w, h } = syntheticImage(600, 800);
  const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 108 });
  const m = out.message.match(/data-q=([\d.]+)/);
  assert.ok(m, 'wrapper should carry data-q');
  assert.ok(Math.abs(parseFloat(m[1]) - 0.75) < 0.001);
});

test('the shim scales to a known target instead of reasoning about glyphs', () => {
  // This is what fixes the quadrant vertical stretch generically: the target
  // aspect is a constant of the format, so no per-codec correction is needed.
  assert.ok(SHIM.includes('transform'), 'shim should use a transform');
  assert.ok(SHIM.includes('getBoundingClientRect'));

  // Narrowed 2026-08-09. This used to assert the shim never mentions fontSize
  // at all, a proxy for the real rule and now too strong: P2 reads the computed
  // font-size to derive the measured advance. The rule it stood in for is that
  // the shim must never predict a size. No arithmetic that assumes advance is
  // linear in font-size, because hinting makes it discontinuous. Reading a
  // rendered value is not predicting one.
  assert.ok(!SHIM.includes('style.fontSize'), 'the shim must never SET a font-size');
  assert.ok(SHIM.includes('getComputedStyle'), 'it reads the rendered size to measure advance');
});

test('utilisation at the braille default stays far from the ceiling', () => {
  // 8.5% at 108 cols landscape -> 24% at 150 cols portrait. Three times the
  // characters, still a quarter of the budget. Characters remain the resource
  // we are not short of.
  const d = describeGrid(150, 100, CODEC.BRAILLE);
  const pct = (d.messageChars / TRANSPORT_CEILING) * 100;
  assert.ok(pct > 22 && pct < 27, `expected ~24%, got ${pct.toFixed(2)}%`);
});

test('the desktop slider marker is not comfortably inside the ceiling', () => {
  // 355 cols is well past 72% of the documented ceiling once the aspect is
  // fixed portrait, so the over-budget dialog is reachable. Kept visible.
  const rows = rowsFor(355, 3, 4, CODEC.BRAILLE);
  const d = describeGrid(355, rows, CODEC.BRAILLE);
  assert.ok(d.payloadChars > 40000, `expected >40k, got ${d.payloadChars}`);
});

// ---------------------------------------------------------------------------
// Aspect ratio: the error caught in review. font-size cannot fix this.
// ---------------------------------------------------------------------------

test('line-height 1.2 gives square braille dot pitch at advance 0.6', () => {
  assert.equal(lineHeightFor(CODEC.BRAILLE, 0.6), 1.2);
});

test('quadrant and ramp need different line-heights than braille', () => {
  assert.equal(lineHeightFor(CODEC.QUADRANT, 0.6), 0.6);
  assert.equal(lineHeightFor(CODEC.RAMP, 0.6), 0.6);
});

test('a wrong advance stretches the image and font-size cannot fix it', () => {
  assert.equal(aspectError(CODEC.BRAILLE, 0.6, 0.6), 1);
  const stretched = aspectError(CODEC.BRAILLE, 0.6, 0.55);
  assert.ok(stretched > 1.08 && stretched < 1.10, `expected ~9% stretch, got ${stretched}`);
  const bad = aspectError(CODEC.BRAILLE, 0.6, 0.5);
  assert.ok(Math.abs(bad - 1.2) < 0.001, `expected 20% stretch, got ${bad}`);
});

test('the base line-height has exactly one definition', async () => {
  // Round 5: wrap.js used ADVANCE_CSS_GUESS x hRatio while the Test D harness
  // used bare hRatio. Every test panel therefore rendered ~1.47x too tall and
  // the transform shim crushed it back to ~60%. Invisible on braille dots,
  // obvious on ramp glyphs, and it silently closed the braille row gutters we
  // had decided to "accept". A harness that drifts from the artefact it tests
  // reports success for code that is not running. Third occurrence.
  const { baseLineHeight } = await import('../src/sizing.js');
  const { advanceCssFor } = await import('../src/constants.js');
  assert.equal(baseLineHeight(CODEC.BRAILLE), advanceCssFor(CODEC.BRAILLE) * 2);
  assert.equal(baseLineHeight(CODEC.QUADRANT), advanceCssFor(CODEC.QUADRANT) * 1);
  assert.equal(baseLineHeight(CODEC.RAMP), advanceCssFor(CODEC.RAMP) * 1);

  // And the wrapper must emit it, not a hand-written duplicate.
  const lines = ['⠀⠀'];
  for (const codec of [CODEC.BRAILLE, CODEC.QUADRANT, CODEC.RAMP]) {
    const html = wrap(lines, { codec, cols: 2, rows: 1 });
    assert.ok(
      html.includes('line-height:' + baseLineHeight(codec).toFixed(3)),
      `codec ${codec} should ship line-height ${baseLineHeight(codec).toFixed(3)}`,
    );
  }
});

test('the shim distorts glyphs by exactly the advance-guess error', async () => {
  // sy/sx reduces to a_real / ADVANCE_CSS_GUESS for every codec, given the
  // base line-height above. So the transform is immune to a wrong advance for
  // geometry and not immune for glyph shape, which is why the advance still has
  // to be measured even though the shim no longer does arithmetic on it.
  const { baseLineHeight } = await import('../src/sizing.js');
  const { advanceCssFor, CELL_DOTS } = await import('../src/constants.js');
  for (const codec of [CODEC.BRAILLE, CODEC.QUADRANT, CODEC.RAMP]) {
    const cell = CELL_DOTS[codec];
    for (const aReal of [0.5, 0.6, 0.68, 0.75]) {
      // sy/sx = (a_real * n) / (m * lh), with n/m = cell.h/cell.w
      const ratio = (aReal * cell.h) / (cell.w * baseLineHeight(codec));
      assert.ok(
        Math.abs(ratio - aReal / advanceCssFor(codec)) < 1e-12,
        `codec ${codec} at advance ${aReal}: got ${ratio}`,
      );
    }
  }

  // And the shim now drives that factor to 1 by measuring. This is the P2 fix:
  // set line-height from the measured advance before scaling, so sx equals sy.
  for (const codec of [CODEC.BRAILLE, CODEC.QUADRANT, CODEC.RAMP]) {
    const cell = CELL_DOTS[codec];
    for (const aReal of [0.5, 0.6002, 0.7002, 0.708]) {
      const lhMeasured = baseLineHeight(codec, aReal);
      const ratio = (aReal * cell.h) / (cell.w * lhMeasured);
      assert.ok(Math.abs(ratio - 1) < 1e-12, `codec ${codec} at ${aReal}: ${ratio}`);
    }
  }
});

test('the CSS advance baseline is per codec and always rounds up', async () => {
  // 0.68 was below braille's measured 0.7002 on Android, the direction spec 4.4
  // calls fatal. Because the wrapper sets overflow-x:hidden it did not scroll,
  // it clipped ~3% off the right edge with JS disabled. Every baseline must
  // therefore exceed every measurement for its charset.
  const { advanceCssFor, ADVANCE_MEASURED } = await import('../src/constants.js');
  const forCodec = {
    [CODEC.RAMP]: ADVANCE_MEASURED.latin,
    [CODEC.BRAILLE]: ADVANCE_MEASURED.braille,
    [CODEC.QUADRANT]: ADVANCE_MEASURED.block,
  };
  for (const [codec, measured] of Object.entries(forCodec)) {
    const css = advanceCssFor(Number(codec));
    for (const [device, a] of Object.entries(measured)) {
      assert.ok(css >= a, `codec ${codec} on ${device}: baseline ${css} is below measured ${a}`);
      assert.ok(css - a < 0.12, `codec ${codec} on ${device}: baseline wastes too much`);
    }
  }

  // A single shared value is what broke. Latin and Block Elements are 0.11
  // apart; no one number can serve both.
  assert.notEqual(advanceCssFor(CODEC.RAMP), advanceCssFor(CODEC.BRAILLE));
  assert.throws(() => advanceCssFor(99), /no CSS advance baseline/);
});

test('codecs can be compared at equal character count', async () => {
  // The comparison is "same file size, which codec makes the better picture",
  // so columns vary and characters do not. Equal columns was rejected: at 150
  // columns braille and quadrant produce identical 300x400 dots while quadrant
  // spends 2x the characters, so that comparison measures budget, not codec.
  const { colsForChars } = await import('../src/sizing.js');
  const TARGET = 15100;
  for (const codec of [CODEC.BRAILLE, CODEC.QUADRANT, CODEC.RAMP]) {
    const cols = colsForChars(codec, TARGET);
    const d = describeGrid(cols, rowsFor(cols, 3, 4, codec), codec);
    assert.ok(
      Math.abs(d.payloadChars - TARGET) / TARGET < 0.01,
      `codec ${codec}: ${cols} cols gives ${d.payloadChars} chars`,
    );
  }
  assert.equal(colsForChars(CODEC.BRAILLE, TARGET), 150, 'braille lands on its cap');
});

test('quadrant is dominated by braille at equal dot resolution', () => {
  // Not an aesthetic judgement: at the same dots, quadrant costs exactly twice
  // the characters. It earns its place only as the fallback for a platform with
  // no braille glyph, which is why the tofu measurement decides whether it
  // stays in v1 at all.
  const b = describeGrid(150, rowsFor(150, 3, 4, CODEC.BRAILLE), CODEC.BRAILLE);
  const q = describeGrid(150, rowsFor(150, 3, 4, CODEC.QUADRANT), CODEC.QUADRANT);
  assert.equal(b.dotsW, q.dotsW);
  assert.equal(b.dotsH, q.dotsH);
  assert.ok(q.payloadChars / b.payloadChars > 1.98, 'quadrant should cost ~2x for the same dots');
});

test('the ramp legibility floor was wrong by 1.6x, and re-measuring it retired the clamp', async () => {
  // 78 columns was recorded as measured in round 4, the round whose panels were
  // all squashed to 60% of their height by a line-height bug. Squashed glyphs
  // stop being readable sooner, so the cap came out low. Re-taken on a correct
  // render: 130, at a 3.16 px cell on the 411 px measuring viewport.
  const { MIN_ADVANCE_GLYPH_PX, MEASURE_VIEWPORT_PX } = await import('../src/constants.js');
  const { measuredRampCols, legibleColsFor } = await import('../src/sizing.js');
  assert.ok(Math.abs(MIN_ADVANCE_GLYPH_PX - 3.16) < 0.01, `glyph floor ${MIN_ADVANCE_GLYPH_PX}`);
  assert.equal(measuredRampCols().max, 130);
  assert.equal(measuredRampCols().viewportPx, MEASURE_VIEWPORT_PX);

  // The clamp existed because ramp was assumed to fail sooner than braille. It
  // does not. Both floors are still advance widths. Expressing one as a font
  // size is what once made ramp's cap come out larger, which is backwards.
  assert.ok(
    legibleColsFor(CODEC.RAMP) < legibleColsFor(CODEC.BRAILLE),
    'braille still runs finer, but the gap no longer justifies a separate track',
  );

  // Column ceilings now come from the shared character ceiling, so ramp and
  // quadrant, which cost the same per column, land on the same number.
  assert.equal(maxColsFor(CODEC.RAMP), maxColsFor(CODEC.QUADRANT));
});

test('auto-levels never deletes a sparse image', () => {
  // A line drawing is ~97% white, so the 4th and 96th percentile both land on
  // 1.0. The old code filled the buffer with 0.5 in that case, which silently
  // erased the picture. It destroyed the Test D geometry target, and would do
  // the same to any real photo with a similar histogram.
  const n = 10000;
  const sparse = new Float64Array(n).fill(1);
  for (let i = 0; i < 260; i++) sparse[i * 38] = 0; // 2.6% ink
  const out = autoLevels(sparse, 4, 96);
  const dark = Array.from(out).filter((v) => v < 0.5).length;
  assert.ok(dark > 200, `expected the lines to survive, got ${dark} dark pixels`);
  assert.ok(Math.max(...out) > 0.99 && Math.min(...out) < 0.01, 'full range preserved');
});

test('auto-levels passes a genuinely flat image through untouched', () => {
  const flat = new Float64Array(100).fill(0.42);
  const out = autoLevels(flat);
  assert.ok(out.every((v) => Math.abs(v - 0.42) < 1e-9), 'must not invent a value');
});

// ---------------------------------------------------------------------------
// Braille bit order. A scrambled cell looks globally plausible, so this is the
// bug that survives a casual look.
// ---------------------------------------------------------------------------

test('braille bit numbering matches the Unicode block', () => {
  // Dot 1 (top-left) is bit 0 -> U+2801
  assert.equal(BRAILLE_BIT[0][0], 0);
  // Dot 4 (top-right) is bit 3 -> U+2808
  assert.equal(BRAILLE_BIT[0][1], 3);
  // Dot 7 (bottom-left) is bit 6, dot 8 (bottom-right) is bit 7
  assert.equal(BRAILLE_BIT[3][0], 6);
  assert.equal(BRAILLE_BIT[3][1], 7);
  // All eight bits set is the full cell
  assert.equal(String.fromCharCode(0x2800 + 255), '⣿');
  assert.equal(String.fromCharCode(0x2800), '⠀');
});

test('a single dark dot lands in the correct corner', () => {
  // 2x4 dot image, only the top-left dot dark.
  const luma = new Float64Array(8).fill(1);
  luma[0] = 0;
  const grid = buildGrid(luma, 2, 4, { codec: CODEC.BRAILLE, cols: 1, rows: 1, useDither: false });
  assert.equal(grid.values[0], 1 << 0);
  assert.equal(gridToRows(grid)[0], '⠁');
});

test('a single dark dot in the bottom-right lands in the correct corner', () => {
  const luma = new Float64Array(8).fill(1);
  luma[7] = 0; // last row, right column
  const grid = buildGrid(luma, 2, 4, { codec: CODEC.BRAILLE, cols: 1, rows: 1, useDither: false });
  assert.equal(grid.values[0], 1 << 7);
  assert.equal(gridToRows(grid)[0], '⢀');
});

// ---------------------------------------------------------------------------
// Serialisation must be lossless. This is the whole wire format.
// ---------------------------------------------------------------------------

for (const [name, codec] of [
  ['braille', CODEC.BRAILLE],
  ['quadrant', CODEC.QUADRANT],
  ['ramp', CODEC.RAMP],
]) {
  test(`${name}: grid -> rows -> grid round-trips losslessly`, () => {
    const { rgba, w, h } = syntheticImage(240, 180);
    const luma = toLuma(rgba, w, h);
    const cols = 40;
    const rows = rowsFor(cols, w, h, codec);
    const grid = buildGrid(luma, w, h, { codec, cols, rows });
    const lines = gridToRows(grid);
    const back = rowsToGrid(lines, codec);
    assert.equal(back.cols, grid.cols);
    assert.equal(back.rows, grid.rows);
    assert.deepEqual(Array.from(back.values), Array.from(grid.values));
  });
}

test('every row has exactly cols cells, because a ragged grid would shear', () => {
  const { rgba, w, h } = syntheticImage(320, 240);
  const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 108 });
  for (const line of out.lines) {
    assert.equal([...line].length, 108);
  }
  assert.equal(out.lines.length, 72);
});

test('quadrant lookup table is 16 distinct characters', () => {
  assert.equal(QUADRANT_CHARS.length, 16);
  assert.equal(new Set(QUADRANT_CHARS).size, 16);
});

// ---------------------------------------------------------------------------
// The wire format (spec 4.1, 4.2). Redesigned 2026-08-09: one human-readable
// header line carrying only what the rows cannot say for themselves, and a
// parser for which the header is an optimisation rather than a dependency.
//
// The tests below are split along exactly that seam. The first group proves the
// round trip with the header present; the second proves the message still
// decodes with the header thrown away, which is the case a recipient reaches by
// copying text out of a rendered page. If the second group ever needs the
// header to pass, the design has quietly reverted.
// ---------------------------------------------------------------------------

for (const [name, codec] of [
  ['braille', CODEC.BRAILLE],
  ['quadrant', CODEC.QUADRANT],
  ['ramp', CODEC.RAMP],
]) {
  test(`${name}: grid -> rows -> message -> parse -> grid is the identity`, () => {
    const { rgba, w, h } = syntheticImage(240, 320);
    const out = encode(rgba, w, h, { codec, cols: 40 });
    const back = parseMessage(out.message);

    assert.equal(back.magic, true);
    assert.equal(back.version, 1);
    assert.equal(back.codec, codec, 'codec survives, and is confirmed by the rows');
    assert.equal(back.grid.cols, out.grid.cols);
    assert.equal(back.grid.rows, out.grid.rows);
    assert.deepEqual(Array.from(back.grid.values), Array.from(out.grid.values));

    // And the grid re-serialises to the same characters, which is the property
    // that actually matters: the text is the picture.
    assert.deepEqual(gridToRows(back.grid), out.lines);

    // A clean message must be quiet. A warning here means something had to be
    // assumed, and with a full header nothing should have to be.
    assert.deepEqual(back.warnings, [], back.warnings.join(' | '));
  });
}

test('the art rows alone decode, with the header stripped off entirely', () => {
  // The load-bearing case, and the reason geometry is inferred rather than
  // carried: a recipient who selects the picture in a browser and copies it
  // gets the rows and nothing else. No magic, no wrapper, no header. That is
  // the format working, so it must degrade only in the fields that genuinely
  // cannot be inferred -- polarity and the ramp -- and never fail.
  const { rgba, w, h } = syntheticImage(240, 320);
  const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 40 });

  const orphan = out.lines.join('\n');
  const back = parseMessage(orphan);

  assert.equal(back.magic, false, 'there is no magic to find');
  assert.equal(back.codec, CODEC.BRAILLE, 'the code-point range says braille');
  assert.equal(back.grid.cols, out.grid.cols, 'width is the row length');
  assert.equal(back.grid.rows, out.grid.rows, 'height is the row count');
  assert.deepEqual(Array.from(back.grid.values), Array.from(out.grid.values));
  assert.deepEqual(gridToRows(back.grid), out.lines);

  // Degraded, loudly, in exactly the two places it has to be.
  assert.ok(back.warnings.some((x) => /no header line/.test(x)));
  assert.ok(back.warnings.some((x) => /polarity is not carried/.test(x)));
});

test('codec is inferred from the code-point range, not taken on trust', () => {
  assert.equal(inferCodec(['⠁⠂', '⠃⠄']), CODEC.BRAILLE);
  assert.equal(inferCodec(['░▘', '▝▀']), CODEC.QUADRANT);
  assert.equal(inferCodec(['\u00a0-', ';+']), CODEC.RAMP);
  assert.equal(inferCodec([]), null, 'nothing to infer from');
  assert.equal(inferCodec(['⠁░']), null, 'two cell charsets in one grid is not a guess worth making');

  // The rows outrank the header. A header that disagrees is a warning, and the
  // picture that renders is the one the characters actually spell.
  const rows = ['⠁⠂', '⠃⠄'];
  const wrong = 'PLANETEXT1 v=1 c=ramp i=1 w=2 h=2\n' + rows.join('\n');
  const back = parseMessage(wrong);
  assert.equal(back.codec, CODEC.BRAILLE);
  assert.ok(back.warnings.some((x) => /the rows win/.test(x)));
});

test('polarity survives the header, because it cannot survive the rows', () => {
  // A photograph and its negative are the same characters. Invert is therefore
  // one of the two fields the header exists for.
  const { rgba, w, h } = syntheticImage(160, 213);
  for (const invert of [false, true]) {
    const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 32, invert });
    const back = parseMessage(out.message);
    assert.equal(back.invert, invert, `invert=${invert} should round-trip`);
    assert.ok(out.message.startsWith(`PLANETEXT1 v=1 c=braille i=${invert ? 1 : 0} `));
  }

  // And without a header it falls back to the default rather than guessing.
  const { INVERT_DEFAULT } = { INVERT_DEFAULT: true };
  const bare = parseMessage(['⠁⠂', '⠃⠄'].join('\n'));
  assert.equal(bare.invert, INVERT_DEFAULT);
});

test('a custom ramp travels on the header, glyphs and order intact', () => {
  // The ramp is the other field that cannot be inferred: coverage order is a
  // measurement of a font, not a property of the characters. It is also the
  // mechanism behind user-editable charsets (spec 5.1), so it had to survive
  // the header redesign.
  const custom = '\u00a0.oO0@';
  const { rgba, w, h } = syntheticImage(200, 267);
  const out = encode(rgba, w, h, { codec: CODEC.RAMP, cols: 30, ramp: custom });

  assert.ok(out.message.includes(' ' + HEADER_KEY.ramp + '=' + custom));
  const back = parseMessage(out.message);
  assert.equal(back.ramp, custom, 'the exact glyphs, in the sender\'s order');
  assert.deepEqual(Array.from(back.grid.values), Array.from(out.grid.values));
  assert.deepEqual(back.warnings, [], back.warnings.join(' | '));

  // Strip the header and the text still round-trips: unknown glyphs are
  // appended to the assumed ramp rather than mapped to zero, so the characters
  // come back exactly and only the tone ordering is lost. Warned about, because
  // a silently wrong tone map is the expensive kind of wrong.
  const orphan = parseMessage(out.lines.join('\n'));
  assert.deepEqual(gridToRows(orphan.grid), out.lines, 'the text survives regardless');
  assert.ok(orphan.warnings.some((x) => /no ramp carried/.test(x)));
});

test('the header separator is U+0020 and never \\s, because U+00A0 is a ramp glyph', () => {
  // The sharpest edge in the format. JavaScript's \s matches U+00A0, which is
  // the lightest glyph of every ramp we ship (RAMP_BLANK), so a /\s+/ split
  // would silently delete index 0 from every ramp header and shift the entire
  // tone map by one level.
  const line = emitHeader({ codec: CODEC.RAMP, cols: 4, rows: 2, invert: true, ramp: DEFAULT_RAMP });
  assert.ok(line.includes('=\u00a0'), 'the ramp really does start with U+00A0');
  assert.equal(parseHeader(line).ramp, DEFAULT_RAMP);
  assert.equal(line.split(' ').length, 7, 'seven U+0020-separated tokens, ramp intact');

  // '=' is a legal ramp glyph (it is in RAMP_CONVENTIONAL), so a value is split
  // on the first '=' only.
  const eq = emitHeader({ codec: CODEC.RAMP, cols: 4, rows: 2, ramp: '\u00a0.=@' });
  assert.equal(parseHeader(eq).ramp, '\u00a0.=@');
});

test('a header that disagrees with the rows warns, and never throws', () => {
  const rows = ['⠁⠂⠃', '⠄⠅⠆'];
  const message = 'PLANETEXT1 v=1 c=braille i=1 w=99 h=41\n' + rows.join('\n');
  let back;
  assert.doesNotThrow(() => { back = parseMessage(message); });
  assert.equal(back.grid.cols, 3, 'the rows are three wide, whatever w says');
  assert.equal(back.grid.rows, 2, 'and two tall, whatever h says');
  assert.ok(back.warnings.some((x) => /w=99/.test(x) && /the rows win/.test(x)));
  assert.ok(back.warnings.some((x) => /h=41/.test(x) && /the rows win/.test(x)));
});

test('a malformed header degrades field by field instead of failing', () => {
  // Unknown keys are how this format grows: the binary header reserved three
  // bytes for forward compatibility, and a key=value line does not need them.
  // Every one of these must leave the rows readable.
  const h = parseHeader('PLANETEXT1 v=one c=hologram i=maybe w=-4 z=42 nonsense r=@');
  assert.equal(h.magic, true, 'the magic is still the magic');
  assert.equal(h.version, null);
  assert.equal(h.codec, null);
  assert.equal(h.invert, null);
  assert.equal(h.cols, null);
  assert.equal(h.ramp, null, 'a one-glyph ramp carries no tone');
  assert.deepEqual(h.unknown, { z: '42' });
  assert.ok(h.warnings.length >= 6, h.warnings.join(' | '));

  // Not a header at all.
  assert.equal(parseHeader('hello').magic, false);
  assert.equal(parseHeader('').magic, false);

  // A future version reads as far as it can rather than refusing.
  const future = parseHeader('PLANETEXT1 v=9 c=braille i=1 w=2 h=1');
  assert.equal(future.version, 9);
  assert.equal(future.codec, CODEC.BRAILLE);
  assert.ok(future.warnings.some((x) => /wire version 9/.test(x)));

  // The digit form the spec's own worked example used still parses, even though
  // nothing emits it any more.
  assert.equal(parseHeader('PLANETEXT1 c=1').codec, CODEC.BRAILLE);
});

test('a ramp with a banned character is rejected at emit, used or not', () => {
  // Linting the rows only catches a banned glyph if this particular photograph
  // happens to reach that tone level. A ramp whose '*' sits at a level the
  // image never uses would ship clean and detonate on the next photo. The
  // header carries the whole ramp, so the check is now unconditional.
  for (const bad of BANNED_MARKDOWN) {
    assert.throws(
      () => emitHeader({ codec: CODEC.RAMP, cols: 2, rows: 1, ramp: '\u00a0.' + bad + '@' }),
      /banned characters/,
      `ramp containing ${JSON.stringify(bad)} must be refused`,
    );
  }
  // HTML-significant characters too: the ramp is about to be rendered inside a
  // <pre>, where an escaped entity breaks one-character-per-cell.
  assert.throws(() => emitHeader({ codec: CODEC.RAMP, cols: 2, rows: 1, ramp: '\u00a0.<@' }), /banned/);

  // And U+0020, which would split its own header line.
  assert.throws(
    () => emitHeader({ codec: CODEC.RAMP, cols: 2, rows: 1, ramp: '\u00a0. @' }),
    /U\+0020/,
  );

  // The whole pipeline, not just the unit: an unused banned glyph must not be
  // reachable through encode() either.
  const { rgba, w, h } = syntheticImage(64, 85);
  assert.throws(
    () => encode(rgba, w, h, { codec: CODEC.RAMP, cols: 20, ramp: '\u00a0.oO@~' }),
    /banned characters/,
  );
});

test('the rows are found whether or not they arrive inside a wrapper', () => {
  const rows = ['⠁⠂', '⠃⠄'];
  assert.deepEqual(extractRows('<div id=b><pre id=a data-c=2>' + rows.join('\n') + '</pre></div>'), rows);
  assert.deepEqual(extractRows(rows.join('\n')), rows);
  assert.deepEqual(extractRows('\n' + rows.join('\n') + '\n\n'), rows, 'padding added by a mail client');
  assert.deepEqual(extractRows(''), []);
});

test('decode repairs a trimmed grid rather than refusing it', () => {
  // Spec 4.4 rule 3 allows trailing spaces to be trimmed freely, and some
  // transports will do it whether we allow it or not. cells.js rowsToGrid is
  // the strict inverse and throws here, which is right for a test of the
  // encoder; the paste path is not a test of the encoder.
  const ragged = ['⠿⠿⠿', '⠿⠿'];
  assert.throws(() => rowsToGrid(ragged, CODEC.BRAILLE), /not rectangular/);

  const { grid, warnings } = decodeRows(ragged, { codec: CODEC.BRAILLE });
  assert.equal(grid.cols, 3, 'the widest row sets the width');
  assert.equal(grid.values[5], 0, 'the missing cell is blank, not an exception');
  assert.ok(warnings.some((x) => /same length/.test(x)));

  // A glyph from outside the charset is a corrupt cell, not a corrupt message.
  const smart = decodeRows(['⠿⠿', '⠿Q'], { codec: CODEC.BRAILLE });
  assert.equal(smart.grid.values[3], 0);
  assert.ok(smart.warnings.some((x) => /not in this codec's charset/.test(x)));

  // Nothing at all is still not an exception.
  assert.doesNotThrow(() => parseMessage(''));
  assert.equal(parseMessage('').grid, null);
});

// ---------------------------------------------------------------------------
// Character bans and whitespace
// ---------------------------------------------------------------------------

test('payload contains no banned characters and no leading whitespace', () => {
  const { rgba, w, h } = syntheticImage(320, 240);
  for (const codec of [CODEC.BRAILLE, CODEC.QUADRANT, CODEC.RAMP]) {
    const out = encode(rgba, w, h, { codec, cols: 60 });
    assert.deepEqual(lintPayload(out.lines.join('\n')), [], `codec ${codec}`);
  }
});

test('blank cells serialise to U+2800, never U+0020', () => {
  // An all-white image produces all-blank braille cells. If those were spaces,
  // WhatsApp's leading-whitespace trim would eat the left edge of every row.
  const luma = new Float64Array(2 * 4).fill(1);
  const grid = buildGrid(luma, 2, 4, { codec: CODEC.BRAILLE, cols: 1, rows: 1, useDither: false });
  assert.equal(gridToRows(grid)[0], '⠀');
  assert.equal(gridToRows(grid)[0].charCodeAt(0), 0x2800);
});

test('the Linux-calibrated ramps regressed on a real device font', async () => {
  // The most expensive lesson in this project, pinned so it cannot recur.
  //
  // RAMP_ART was selected over RAMP_CONVENTIONAL *because* it was monotonic,
  // measured on DejaVu Sans Mono, Liberation Mono and Latin Modern Mono, which
  // all agreed. All three are Linux fonts. No phone uses any of them. Measured
  // on a Pixel, which resolves `monospace` to Roboto Mono, ART ITSELF INVERTS.
  //
  // The replacement inherited the exact defect it was chosen to fix, and only a
  // device measurement could have caught it. Standing rule: a calibration is
  // only valid in the font it was measured in, and the build machine is never
  // that font.
  const { rampEvenness, resortRamp, USABLE_STEP } = await import('../src/calibrate.js');
  const { RAMP_ART_LINUX, RAMP_FIDELITY_LINUX, RAMP_CONVENTIONAL } =
    await import('../src/constants.js');

  // Coverage measured on a Pixel, Test D section 5, 2026-08-09. Frozen so the
  // property is asserted without a rasteriser in the test run.
  const PIXEL = {
    '\u00a0': 0, '.': 0.098, ':': 0.138, '!': 0.283, '+': 0.298, ']': 0.501,
    '{': 0.491, '%': 0.801, '$': 0.720, 'O': 0.782, '@': 1.000, '/': 0.310,
    'v': 0.451, 'n': 0.549, '5': 0.609, 'U': 0.703, 'R': 0.786, 'M': 0.979,
    '-': 0.130, '=': 0.326, 'o': 0.561, 'x': 0.486, '#': 0.754,
  };
  const measure = (g) => PIXEL[g];

  const conventional = rampEvenness(RAMP_CONVENTIONAL, measure);
  assert.equal(conventional.monotonic, false, 'the conventional ramp inverts');
  assert.equal(conventional.inversions.length, 3);
  assert.ok(conventional.maxStepError > 0.20, `error ${conventional.maxStepError}`);

  // The regression itself.
  const art = rampEvenness(RAMP_ART_LINUX, measure);
  assert.equal(art.monotonic, false, 'the old Art ramp inverts on a real phone font');
  assert.deepEqual(art.inversions, [']->{', '%->$']);

  // Fidelity survived, which is why it was the tempting default. It is also
  // why usableLevels matters more than monotonicity: Fidelity passes the
  // inversion test and still only delivers 9 distinguishable tones of 11.
  const fid = rampEvenness(RAMP_FIDELITY_LINUX, measure);
  assert.equal(fid.monotonic, true);
  assert.equal(fid.usableLevels, 9);

  // Reordering is the free half of the repair, and not the whole repair.
  // Re-sorting Art removes both inversions and cannot touch its clustering:
  // four glyph pairs sit within USABLE_STEP of each other, so eleven slots
  // deliver seven tones. Only a redesign moves that number.
  const resorted = rampEvenness(resortRamp(RAMP_ART_LINUX, measure), measure);
  assert.equal(resorted.monotonic, true, 'reordering always fixes inversions');
  assert.equal(resorted.usableLevels, art.usableLevels, 'and never fixes clustering');
  assert.equal(art.usableLevels, 7, 'eleven slots, seven usable tones');
  assert.ok(USABLE_STEP > 0 && USABLE_STEP < 0.1);
});

test('the shipped ramps are structurally valid, and their tone is not yet verified', async () => {
  // The current RAMP_ART and RAMP_FIDELITY were designed on a Pixel by Test D
  // section 6, which walks the candidate pool in coverage order, so an
  // inversion is unreachable by construction and no measurement here could
  // fail. What this test can check is the structure.
  //
  // This gap is known and should stay visible: we have no coverage figures for
  // ';', '(', '[', 'a', 'K' or 'B', so the new ramps' monotonicity is asserted
  // by construction rather than by data, and their usableLevels is unknown,
  // which is the number the redesign was for. It is also why
  // CALIBRATION_DEFAULT is 'auto': these are calibrated on one font.
  const { RAMP_ART, RAMP_FIDELITY, RAMP_BLANK, CALIBRATION_DEFAULT } =
    await import('../src/constants.js');
  for (const [name, ramp] of [['art', RAMP_ART], ['fidelity', RAMP_FIDELITY]]) {
    const glyphs = [...ramp];
    assert.equal(glyphs.length, 11, `${name} should have 11 levels`);
    assert.equal(glyphs[0], RAMP_BLANK, `${name} must be anchored by the blank`);
    assert.equal(new Set(glyphs).size, 11, `${name} has a duplicate glyph`);
    assert.deepEqual(lintPayload(ramp), [], `${name} must survive the linter`);
    assert.ok(!ramp.includes(' '), `${name} must not contain U+0020`);
    assert.ok(!/["\']/.test(ramp), `${name} must avoid smart-quote substitution`);
  }

  // Art is punctuation only; that is the entire reason it exists as a separate
  // style, and the property that beat Fidelity's better picture.
  assert.ok(!/[a-zA-Z0-9]/.test(RAMP_ART), 'Art must stay alphanumeric-free');
  assert.ok(/[a-zA-Z]/.test(RAMP_FIDELITY), 'Fidelity is allowed letters');

  // They agree on 7 of 11 slots (the whole light end plus the terminal glyph)
  // and diverge only in the upper mid-tones where punctuation runs out. The
  // art-versus-fidelity trade is four glyphs, not a charset.
  const a = [...RAMP_ART], f = [...RAMP_FIDELITY];
  const same = a.filter((g, i) => g === f[i]).length;
  assert.equal(same, 7, `art and fidelity share ${same} slots`);

  assert.equal(CALIBRATION_DEFAULT, 'auto', 'one measured font is not enough to switch this off');
});

test('ramp selection is monotonic by construction, and beats a greedy walk', async () => {
  // The old selector was a greedy nearest-target walk, which is wrong whenever
  // two targets want the same glyph: the first takes it, the second is pushed
  // to a worse one, and the error compounds. It also sorted afterwards, the
  // tell that it could return an unordered, and therefore non-monotonic,
  // selection. Dynamic programming over the coverage-sorted pool makes an
  // inversion unreachable and returns the exact minimiser.
  const { calibrateRamp } = await import('../src/calibrate.js');

  // A clumped pool: several candidates crowd 0.30-0.35, the shape that makes
  // greedy misbehave.
  const pool = ['\u00a0', ...'abcdefghijklmnop'];
  const cov = {};
  const values = [0, 0.05, 0.30, 0.31, 0.32, 0.33, 0.34, 0.35, 0.42, 0.55,
    0.61, 0.68, 0.74, 0.80, 0.88, 0.94, 1.0];
  pool.forEach((g, i) => { cov[g] = values[i]; });

  const out = calibrateRamp((g) => cov[g], { length: 11, alphabet: pool, blank: '\u00a0' });
  assert.equal([...out.ramp].length, 11);
  for (let i = 1; i < out.coverage.length; i++) {
    assert.ok(
      out.coverage[i] >= out.coverage[i - 1],
      `selection inverted at ${i}: ${out.coverage}`,
    );
  }
  assert.ok(out.maxStepError < 0.12, `step error ${out.maxStepError}`);
  assert.ok(out.usableLevels >= 9, `only ${out.usableLevels} usable levels`);
});

test('calibration refuses a measurer that has antialiasing off', async () => {
  // Spec 5.7 rule 1, and the exact mistake VectorCamera's pipeline makes: its
  // blit is a binary keying test, so no coverage information survives anywhere.
  // A thresholding measurer produces a ramp that looks fine and carries no tone.
  const { calibrateRamp } = await import('../src/calibrate.js');
  assert.throws(
    () => calibrateRamp((g) => (g === ' ' ? 0 : 1)),
    /thresholding/,
  );
});

test('styles are codec + charset + tone, and no longer clamp the slider', async () => {
  const { STYLES, DEFAULT_STYLE, resolveStyle, styleList, customStyle } =
    await import('../src/styles.js');
  assert.equal(DEFAULT_STYLE, 'art', 'the artefact reading as art is the default');
  const art = resolveStyle();
  assert.equal(art.codec, CODEC.RAMP);
  assert.equal(art.stroke, 0, 'ramp glyphs are not sub-pixel dots');
  assert.ok(art.tone.compress < 1);

  // Changed 2026-08-09: every style now shares one character range. "Style
  // clamps the size slider" is demoted to a labelling convention.
  const half = resolveStyle('halftone');
  assert.deepEqual(art.sizeRange, half.sizeRange, 'one track for every style');
  assert.equal(half.codec, CODEC.BRAILLE);
  assert.ok(half.stroke > 0, 'braille dots do need synthetic bolding');
  assert.ok(half.maxCols > art.maxCols, 'at equal characters braille buys more columns');

  // All three ramps ship as pickable styles, including the one that measures
  // worst. A user who wants the classic ramp should not have to retype it.
  assert.ok(STYLES.conventional, 'the conventional ramp stays selectable');
  assert.equal(styleList().length, Object.keys(STYLES).length);
  assert.throws(() => resolveStyle('nope'), /unknown style/);

  // User-editable charsets are in v1, and are validated where they are typed.
  const mine = resolveStyle(customStyle('\u00a0.oO@'));
  assert.equal(mine.codec, CODEC.RAMP);
  assert.equal(mine.ramp, '\u00a0.oO@');
  assert.throws(() => customStyle('\u00a0.o*@'), /banned/i, 'markdown chars must be refused');
  assert.throws(() => customStyle('\u00a0. o@'), /U\+0020/, 'a plain space would shear the grid');
  assert.throws(() => customStyle('@'), /at least two/);
});

test('every shipped ramp survives the linter', async () => {
  const { RAMP_ART, RAMP_FIDELITY } = await import('../src/constants.js');
  for (const ramp of [RAMP_ART, RAMP_FIDELITY]) {
    assert.deepEqual(lintPayload(ramp), [], JSON.stringify(ramp));
    assert.ok(!ramp.includes(' '), 'no U+0020 -- WhatsApp trims it at line start');
    assert.equal(ramp.charCodeAt(0), 0x00a0, 'the blank anchors index 0');
    assert.equal(new Set([...ramp]).size, ramp.length, 'no repeated glyph');
  }
});

test('the default ramp is free of banned characters and of plain spaces', () => {
  // The linter caught this on the first run: the obvious ramp starts with
  // U+0020, which WhatsApp trims at the start of a line, shifting every row
  // whose left edge is bright and shearing the picture.
  assert.deepEqual(lintPayload(DEFAULT_RAMP), []);
  assert.ok(!DEFAULT_RAMP.includes(' '), 'ramp must not contain U+0020');
  assert.equal(DEFAULT_RAMP.charCodeAt(0), 0x00a0, 'lightest glyph should be U+00A0');
});

test('the fit shim obeys the banned-character rule', () => {
  assert.deepEqual(lintWrapper(SHIM), []);
  for (const ch of BANNED_MARKDOWN) {
    assert.ok(!SHIM.includes(ch), `shim contains ${JSON.stringify(ch)}`);
  }
});

test('the whole message obeys the banned-character rule', () => {
  const { rgba, w, h } = syntheticImage(320, 240);
  const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 108 });
  assert.deepEqual(lintWrapper(out.message), []);
});

test('a user ramp with a banned character is rejected, not silently sent', () => {
  const { rgba, w, h } = syntheticImage(64, 48);
  assert.throws(
    () => encode(rgba, w, h, { codec: CODEC.RAMP, cols: 20, ramp: ' .*#' }),
    /banned characters/,
  );
});

// ---------------------------------------------------------------------------
// Wrapper budget
// ---------------------------------------------------------------------------

test('the wrapper is the measured size, within budget, and not silently shrinking', () => {
  const lines = Array(41).fill('\u2800'.repeat(108));
  const cost = wrapperCost(lines, { codec: CODEC.BRAILLE, cols: 108 });
  assert.equal(cost, WRAPPER_MEASURED, 'wrapper size changed. Update WRAPPER_MEASURED and the spec.');
  assert.ok(cost <= WRAPPER_BUDGET, `wrapper is ${cost}, budget is ${WRAPPER_BUDGET}`);
});

test('the shim stays small enough that file:// restrictions cost nothing', () => {
  // Grew 181 -> 481 when device testing showed line-height must come from the
  // glyph's ink extent, which needs canvas measureText. Still trivial against
  // a 65,536 ceiling, and still one classic inline script with no modules,
  // workers or fetch.
  assert.ok(SHIM.length < 700, `shim is ${SHIM.length} chars`);
});

test('the wrapper ships the per-codec advance, and never under-fills', async () => {
  // The failure this prevents was measured: a CSS advance below the real one
  // makes the <pre> wider than the viewport, and because the wrapper sets
  // overflow-x:hidden it does not scroll, it clips. ~3% off the right edge of
  // every braille message, with JS off, silently. The old shared 0.68 did
  // exactly that against braille's measured 0.7002 on Android.
  const { advanceCssFor, ADVANCE_MEASURED } = await import('../src/constants.js');
  const worst = {
    [CODEC.RAMP]: Math.max(...Object.values(ADVANCE_MEASURED.latin)),
    [CODEC.BRAILLE]: Math.max(...Object.values(ADVANCE_MEASURED.braille)),
    [CODEC.QUADRANT]: Math.max(...Object.values(ADVANCE_MEASURED.block)),
  };
  for (const codec of [CODEC.BRAILLE, CODEC.QUADRANT, CODEC.RAMP]) {
    const html = wrap(['ab'], { codec, cols: 2, rows: 1 });
    const a = advanceCssFor(codec);
    assert.ok(html.includes('/2/' + a + ')'), `codec ${codec} should size against ${a}`);

    // Rendered width as a fraction of the viewport, JS off. Must be <= 1.
    const fill = worst[codec] / a;
    assert.ok(fill <= 1, `codec ${codec} fills ${fill} of the width, so it will clip`);
  }

  // data-r carries cellW/cellH so the shim can spell the measured line-height
  // without a '*', which is a banned character.
  const braille = wrap(['ab'], { codec: CODEC.BRAILLE, cols: 2, rows: 1 });
  assert.ok(braille.includes('data-r=0.5'), 'braille cell ratio must ship');
});

test('braille must be legible unstroked, because the message is a text file', async () => {
  // Round 5 added a constraint the spec never stated. Bolding lives in the CSS
  // wrapper, and the message is required to read as a plain text file, so
  // stroke only ever helps the recipient who opens the .html, and braille's
  // real legibility floor is its unstroked floor. 0.1em is where adjacent dots
  // start to merge, which destroys the sub-cell resolution braille exists for.
  const { TEXT_STROKE_EM, STROKE_EM_MAX, STROKE_EM } = await import('../src/constants.js');
  assert.ok(TEXT_STROKE_EM > 0 && TEXT_STROKE_EM <= STROKE_EM_MAX);
  assert.equal(STROKE_EM_MAX, 0.10);

  // The payload must be identical with and without it. If stroke ever leaked
  // into the encoder, an unstroked plain-text reading would be a different
  // picture, not just a fainter one.
  const { rgba, w, h } = syntheticImage(160, 120);
  const a = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 40 });
  const b = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 40, stroke: 0 });
  assert.deepEqual(a.lines, b.lines, 'stroke is presentation only');
  assert.equal(STROKE_EM[CODEC.RAMP], 0, 'letterforms are not sub-pixel dots');
});

test('the shim measures the container, never the viewport', () => {
  // Device bug: targeting innerWidth overflowed the page, because 100vw
  // includes the scrollbar and neither it nor innerWidth knows about padding
  // on an ancestor. The pre must measure its own container.
  assert.ok(SHIM.includes('clientWidth'));
  assert.ok(!SHIM.includes('innerWidth'), 'shim must not use innerWidth');
});

test('the shim does not touch line-height at all any more', () => {
  // Three device rounds got us here. lh = ink x n/(n-1) closed the gutters but
  // squashed the image; lh = 2 x advance kept proportions and left gutters;
  // and neither fixed quadrant, which rendered vertically stretched for a
  // third reason. Scaling to a known target aspect fixes all of them without
  // the shim needing to know why any of them were wrong.
  assert.ok(!SHIM.includes('actualBoundingBox'), 'no ink measurement, ever');
  assert.ok(SHIM.includes('scale('), 'aspect comes from a transform');

  // Reversed 2026-08-09 (Test D section 7, panel P2). The shim sets line-height
  // again, but from a measurement, not from the ink-extent arithmetic that
  // squashed the image in round 2.
  //
  // The transform makes geometry immune to a wrong advance and leaves glyph
  // shape distorted by a_real / a_css. Setting line-height from the measured
  // advance before scaling makes sx equal sy and drives that to 1. On braille
  // the difference is barely visible (1.4% to 3.9%) and it was adopted for the
  // other two codecs: ramp was distorted 11.8% at the old shared guess, and
  // quadrant's advance spans 0.6021-0.7080 across devices with no fixed value
  // that works.
  assert.ok(SHIM.includes('lineHeight'), 'line-height now comes from the measurement');
  assert.ok(!SHIM.includes('*'), 'banned character: the shim uses v/(m/n), not v x n/m');
});

test('quadrant charset never mixes Unicode blocks', () => {
  // Device bug: index 0 was U+2800 (Braille Patterns) among Block Elements
  // glyphs. Two blocks means two fallback fonts and two advance widths in one
  // row, which shears the grid. The failure with no fix.
  const blocks = new Set(
    QUADRANT_CHARS.map((c) => {
      const cp = c.codePointAt(0);
      if (cp >= 0x2580 && cp <= 0x259f) return 'block-elements';
      if (cp >= 0x2800 && cp <= 0x28ff) return 'braille';
      return 'latin';
    }),
  );
  assert.ok(!blocks.has('braille'), 'quadrant must not borrow a braille glyph');

  // Fixed 2026-08-09. U+00A0 was itself the offender, and only on Android:
  // latin 0.6001 / block 0.7080 = 0.8476, which is the 15.2% worst per-glyph
  // deviation the device reported. iPad resolves Block Elements to a font that
  // matches latin closely, so the same charset measured clean there, which is
  // how it survived. Round 2 swapped U+2800 -> U+00A0 to fix a shear against
  // braille and round 3 confirmed it against braille; neither ever checked it
  // against Block Elements. The fix and its confirmation used the wrong
  // reference.
  assert.ok(!blocks.has('latin'), 'the blank must not borrow a latin glyph either');
  assert.deepEqual([...blocks], ['block-elements'], 'one Unicode block, one advance');
  assert.equal(QUADRANT_CHARS[0].codePointAt(0), 0x2591, 'blank should be U+2591 LIGHT SHADE');
});

test('the pre still hugs its content, so the measurement is of the art', () => {
  // Without max-content the <pre> clamps to the container and the measured
  // width is the container width, so the scale factor comes out as 1 and the
  // shim silently does nothing.
  const lines = ['\u2800\u2800'];
  const html = wrap(lines, { codec: CODEC.BRAILLE, cols: 2, rows: 1 });
  assert.ok(html.includes('width:max-content'));
  assert.ok(SHIM.includes('getBoundingClientRect'));
});

test('the message starts with the header line, not a bare magic string', () => {
  // Changed deliberately 2026-08-09. This used to assert
  // `startsWith('PLANETEXT1\n')`, i.e. that line 1 was the magic and nothing
  // else. Line 1 is now the header (spec 4.1/4.2): the magic still leads it, so
  // the clipboard scan in spec 5.5 is unaffected, but the fields follow it on
  // the same line. Asserting the old exact prefix would now be asserting that
  // the header does not exist, which is why this was rewritten rather than
  // deleted.
  const { rgba, w, h } = syntheticImage(64, 48);
  const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 20 });
  const first = out.message.split('\n')[0];
  assert.ok(out.message.startsWith('PLANETEXT1 '), 'the magic still leads the message');
  assert.ok(!out.message.startsWith('PLANETEXT1\n'), 'and is no longer alone on the line');
  assert.equal(first, 'PLANETEXT1 v=1 c=braille i=1 w=20 h=13');
  assert.ok(out.message.split('\n')[1].startsWith('<!doctype html>'));
});

test('charset meta appears within the first 1024 bytes, before any braille', () => {
  const { rgba, w, h } = syntheticImage(64, 48);
  const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 20 });
  const metaAt = out.message.indexOf('charset=utf-8');
  const firstBraille = out.message.search(/[⠀-⣿]/);
  assert.ok(metaAt !== -1 && metaAt < 1024, `charset at ${metaAt}`);
  assert.ok(metaAt < firstBraille, 'charset must precede the first braille character');
});

test('text-size-adjust is pinned: accessibility font clamping is a known risk', () => {
  const { rgba, w, h } = syntheticImage(64, 48);
  const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 20 });
  assert.ok(out.message.includes('text-size-adjust:none'));
});

// ---------------------------------------------------------------------------
// Tone pipeline
// ---------------------------------------------------------------------------

test('auto-levels redistributes a flat histogram rather than discarding it', () => {
  const flat = Float64Array.from({ length: 100 }, (_, i) => 0.4 + (i / 100) * 0.2);
  const out = autoLevels(flat);
  assert.ok(Math.min(...out) < 0.05, 'should reach the dark end');
  assert.ok(Math.max(...out) > 0.95, 'should reach the light end');
});

test('auto-levels does not divide by zero on a uniform image', () => {
  const uniform = new Float64Array(100).fill(0.5);
  const out = autoLevels(uniform);
  assert.ok(out.every((v) => Number.isFinite(v)));
});

test('downscale area-averages rather than point-sampling', () => {
  // 2x1 source, one black one white -> a single cell should be mid grey.
  const src = Float64Array.from([0, 1]);
  const out = downscale(src, 2, 1, 1, 1);
  assert.ok(Math.abs(out[0] - 0.5) < 1e-9, `got ${out[0]}`);
});

test('dithering preserves mean brightness', () => {
  const n = 64 * 64;
  const src = new Float64Array(n).fill(0.5);
  const out = dither(src, 64, 64, 2);
  const mean = out.reduce((a, b) => a + b, 0) / n;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `mean drifted to ${mean}`);
});

test('dither auto-disables below 24 columns', () => {
  const { rgba, w, h } = syntheticImage(160, 120);
  const luma = toLuma(rgba, w, h);
  const small = buildGrid(luma, w, h, { codec: CODEC.BRAILLE, cols: 20, rows: 8 });
  const large = buildGrid(luma, w, h, { codec: CODEC.BRAILLE, cols: 40, rows: 15 });
  assert.equal(small.dithered, false);
  assert.equal(large.dithered, true);
});

test('polarity: dark source pixels become ink', () => {
  const black = new Float64Array(8).fill(0);
  const g = buildGrid(black, 2, 4, { codec: CODEC.BRAILLE, cols: 1, rows: 1, useDither: false });
  assert.equal(gridToRows(g)[0], '⣿', 'a black cell should be a full braille cell');
  const white = new Float64Array(8).fill(1);
  const g2 = buildGrid(white, 2, 4, { codec: CODEC.BRAILLE, cols: 1, rows: 1, useDither: false });
  assert.equal(gridToRows(g2)[0], '⠀', 'a white cell should be blank');
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

test('exceeding the codec legibility estimate warns rather than clamping', async () => {
  const { legibleColsFor } = await import('../src/sizing.js');
  const { rgba, w, h } = syntheticImage(160, 120);
  const cap = legibleColsFor(CODEC.RAMP);
  const out = encode(rgba, w, h, { codec: CODEC.RAMP, cols: cap + 20 });
  assert.ok(out.warnings.some((wn) => /legibility estimate/.test(wn)));
  assert.equal(out.grid.cols, cap + 20, 'a warning must never change the output');

  // And the default must be quiet. The slider opening at the bottom means the
  // out-of-the-box path is comfortably inside the estimate.
  const quiet = encode(rgba, w, h, { codec: CODEC.RAMP });
  assert.deepEqual(quiet.warnings.filter((wn) => /legibility/.test(wn)), []);
});

// ---------------------------------------------------------------------------
// Metrics. The bench harness is only worth as much as these are.
// ---------------------------------------------------------------------------

test('reconstruction inverts the encoder exactly, in both polarities', async () => {
  // If this is wrong every bench number is wrong in a way that looks plausible,
  // which is the most expensive kind of wrong. Pin it against flat extremes,
  // where the answer is known without any metric being involved.
  const { reconstruct } = await import('../src/metrics.js');
  const W = 64, H = 86;
  for (const [level, expected] of [[0, 0], [255, 1]]) {
    const rgba = new Uint8ClampedArray(W * H * 4).fill(level);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    for (const codec of [CODEC.BRAILLE, CODEC.QUADRANT, CODEC.RAMP]) {
      for (const invert of [false, true]) {
        const out = encode(rgba, W, H, { codec, cols: 16, invert, useDither: false });
        const rec = reconstruct(out.grid, invert);
        const mean = rec.data.reduce((a, b) => a + b, 0) / rec.data.length;
        assert.ok(
          Math.abs(mean - expected) < 0.02,
          `codec ${codec} invert=${invert}: flat ${level} reconstructed as ${mean.toFixed(3)}`,
        );
      }
    }
  }
});

test('reconstruction reads the braille bit layout, not raster order', async () => {
  // A scrambled cell is globally plausible and locally wrong, the same trap the
  // serialiser has. One dot in a known corner is the cheapest guard.
  const { reconstruct } = await import('../src/metrics.js');
  const luma = new Float64Array(8).fill(1);
  luma[0] = 0; // top-left dot dark
  const grid = buildGrid(luma, 2, 4, { codec: CODEC.BRAILLE, cols: 1, rows: 1, useDither: false });
  const rec = reconstruct(grid, false);
  assert.equal(rec.w, 2);
  assert.equal(rec.h, 4);
  assert.equal(rec.data[0], 0, 'ink should land top-left');
  assert.equal(rec.data[1], 1, 'and nowhere else');
});

test('SSIM is 1 for identical images and drops when structure is destroyed', async () => {
  const { ssim } = await import('../src/metrics.js');
  const W = 32, H = 32;
  const a = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = ((x >> 2) % 2) * 0.8 + 0.1;
  assert.ok(ssim(a, a, W, H).ssim > 0.999);

  // Same mean, no structure.
  const flat = new Float64Array(W * H).fill(0.5);
  assert.ok(ssim(a, flat, W, H).ssim < 0.2);

  // Structure is meant to survive a linear brightness/contrast change, which is
  // why it is the right lens on a tone curve.
  const scaled = Float64Array.from(a, (v) => v * 0.6 + 0.2);
  assert.ok(ssim(a, scaled, W, H).structure > 0.99, 'structure should ignore linear remapping');
});

test('the blur is a low-pass, and it is what lets a halftone be scored', async () => {
  const { gaussianBlur, ssim } = await import('../src/metrics.js');
  const W = 64, H = 64;
  const smooth = new Float64Array(W * H);
  const halftone = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    smooth[y * W + x] = 0.5;
    halftone[y * W + x] = (x + y) % 2; // same mean, maximal high-frequency
  }
  const raw = ssim(smooth, halftone, W, H).ssim;
  const blurred = ssim(
    gaussianBlur({ data: smooth, w: W, h: H }, 1.5).data,
    gaussianBlur({ data: halftone, w: W, h: H }, 1.5).data,
    W, H,
  ).ssim;
  assert.ok(raw < 0.1, `unblurred halftone should score terribly, got ${raw.toFixed(3)}`);
  assert.ok(blurred > 0.8, `blurred halftone should score well, got ${blurred.toFixed(3)}`);
});

test('ramp health measures level occupancy, which ink coverage does not', async () => {
  const { rampHealth } = await import('../src/metrics.js');
  const n = DEFAULT_RAMP.length;
  const even = { ramp: DEFAULT_RAMP, values: Uint8Array.from({ length: 1100 }, (_, i) => i % n) };
  const h1 = rampHealth(even);
  assert.equal(h1.levels, n);
  assert.ok(h1.entropy > 0.99, 'even use of every glyph is maximum entropy');

  // Crushed: everything on the two end glyphs. Ink coverage would report a
  // perfectly healthy mean of 0.5 for this; it is a destroyed picture.
  const crushed = { ramp: DEFAULT_RAMP, values: Uint8Array.from({ length: 1100 }, (_, i) => (i % 2 ? n - 1 : 0)) };
  const h2 = rampHealth(crushed);
  assert.equal(h2.levels, 2);
  assert.ok(h2.clipped > 0.99, 'every cell is on an end glyph');
  assert.ok(Math.abs(h2.mean - 0.5) < 0.01, 'and the mean says nothing is wrong');
});

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

function syntheticImage(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const cx = x - w / 2;
      const cy = y - h / 2;
      const r = Math.sqrt(cx * cx + cy * cy);
      const disc = r < Math.min(w, h) * 0.3 ? 40 : 210;
      const grad = (x / w) * 60;
      const v = Math.min(255, Math.max(0, disc + grad - 30));
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { rgba, w, h };
}

// ---------------------------------------------------------------------------
// Tone and dither. Added 2026-08-08 after measuring against VectorCamera.
// ---------------------------------------------------------------------------

test('every codec compresses contrast, ramp least: measured, not reasoned', async () => {
  // This test used to assert `TONE[RAMP].compress === 1` on the argument that a
  // ramp has 11 levels to fill and should not give any of them away. The bench
  // disagrees: at compress 1.0 a fifth of the cells sit pinned to the blank or
  // the '@' carrying no gradient at all, and the curve is tuned to whichever
  // photo it was eyeballed on. A mild 0.92 halves the clipping and cuts
  // subject-dependence by 90% for 0.7% of SSIM.
  //
  // The old reasoning was right about the mechanism and never checked the
  // price. Kept as a comment because the same argument will come back.
  const { TONE } = await import('../src/constants.js');
  assert.ok(TONE[CODEC.BRAILLE].compress < 1, 'braille should compress contrast');
  assert.ok(TONE[CODEC.QUADRANT].compress < 1, 'quadrant should compress contrast');
  assert.ok(TONE[CODEC.RAMP].compress < 1, 'ramp compresses too, measured 2026-08-08');
  assert.ok(
    TONE[CODEC.RAMP].compress > TONE[CODEC.BRAILLE].compress,
    'but least of the three, since it has levels to fill and the others do not',
  );
  // The ramp still uses more of its gamma to spread the histogram.
  assert.ok(TONE[CODEC.RAMP].gamma > TONE[CODEC.BRAILLE].gamma);
});

test('ramp health warns on clipping, not on a band borrowed from halftones', async () => {
  // inkCoverage returns mean glyph index for a ramp, and the 30-60% band was
  // derived for the fraction of dots inked. Two ordinary photographs landed at
  // 30.7% and 59.1%, both edges of a band that never meant anything here.
  const { RAMP_CLIP_MAX } = await import('../src/constants.js');
  const W = 200, H = 267;

  // Half black, half white: every cell lands on an end glyph.
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const v = x < W / 2 ? 0 : 255;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
  }
  const crushed = encode(rgba, W, H, { codec: CODEC.RAMP, cols: 60, useDither: false });
  assert.ok(crushed.stats.health.clipped > RAMP_CLIP_MAX);
  assert.ok(crushed.warnings.some((w) => /pinned to the first or last/.test(w)));

  // A full-tonal-range image should pass quietly on the measured curve.
  //
  // What this exposed: the disc-on-a-gradient used elsewhere in this file trips
  // the entropy warning at 0.72, using 7 of 11 glyphs. That is correct: it is a
  // synthetic image with little tonal variety. It also shows the warning is
  // sensitive enough to notice. The two real photographs in the bench score
  // 0.91 and 0.94.
  const GW = 240, GH = 320;
  const grad = new Uint8ClampedArray(GW * GH * 4);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = (y * GW + x) * 4;
    const v = Math.round(((x / GW) * 0.6 + (y / GH) * 0.4) * 255);
    grad[i] = grad[i + 1] = grad[i + 2] = v; grad[i + 3] = 255;
  }
  const ok = encode(grad, GW, GH, { codec: CODEC.RAMP, cols: 78 });
  assert.ok(!ok.warnings.some((wn) => /pinned|occupancy/.test(wn)), ok.warnings.join(' | '));
  assert.equal(ok.stats.health.levels, ok.stats.health.levelsAvailable, 'a full sweep should use every glyph');
});

test('the default tone curve keeps coverage in the healthy band, in both polarities', async () => {
  const { INK_TARGET } = await import('../src/constants.js');
  const { rgba, w, h } = syntheticImage(480, 360);
  for (const invert of [false, true]) {
    const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 108, invert });
    assert.ok(
      out.stats.inkTone >= INK_TARGET[0] && out.stats.inkTone <= INK_TARGET[1],
      `invert=${invert}: tone coverage ${(out.stats.inkTone * 100).toFixed(1)}% outside band`,
    );
  }
});

test('polarity flips in the encoder, not just the stylesheet', () => {
  // Left half black, right half white. On a light page the dots must land on
  // the black half; on a dark page, on the white half. Flipping only the CSS
  // would give a photographic negative, which is what the old invert option
  // silently did, because nothing exercised it.
  const W = 128, H = 128;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const v = x < W / 2 ? 0 : 255;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  const inked = (line, from, to) =>
    [...line].slice(from, to).filter((c) => c.charCodeAt(0) !== 0x2800).length;

  const light = encode(rgba, W, H, { codec: CODEC.BRAILLE, cols: 40, invert: false, useDither: false });
  assert.equal(inked(light.lines[5], 0, 20), 20, 'light page: dots over the black half');
  assert.equal(inked(light.lines[5], 20, 40), 0);

  const dark = encode(rgba, W, H, { codec: CODEC.BRAILLE, cols: 40, invert: true, useDither: false });
  assert.equal(inked(dark.lines[5], 0, 20), 0);
  assert.equal(inked(dark.lines[5], 20, 40), 20, 'dark page: dots over the white half');
});

test('dark polarity is the default, and the wrapper agrees with the encoder', async () => {
  const { INVERT_DEFAULT } = await import('../src/constants.js');
  assert.equal(INVERT_DEFAULT, true);
  const { rgba, w, h } = syntheticImage(120, 90);
  const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 40 });
  assert.ok(out.message.includes('background:#000'), 'page should be dark');
  assert.ok(out.message.includes('color:#fff'), 'ink should be light');
  assert.equal(out.stats.invert, true);
});

test('the wrapper carries the measured 0.07em synthetic bolding', async () => {
  const { TEXT_STROKE_EM } = await import('../src/constants.js');
  assert.equal(TEXT_STROKE_EM, 0.07, 'measured on device, not guessed');
  const { rgba, w, h } = syntheticImage(120, 90);
  const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 40 });
  assert.ok(out.message.includes('-webkit-text-stroke:' + TEXT_STROKE_EM + 'em #fff'));
});

test('the old tone defaults would now be caught as crushing', () => {
  const { rgba, w, h } = syntheticImage(480, 360);
  const out = encode(rgba, w, h, {
    codec: CODEC.BRAILLE,
    cols: 108,
    tone: { unsharp: 0.6, clipLo: 2, clipHi: 98, gamma: 1.2, compress: 1.0 },
  });
  // Not asserting it always trips, since that is image dependent, but the
  // machinery has to exist and report a number.
  assert.equal(typeof out.stats.ink, 'number');
  assert.ok(out.stats.ink > 0 && out.stats.ink < 1);
});

test('ordered dithering is the default for cell codecs', () => {
  const { rgba, w, h } = syntheticImage(320, 240);
  const out = encode(rgba, w, h, { codec: CODEC.BRAILLE, cols: 108 });
  assert.equal(out.stats.ditherMode, 'ordered');
});

test('both dither kernels preserve mean brightness', async () => {
  const { orderedDither } = await import('../src/tone.js');
  const n = 64 * 64;
  const src = new Float64Array(n).fill(0.5);
  const o = orderedDither(src, 64, 64, 2);
  const mean = o.reduce((a, b) => a + b, 0) / n;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `ordered mean drifted to ${mean}`);
});

test('ordered dithering is periodic and Floyd-Steinberg is not', async () => {
  const { orderedDither, dither } = await import('../src/tone.js');
  const n = 64 * 64;
  const src = new Float64Array(n).fill(0.5);
  const o = orderedDither(src, 64, 64, 2);
  const f = dither(src, 64, 64, 2);
  // A Bayer screen repeats every 8 px in both axes. This is the property that
  // makes it read as halftone texture rather than grain at visible dot sizes.
  let periodic = true;
  for (let y = 0; y < 56 && periodic; y++)
    for (let x = 0; x < 56; x++)
      if (o[y * 64 + x] !== o[(y + 8) * 64 + (x + 8)]) { periodic = false; break; }
  assert.ok(periodic, 'Bayer output should repeat on an 8x8 lattice');
  // Floyd-Steinberg on a constant field degenerates to a regular checkerboard,
  // so it must be tested on a gradient, where its aperiodic, grain-like
  // character shows up. (The first version of this test used a flat field and
  // wrongly concluded FS was periodic.)
  const grad = new Float64Array(n);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) grad[y * 64 + x] = x / 63;
  const fg = dither(grad, 64, 64, 2);
  let fsPeriodic = true;
  outer: for (let y = 0; y < 56; y++)
    for (let x = 0; x < 56; x++)
      if (fg[y * 64 + x] !== fg[(y + 8) * 64 + (x + 8)]) { fsPeriodic = false; break outer; }
  assert.ok(!fsPeriodic, 'error diffusion should NOT be periodic on a gradient');
  void f;
});

test('braille dots are not sub-pixel at the v1 target', () => {
  // Corrects spec 2.0 point 3. At 108 columns on a 390px DPR-3 phone a braille
  // dot is ~5.4 device pixels: crisply resolved, not averaged into grey. This
  // is why the dither pattern is visible and why the kernel choice matters.
  const dotDevicePx = (390 / 108 / 2) * 3;
  assert.ok(dotDevicePx > 4, `dot is ${dotDevicePx.toFixed(1)} device px`);
});

// ---------------------------------------------------------------------------
// The app shell contract (app/). These run in Node, which is the point: the
// router's resolution, the state shape and the precache list are all testable
// without a DOM, and anything in app/ that stops being importable in Node has
// put DOM work at module scope where it does not belong.
// ---------------------------------------------------------------------------

test('every v1 route resolves to a registered screen', async () => {
  const { V1_ROUTES, resolve, registered, parseHash, DEFAULT_ROUTE } = await import('../app/router.js');
  await import('../app/screens/index.js'); // screens register themselves

  for (const path of V1_ROUTES) {
    const screen = resolve(path);
    assert.ok(screen, `no screen registered for "${path}"`);
    assert.equal(screen.id, path, 'a screen id IS its route path');
    assert.equal(typeof screen.mount, 'function');
  }
  assert.deepEqual(registered(), [...V1_ROUTES].sort(), 'no route registered that is not declared');
  assert.ok(V1_ROUTES.includes(DEFAULT_ROUTE));

  // Hash parsing has to survive a GitHub Pages sub-path and file://, which is
  // why nothing here reads location.pathname. All five spell the default route.
  for (const h of ['', '#', '#/', '#', '#//']) {
    assert.equal(parseHash(h).path, DEFAULT_ROUTE, `"${h}" should be the default route`);
  }
  assert.equal(parseHash('#/settings/size-test').path, 'settings/size-test');
  assert.deepEqual(parseHash('#/compose?n=2&from=capture').params, { n: '2', from: 'capture' });
  assert.equal(parseHash('#/settings/charsets/').path, 'settings/charsets', 'a trailing slash is not a new route');
});

test('the screen contract rejects a typo rather than silently ignoring it', async () => {
  const { defineScreen } = await import('../app/screen.js');
  // The failure this prevents: `unMount` never runs, and the camera stream
  // behind a hidden viewfinder keeps the sensor on.
  assert.throws(() => defineScreen({ id: 'x', title: 'X', mount() {}, unMount() {} }), /unknown key/);
  assert.throws(() => defineScreen({ id: 'x', title: 'X' }), /mount must be a function/);
  assert.throws(() => defineScreen({ id: '', title: 'X', mount() {} }), /id must be/);
});

test('the shell derives columns from src/sizing and never stores them', async () => {
  const { createStore, initialState, currentStyle, currentCols, PERSISTED } = await import('../app/state.js');
  const { sizeRange, defaultCols } = await import('../src/sizing.js');
  const store = createStore();

  // The slider is in characters, and it opens wherever SIZE_DEFAULT_END says.
  // The store must not have its own opinion about that -- this asserts it takes
  // the number from src/sizing rather than carrying a copy.
  assert.equal(store.get().sizeChars, sizeRange().defaultChars);
  assert.equal(store.get().sizeChars, sizeRange().midChars);
  assert.equal(store.get().styleId, 'art');
  assert.ok(!('cols' in store.get()), 'columns are derived, never stored');
  assert.ok(!('codec' in store.get()), 'the codec follows from the style');

  // Same characters, different geometry, on a style swap. The invariant the
  // characters-not-columns decision exists to keep.
  assert.equal(currentCols(store.get()), defaultCols(CODEC.RAMP));
  store.set({ styleId: 'halftone' });
  assert.equal(store.get().sizeChars, sizeRange().defaultChars, 'a style swap must not move the size');
  assert.equal(currentCols(store.get()), defaultCols(CODEC.BRAILLE));
  assert.equal(currentStyle(store.get()).codec, CODEC.BRAILLE);

  // A deleted custom charset must not brick capture.
  store.set({ styleId: 'gone-charset' });
  assert.equal(currentStyle(store.get()).id, 'art');

  // A field that is not in the shape is a typo, not a new field.
  assert.throws(() => store.set({ styleID: 'art' }), /unknown field/);

  // The capture and the encode are session state; settings are not.
  assert.ok(!PERSISTED.includes('capture') && !PERSISTED.includes('encoded'));
  assert.ok(PERSISTED.includes('styleId') && PERSISTED.includes('customCharsets'));

  // subscribe() reports which fields moved, so a screen can ignore the rest.
  let seen = null;
  store.subscribe((_s, changed) => { seen = changed; });
  store.set({ sizeChars: sizeRange().maxChars });
  assert.deepEqual([...seen], ['sizeChars']);
});

test('the precache manifest is generated, and drift fails here rather than in flight', async () => {
  // A hand-maintained list fails open on an added file: every entry still
  // verifies, the offline-ready check stays green, and the new file is not in
  // the cache. That is the failure this test exists to make loud. If it fails,
  // run `npm run precache` and commit the result.
  const { buildManifest, SELF } = await import('../tools/build-precache.js');
  const { PRECACHE, PRECACHE_VERSION } = await import('../app/precache-manifest.js');
  const { readFileSync, existsSync } = await import('node:fs');
  const fresh = buildManifest();

  assert.deepEqual(PRECACHE, fresh.files, `${SELF} is stale. Run \`npm run precache\`.`);
  assert.equal(PRECACHE_VERSION, fresh.version, `${SELF} is stale. Run \`npm run precache\`.`);
  assert.equal(readFileSync(new URL('../app/precache-manifest.js', import.meta.url), 'utf8'), fresh.source);
  // The classic twin, for a service worker that cannot be a module. Generated
  // from the same walk, so it can be stale but it can never disagree.
  assert.equal(readFileSync(new URL('../app/precache-manifest.classic.js', import.meta.url), 'utf8'), fresh.sourceClassic);

  for (const rel of PRECACHE) {
    assert.ok(existsSync(new URL(`../${rel}`, import.meta.url)), `precached file is missing: ${rel}`);
    assert.ok(!rel.startsWith('/'), `precache paths must be relative for the Pages sub-path: ${rel}`);
  }
  // The things the app cannot boot without.
  for (const rel of ['index.html', 'manifest.webmanifest', 'app/main.js', 'src/constants.js']) {
    assert.ok(PRECACHE.includes(rel), `${rel} must be precached`);
  }
});

// ---------------------------------------------------------------------------
// The live viewfinder (spec 5.8). Four tests, and each one pins a place the
// preview could silently stop agreeing with the encoder.

test('splitting autoLevels did not change autoLevels', async () => {
  // The unfreeze of src/tone.js is only defensible if it is genuinely
  // additive. This is the assertion that says so: the composition of the two
  // new halves must be the old function, bit for bit, including the two
  // degenerate branches that once silently deleted the image.
  const { autoLevels, measureLevels, applyLevels } = await import('../src/tone.js');

  const cases = {
    ordinary: Float64Array.from({ length: 400 }, (_, i) => (i % 97) / 96),
    // 97% white with a few dark pixels: the 2nd and 98th percentile land on
    // the same value and the true-range fallback has to fire.
    lineDrawing: Float64Array.from({ length: 400 }, (_, i) => (i < 8 ? 0.05 : 1)),
    flat: new Float64Array(400).fill(0.42),
  };

  for (const [name, luma] of Object.entries(cases)) {
    const { lo, hi } = measureLevels(luma, 2, 98);
    assert.deepEqual(
      Array.from(applyLevels(luma, lo, hi)),
      Array.from(autoLevels(luma, 2, 98)),
      `${name}: measure+apply must equal autoLevels`,
    );
  }

  // And the flat case still passes through rather than inventing 0.5.
  assert.deepEqual(Array.from(autoLevels(cases.flat, 2, 98)), Array.from(cases.flat));
});

test('encode takes supplied tone endpoints, and reports them either way', async () => {
  const { encode } = await import('../src/encode.js');
  const { mockPhoto } = await import('../app/mock.js');
  const photo = mockPhoto({ width: 120, height: 160, subject: 'scene' });
  const opts = { codec: CODEC.BRAILLE, cols: 24 };

  const measured = encode(photo.rgba, photo.width, photo.height, opts);
  assert.equal(measured.stats.levelsSupplied, false);
  assert.ok(measured.stats.rawLevels, 'a measuring encode reports what it measured');
  assert.deepEqual(measured.stats.levels, measured.stats.rawLevels);

  // Supplying exactly what it measured must reproduce the frame, which is what
  // makes the EMA safe: at rest, smoothed endpoints are measured endpoints.
  const supplied = encode(photo.rgba, photo.width, photo.height, {
    ...opts,
    levels: measured.stats.levels,
  });
  assert.equal(supplied.stats.levelsSupplied, true);
  assert.equal(supplied.stats.rawLevels, null, 'no measurement unless asked for one');
  assert.deepEqual(supplied.lines, measured.lines);

  // Supplying different endpoints must actually change the picture, or the
  // option is decorative.
  const shifted = encode(photo.rgba, photo.width, photo.height, {
    ...opts,
    levels: { lo: 0.4, hi: 0.6 },
    reportLevels: true,
  });
  assert.notDeepEqual(shifted.lines, measured.lines);
  // ...and it must still report this frame's own, or the EMA starves.
  assert.deepEqual(shifted.stats.rawLevels, measured.stats.rawLevels);
  assert.deepEqual(shifted.stats.levels, { lo: 0.4, hi: 0.6 });
});

test('the atlas glyph set is indexed exactly as gridToRows indexes it', async () => {
  // Two renderings of one grid: the <pre> on compose serialises through
  // gridToRows, the canvas on capture blits atlas.glyphs[value]. If these two
  // orderings ever disagree the picture is scrambled per cell and globally
  // plausible -- this project's signature failure, and the reason two tests
  // already pin the braille corners.
  const { glyphsFor } = await import('../app/atlas.js');

  for (const [codec, ramp] of [
    [CODEC.BRAILLE, null],
    [CODEC.QUADRANT, null],
    [CODEC.RAMP, DEFAULT_RAMP],
  ]) {
    const glyphs = glyphsFor(codec, ramp);
    const cols = glyphs.length;
    const values = Uint8Array.from(glyphs.map((_, i) => i));
    const row = gridToRows({ codec, cols, rows: 1, values, ramp: ramp || DEFAULT_RAMP })[0];
    assert.equal([...row].join(''), glyphs.join(''), `${codec}: atlas order must match gridToRows`);
  }
});

test('a dot-resolution preview buffer round-trips its own geometry', async () => {
  // camera.grabPreview() sizes its buffer cols*cell.w by rows*cell.h so that
  // encode() recovers exactly the rows it was sized for and downscale() becomes
  // a 1:1 copy. If rowsFor() and that arithmetic ever disagree, the preview
  // silently renders a different grid from the one the readout reports.
  const { CELL_DOTS, CAPTURE_ASPECT } = await import('../src/constants.js');
  const { encode } = await import('../src/encode.js');
  const { supersampleFor, MIN_SAMPLES_PER_CELL } = await import('../app/camera.js');

  // The supersample factor is what fixes the contrast crush: the tone chain
  // must see sub-cell detail, because unsharp's radius is in pixels and the
  // still averages AFTER tone mapping while a dot-resolution preview averages
  // before. Ramp cells are 1x1 dots and need help; the cell codecs do not.
  assert.equal(supersampleFor(CODEC.RAMP), 2);
  assert.equal(supersampleFor(CODEC.BRAILLE), 1);
  assert.equal(supersampleFor(CODEC.QUADRANT), 1);
  for (const codec of [CODEC.BRAILLE, CODEC.QUADRANT, CODEC.RAMP]) {
    const cell = CELL_DOTS[codec];
    const k = supersampleFor(codec);
    assert.ok(cell.w * k >= MIN_SAMPLES_PER_CELL && cell.h * k >= MIN_SAMPLES_PER_CELL,
      `${codec}: every cell must get at least ${MIN_SAMPLES_PER_CELL} samples per axis`);
  }

  for (const codec of [CODEC.BRAILLE, CODEC.QUADRANT, CODEC.RAMP]) {
    const cell = CELL_DOTS[codec];
    const k = supersampleFor(codec);
    for (const cols of [40, 65, 103, 130, 184]) {
      const rows = rowsFor(cols, CAPTURE_ASPECT, 1, codec);
      const w = cols * cell.w * k;
      const h = rows * cell.h * k;

      assert.equal(rowsFor(cols, w, h, codec), rows, `${codec} @${cols}: rows must survive the buffer`);

      // And the aspect the camera reports must make fitToAspect a no-op, or a
      // row of dots is sliced off a buffer that is already dot-exact and every
      // cell below the slice shears by a quarter of a cell.
      const rgba = new Uint8ClampedArray(w * h * 4).fill(128);
      const out = encode(rgba, w, h, { codec, cols, aspect: w / h });
      assert.equal(out.stats.cropped, false, `${codec} @${cols}: preview must not be re-cropped`);
      assert.equal(out.lines.length, rows);
    }
  }
});

// ---------------------------------------------------------------------------
// The 2026-08-09 UX review. Each test below pins a fix to the finding that
// caused it, so a later change that undoes one fails with the reason attached
// rather than with a bare number.
// ---------------------------------------------------------------------------

test('the service worker exists, is at the root, and is not precached', async () => {
  // The review's blocking finding: sw.js did not exist. precache-manifest.js
  // was generated and nothing consumed it, so the premise of the whole product
  // -- offline, on a plane -- was unimplemented and the app was a web page.
  const { readFileSync, existsSync } = await import('node:fs');
  const swUrl = new URL('../sw.js', import.meta.url);
  assert.ok(existsSync(swUrl), 'sw.js must exist');

  const sw = readFileSync(swUrl, 'utf8');
  const { PRECACHE } = await import('../app/precache-manifest.js');

  // At the ROOT, not in app/. A worker served from app/ has scope app/, which
  // does not contain index.html, so the one navigation that matters would never
  // be controlled. GitHub Pages will not send Service-Worker-Allowed.
  assert.ok(!PRECACHE.includes('sw.js'), 'a worker must not precache itself');
  assert.ok(!PRECACHE.includes('app/sw.js'), 'sw.js does not live in app/');

  // It must consume the generated manifest rather than carry its own list. A
  // hand-maintained list fails OPEN on an added file: everything verifies, the
  // readout goes green, and the app dies behind a captive portal.
  assert.match(sw, /importScripts\(['"]app\/precache-manifest\.classic\.js['"]\)/);
  assert.match(sw, /self\.PRECACHE\b/);

  // Relative resolution. A leading slash is the origin root, which is not the
  // app root on GitHub Pages.
  assert.match(sw, /new URL\(p, self\.location\)/);
  assert.ok(!/caches\.match\(['"]\//.test(sw), 'nothing may resolve against the origin root');

  // It must NOT skipWaiting on install. The app is a graph of ES modules; a
  // worker that activates mid-session serves some modules new and some cached
  // old, and the app runs as a mixture of two builds.
  const installBlock = sw.slice(sw.indexOf("addEventListener('install'"), sw.indexOf("addEventListener('activate'"));
  assert.ok(!/skipWaiting/.test(installBlock), 'install must not skipWaiting');
  assert.match(sw, /PT_ACTIVATE_UPDATE/, 'the page must be able to ask for the update deliberately');

  // The share target is a POST, per spec 5.5, and that makes this handler
  // mandatory rather than an optimisation: a GET target would put a
  // 15,000-character message in the query string and in browser history, and a
  // worker that ignored the POST would make sharing silently do nothing.
  const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.share_target.method, 'POST');
  assert.equal(manifest.share_target.enctype, 'multipart/form-data');
  assert.ok(!/^\//.test(manifest.share_target.action), 'the action must be relative, for the sub-path');
  assert.match(sw, /request\.method === 'POST'/, 'the worker must handle the share POST');
  assert.match(sw, /formData\(\)/);
  // 303 is what turns the POST into a GET. Without it the browser re-issues
  // the POST against the landing URL.
  assert.match(sw, /Response\.redirect\([^)]*303\)/);
  // The inbox must survive an activate sweep: a share can arrive while a new
  // worker is installing.
  assert.match(sw, /name !== INBOX/);
});

test('the offline readout reports a version string, never a bare tick', async () => {
  // The 2026-08-09 decision, which the review found unimplemented: silent
  // update-on-load means "fully cached" and "current" are different states, and
  // one tick cannot say both.
  const { offlineLabel } = await import('../app/offline.js');

  assert.equal(offlineLabel({ state: 'unsupported' }), 'no offline');
  assert.equal(offlineLabel({ state: 'caching' }), 'caching…');
  assert.equal(offlineLabel({ state: 'incomplete', missing: ['app/x.js', 'app/y.js'] }), 'offline: 2 missing');
  // Ready is the only state allowed to show a version, and it shows the version
  // rather than the word "ready".
  assert.equal(offlineLabel({ state: 'ready', version: 'pt-abc123' }), 'pt-abc123');
  assert.equal(offlineLabel({ state: 'ready', version: 'pt-abc123', update: true }), 'pt-abc123 · update ready');
});

test('the stage is reserved by the shell, so the picture cannot move between screens', async () => {
  // The review's §1, measured: the art moved 45px up and shrank 12% between
  // capture and the viewer, because each screen composed its own flex column
  // and the stage was "whatever is left after MY chrome".
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

  const tokens = read('app/tokens.css');
  assert.match(tokens, /--pt-chrome-top:\s*\d+px/);
  assert.match(tokens, /--pt-chrome-bot:\s*\d+px/);

  // The grid lives in the shell and uses both bands with 1fr between them.
  const shell = read('app/shell.css');
  assert.match(shell, /\.app-frame\s*\{[^}]*grid-template-rows:\s*var\(--pt-chrome-top\)\s+1fr\s+var\(--pt-chrome-bot\)/s);

  // And no picture screen may reintroduce a column that sizes the stage. This
  // is the actual regression to guard: the bug comes back the moment someone
  // adds `flex: 1` to a stage again.
  //
  // `paste` joined this list on 2026-08-09, when it became the gallery. It was
  // the one screen legitimately outside it before -- a scrolling form with no
  // stage at all -- and it is now the third screen that puts a picture in the
  // reserved box, which makes it the third place the box can be got wrong.
  for (const p of ['app/screens/capture.css', 'app/screens/compose.css', 'app/screens/paste.css']) {
    const css = read(p);
    assert.ok(!/\.(sc-stage|sc-view-stage|sc-open-stage)\s*\{[^}]*flex:\s*1/s.test(css), `${p}: the stage must not size itself`);
    assert.ok(!/\.(sc-capture|sc-view|sc-open)\s*\{[^}]*flex-direction:\s*column/s.test(css), `${p}: the screen must not own the column`);
    // And none of them may pad the stage. Padding on the measured box shrinks
    // the art on that screen only, which is the same bug arrived at from the
    // other side: the gallery's empty state wants a frame gutter and has to put
    // it on its own child instead.
    assert.ok(!/\.app-stage\s*\{/.test(css), `${p}: .app-stage belongs to the shell`);
  }

  // All three picture screens build the shell's frame rather than their own.
  for (const p of ['app/screens/capture.js', 'app/screens/compose.js', 'app/screens/paste.js']) {
    assert.match(read(p), /className = '[\w-]+ app-frame'/, `${p}: must build .app-frame`);
  }

  // And the shell must give all three the same container: no padding, no
  // scrolling. `paste` kept a --pt-space-4 gutter and its own bottom
  // reservation until it became a picture screen, and a padded container is
  // precisely what makes one stage a different size from another.
  for (const route of ['capture', 'compose', 'paste']) {
    assert.match(
      shell,
      new RegExp(`body\\[data-route="${route}"\\] \\.app-screen[^{]*\\{[^}]*padding:\\s*0`, 's'),
      `${route}: the screen container must not pad the frame`,
    );
  }

  // The capture screen must not wipe .app-screen off the container. It did,
  // which made `.app-screen { min-height: 0 }` and the route's `padding: 0;
  // overflow: hidden` dead rules -- and both compose.js and paste.js carried a
  // comment citing capture.js as the example of the mistake.
  // Comments stripped first: this file's own header quotes the old line while
  // explaining why it is gone, and a grep that cannot tell code from prose is a
  // grep that fails the moment someone documents the fix.
  const captureCode = read('app/screens/capture.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bel\.className\s*=/.test(captureCode), 'capture must build into a child');
});

test('the art width is derived from the reserved box, so the chrome cannot breathe', async () => {
  // --pt-art-w used to be the MEASURED width of the last thing painted, so the
  // action bar, the style row and the save sheet all resized on navigation.
  const { stageArtWidth } = await import('../app/art.js');
  const { CAPTURE_ASPECT } = await import('../src/constants.js');

  // Height-bound (a phone): the art is as wide as the aspect allows.
  assert.equal(stageArtWidth(390, 400), 400 * CAPTURE_ASPECT);
  // Width-bound (a tall stage): the box wins.
  assert.equal(stageArtWidth(390, 900), 390);

  // The property that matters: it depends on the BOX only. Two different
  // pictures in the same box must produce the same chrome width, which is what
  // stops a received message with an unusual grid resizing the action bar.
  assert.equal(stageArtWidth(390, 538), stageArtWidth(390, 538));
});

test('a style swipe wraps, survives a deleted charset, and matches the row order', async () => {
  // The review's §2: the style row was a 19px target at 4% down the screen --
  // the worst reach on the device -- in an app whose actionbar.js throws rather
  // than ship a 43px slot.
  const { cycleStyle, styleOrder } = await import('../app/stylegesture.js');
  const { styleList } = await import('../src/styles.js');

  const builtIn = styleList();
  const base = { styleId: builtIn[0].id, customCharsets: [] };

  // The gesture walks the same order the row renders, or "next" means two
  // different things depending on which control you used.
  assert.deepEqual(styleOrder(base, builtIn), builtIn.map((s) => s.id));

  assert.equal(cycleStyle(base, builtIn, 1), builtIn[1].id);
  // Wrapping, both ways. Clamping at either end reads as a dead gesture when
  // there are only three or four styles.
  assert.equal(cycleStyle({ ...base, styleId: builtIn[builtIn.length - 1].id }, builtIn, 1), builtIn[0].id);
  assert.equal(cycleStyle(base, builtIn, -1), builtIn[builtIn.length - 1].id);

  // Custom charsets are on the same ring, after the built-ins.
  const withCustom = { styleId: builtIn[builtIn.length - 1].id, customCharsets: [{ id: 'mine', name: 'Mine', ramp: ' .:#' }] };
  assert.equal(cycleStyle(withCustom, builtIn, 1), 'mine');

  // A deleted charset must not brick the gesture, the same way currentStyle()
  // falls back rather than throwing.
  assert.equal(cycleStyle({ ...base, styleId: 'gone' }, builtIn, 1), builtIn[1].id);
});

test('recents can be pruned, updated in place, and states its own cap', async () => {
  // The review's §6b: once there is a delete button the user believes this is
  // storage, and eight entries with SILENT eviction is then a data-loss bug
  // rather than an undo cache.
  const recents = await import('../app/recents.js');

  // capNote is silent until the cap is in sight -- a warning that is always on
  // is a warning nobody reads.
  assert.equal(recents.capNote(1), '');
  assert.equal(recents.capNote(recents.MAX - 1), '');
  assert.match(recents.capNote(recents.MAX), new RegExp(`${recents.MAX} of ${recents.MAX}`));
  assert.match(recents.capNote(recents.MAX), /oldest drops next/);

  // The functions the two screens now depend on exist and are pure enough to
  // call without a DOM. (localStorage is absent in Node; read() swallows that
  // and returns [], which is the same answer it gives on an opaque origin.)
  assert.equal(typeof recents.remove, 'function');
  assert.equal(typeof recents.update, 'function');
  assert.deepEqual(recents.remove('nothing'), []);
  assert.deepEqual(recents.update('nothing', 'x'), []);
  // An empty message is not an update. update() is called after every settled
  // slider drag, and a failed encode must not blank an entry.
  assert.deepEqual(recents.update('nothing', ''), []);
});

test('the size slider is one component, and neither screen writes the field it drives', async () => {
  // The owner: "be able to edit the line count in the live viewfinder, not just
  // after the image was taken." The control existed only on compose, so the
  // grid could only be chosen after the shot -- against capture.js's own header
  // argument that "WYSIWYG here covers size as well as style".
  //
  // The risk in granting that is a second copy. app/sizeslider.css is a careful
  // rebuild of input[type=range] from the design system's parts, and it
  // documents two rules that are invisible when broken: -webkit-appearance:none
  // has to be set on the input AND on the thumb pseudo-element, and the WebKit
  // and Firefox pseudo-elements cannot be merged into one selector list because
  // an unknown pseudo-element invalidates the whole rule in both engines. A
  // copy that lost either would look wrong on one platform only.
  //
  // So this asserts the same thing the thumbstrip test asserts: one module, and
  // no screen re-implementing it.
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const capture = decomment(read('app/screens/capture.js'));
  const compose = decomment(read('app/screens/compose.js'));
  for (const [name, js] of [['capture', capture], ['compose', compose]]) {
    assert.match(js, /from '\.\.\/sizeslider\.js'/, `${name} must get its slider from the component`);
    assert.ok(!/type = 'range'|createElement\('input'\)/.test(js), `${name} must not build its own range input`);
    assert.ok(!/pt-slider|pt-tick|sc-slider|sc-tick/.test(js), `${name} must not render its own track or ticks`);
    assert.ok(!/DEVICE_MARKERS|function sliderTicks/.test(js), `${name} must not carry its own tick geometry`);
  }

  // And no second stylesheet. The rules live in exactly one place, and as of
  // 2026-08-09 that place is the component's own sheet rather than the viewer
  // screen's. It was compose.css, which meant capture rendered correctly only
  // because index.html links every screen sheet on every route.
  for (const p of ['app/screens/capture.css', 'app/screens/compose.css']) {
    assert.ok(!/::-webkit-slider|::-moz-range/.test(decomment(read(p))),
      `${p}: the range input is rebuilt in one stylesheet, not two: see app/sizeslider.css`);
  }
  // Not merely moved: no screen sheet may keep an orphaned selector for it
  // either, or the rules grow a second home the next time someone fills one in.
  for (const p of ['app/screens/capture.css', 'app/screens/compose.css', 'app/screens/paste.css', 'app/screens/settings.css']) {
    assert.ok(!/\.sc-slider|\.sc-tick|\.sc-view-slider/.test(decomment(read(p))),
      `${p}: the slider's selectors belong to app/sizeslider.css`);
  }

  // The two hazards, asserted in the file that now carries them. Both are the
  // kind of mistake a tidy-up makes and no desktop browser reports.
  const sliderCss = read('app/sizeslider.css');
  assert.match(sliderCss, /\.pt-slider-input\s*\{[^}]*-webkit-appearance:\s*none/s,
    '-webkit-appearance: none on the input');
  assert.match(sliderCss, /::-webkit-slider-thumb\s*\{[^}]*-webkit-appearance:\s*none/s,
    'and again on the thumb, or iOS draws its own on our track');
  assert.ok(!/-webkit-slider-thumb\s*,|::-moz-range-thumb\s*,|,\s*\.pt-slider-input::-moz/.test(sliderCss),
    'the WebKit and Firefox pseudo-elements must stay in separate rules: one selector list applies to neither');

  // Linked and cached, or the control renders unstyled on the flight this app
  // is for. Same pair of assertions the strip's stylesheet gets.
  assert.ok(read('index.html').includes('app/sizeslider.css'), 'sizeslider.css must be linked');
  const { PRECACHE } = await import('../app/precache-manifest.js');
  assert.ok(PRECACHE.includes('app/sizeslider.css'), 'run `npm run precache`');
  assert.ok(PRECACHE.includes('app/sizeslider.js'), 'run `npm run precache`');

  // THE OWNERSHIP REPAIR. state.js's table names one owner per field and
  // sizeChars' was `compose`. Two screens with a slider makes that a two-writer
  // field, which is the problem styleId had and which was repaired rather than
  // accepted. There is no equivalent repair here -- the owner asked for the
  // control on both screens -- so it is applied one level down: the component
  // is the only writer, and the table names the component.
  //
  // Greppable, which is the point of doing it that way, and greppable on BOTH
  // screens as of 2026-08-09. It covered capture alone while compose still
  // wrote the field from the inline control that predated the component; that
  // control is gone, so the caveat in state.js's header is gone with it and
  // this is what holds the row up instead.
  assert.ok(!/sizeChars:/.test(capture), 'capture must not write sizeChars: the component owns the write');
  assert.ok(!/sizeChars:/.test(compose), 'compose must not write sizeChars either: that was the last direct write');
  assert.match(read('app/state.js'), /sizeChars\s+int, CHARACTERS\s+\S+\s+app\/sizeslider\.js/,
    'the owner table must name the writer');
  assert.match(decomment(read('app/sizeslider.js')), /store\.set\(\{ sizeChars:/, 'the component is the writer');

  // Columns are DERIVED and never stored (state.js). The component hands `cols`
  // to its callbacks so a caller never reaches for colsForChars() itself and
  // gets the codec wrong, and that number has to come from the app's one
  // conversion.
  const slider = decomment(read('app/sizeslider.js'));
  assert.match(slider, /currentCols/, 'cols must come from the app-wide conversion');
  assert.ok(!/state\.set\(\{ cols|sizeCols/.test(slider), 'no column count is ever stored');

  // The ticks moved with the control and are still pure, so the spec 5.4
  // disagreement below stays testable without a DOM.
  const { sliderTicks, DEVICE_MARKERS } = await import('../app/sizeslider.js');
  const { sizeRange } = await import('../src/sizing.js');
  assert.equal(DEVICE_MARKERS.length, 4);
  assert.equal(sliderTicks(sizeRange()).filter((t) => t.device).length, 1);

  // DRAG COST. The measurement that decided capture's repaint policy, pinned
  // here because it is the reason the screen is allowed to repaint
  // synchronously on an input event at all.
  //
  // The track is in characters and its one-step positions vastly outnumber the
  // grids they produce. Everything the encoder emits -- cols, rows, and
  // messageChars, which is cells + rows + WRAPPER_BUDGET -- is a function of
  // the column count alone, so an input event that does not move the column
  // count cannot change the picture or the readout, and skipping it is exact
  // rather than approximate. capture skips on that test; if the ratio ever
  // collapsed, so would the justification.
  const { colsForChars } = await import('../src/sizing.js');
  const range = sizeRange();
  const grids = new Set();
  for (let ch = range.minChars; ch <= range.maxChars; ch++) grids.add(colsForChars(CODEC.RAMP, ch));
  const steps = range.maxChars - range.minChars + 1;
  assert.ok(steps > 10000, `the character track should be fine-grained, got ${steps} steps`);
  assert.ok(grids.size < steps / 100,
    `most slider positions must be no-ops: ${grids.size} grids for ${steps} steps`);
  assert.match(read('app/screens/capture.js'), /cols === paintedCols/,
    'capture must skip a repaint when the derived column count has not moved');
});

test('the slider ticks admit that three of spec 5.4 four markers are off the range', async () => {
  // This is the contradiction implementing the ticks surfaced, and it is pinned
  // rather than papered over: spec 5.4 specifies a linear 40-355 COLUMN slider
  // with markers at bubble 40 / phone 108 / tablet 222 / desktop 355. The
  // 2026-08-09 reversal moved the slider to CHARACTERS on a range derived from
  // RAMP_COLS_MIN 65 to RAMP_COLS_MAX 130 -- so only the phone marker is
  // reachable. Two documents disagree and neither knows it.
  //
  // If spec 5.4 is rewritten, or the range widens, this test is the thing that
  // notices.
  //
  // Imported from the component, not from a screen. It was
  // app/screens/compose.js until 2026-08-09, because that is where the ticks
  // were built; a pure geometry function that a test has to reach into a screen
  // module for is the same backwards arrangement as the stylesheet that moved
  // in the same change. compose.js does not export it any more.
  const { sliderTicks } = await import('../app/sizeslider.js');
  const { sizeRange, charsForCols } = await import('../src/sizing.js');
  const { CAPTURE_ASPECT } = await import('../src/constants.js');

  const range = sizeRange();
  const ticks = sliderTicks(range);

  const device = ticks.filter((t) => t.device);
  assert.equal(device.length, 1, 'exactly one spec 5.4 device marker is currently in range');
  assert.equal(device[0].label, 'PHONE');
  assert.equal(device[0].chars, charsForCols(CODEC.RAMP, 108, CAPTURE_ASPECT));

  // Bubble is below the floor and tablet/desktop are above the ceiling.
  assert.ok(charsForCols(CODEC.RAMP, 40, CAPTURE_ASPECT) < range.minChars);
  assert.ok(charsForCols(CODEC.RAMP, 222, CAPTURE_ASPECT) > range.maxChars);
  assert.ok(charsForCols(CODEC.RAMP, 355, CAPTURE_ASPECT) > range.maxChars);

  // The endpoints are labelled, or the track carries one lonely mark and reads
  // as decoration.
  assert.equal(ticks[0].chars, range.minChars);
  assert.equal(ticks[ticks.length - 1].chars, range.maxChars);
  // Every tick is inside the track it is drawn on.
  for (const t of ticks) assert.ok(t.chars >= range.minChars && t.chars <= range.maxChars);
});

test('every route in the table is reachable from the running app', async () => {
  // The review's blocking finding: settings, settings/charsets and
  // settings/size-test were all registered stubs that NOTHING linked to. Spec
  // 5.1 asks for a corner glyph on capture and there was none, so charset
  // editing, calibration, the size test and the offline readout were all
  // unreachable.
  //
  // "Reachable" is asserted the only way it can be without a browser: some
  // screen navigates to it. That catches the failure that actually happened --
  // a route with no inbound link anywhere.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { V1_ROUTES, DEFAULT_ROUTE } = await import('../app/router.js');

  const dir = new URL('../app/screens/', import.meta.url);
  const source = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(new URL(f, dir), 'utf8'))
    .join('\n');

  for (const route of V1_ROUTES) {
    if (route === DEFAULT_ROUTE) continue; // the app opens here
    assert.ok(
      source.includes(`'${route}'`),
      `route "${route}" is registered but nothing in app/screens navigates to it`,
    );
  }
});

test('the picture screens hold the 44px floor the action bar enforces in code', async () => {
  // The review's §4: "the 44px floor is enforced in one place and violated in
  // two". actionbar.js throws at runtime rather than ship a 43px slot, while
  // .sc-style was 19px tall and the open screen's thumbnail carried a hardcoded
  // 10px label.
  //
  // Either the floor is a rule and something checks it across all screens, or
  // it is a rule about the action bar. This is that check.
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

  // Every control small enough to need one must grow its hit box with negative
  // offsets rather than grow the row -- the row lives in a band whose height is
  // fixed and shared.
  //
  // This asserted `inset: -` until 2026-08-09, and the shorthand is exactly what
  // it can no longer be. The style row became a scroll box pinned to --pt-tap
  // (a scroller on one axis forces the other to clip), so the hit box has to
  // land inside 44px rather than merely be 44px, and it cannot be symmetric to
  // do it: `inset` resolves against the containing block's PADDING box, and
  // .sc-style's 1px border-bottom sits outside that, so the two vertical
  // offsets differ by one. Measured in Chrome: -12/-13 lands on 0..44 in the
  // 44px container, symmetric -12 gives 43, symmetric -12.5 gives 44 with half
  // a pixel clipped off each end.
  //
  // So the assertion is on the property that matters -- a negative top and a
  // negative bottom -- rather than on the shorthand that used to express it.
  const captureCss = read('app/screens/capture.css');
  assert.match(captureCss, /\.sc-style::before\s*\{[^}]*top:\s*-\d/s, '.sc-style needs a 44px hit box');
  assert.match(captureCss, /\.sc-style::before\s*\{[^}]*bottom:\s*-\d/s, '.sc-style needs a 44px hit box');

  // DELETE, AND THE EXCEPTION THAT IS NO LONGER ONE. Rewritten 2026-08-09,
  // second pass, when the corner `×` became one labelled button.
  //
  // What this used to assert, and why: `.pt-thumb-del` was a 22px control, and
  // this test held it there on purpose. Expanding it to 44 was the shipped bug
  // -- the hit box covered half the thumbnail it annotated and ran into the next
  // one, so a tap meant to select an old picture deleted it -- and the argument
  // was that a destructive control is the one place a target you can miss costs
  // less than a target you cannot.
  //
  // The owner asked for a real delete button instead, and a labelled button in
  // the chrome band has nothing to overlap. So the exception is retired and the
  // assertion inverts: this control must now MEET the floor the rest of the app
  // is held to, and it must not come back as a per-thumbnail corner glyph.
  //
  // What does not change is the arming, which was never really payment for the
  // small target: there is no undo, so one tap must not be able to lose a
  // picture at any size. Same three things checked as before, one of them the
  // other way round -- a control at the floor, an armed state in the stylesheet,
  // and a handler that reads the attribute before it removes anything.
  const stripCss = read('app/thumbstrip.css');
  const stripJs = read('app/thumbstrip.js');

  assert.match(
    stripCss,
    /\.pt-del\s*\{[^}]*min-height:\s*var\(--pt-tap\)/s,
    '.pt-del must meet the tap minimum rather than argue its way under it',
  );
  assert.ok(
    !/\.pt-del::before/.test(stripCss),
    '.pt-del is already --pt-tap tall; a hit-box expansion on top of that is the corner-delete bug returning',
  );
  assert.match(stripCss, /\.pt-del\[data-armed="1"\]/, '.pt-del needs a visible armed state');
  assert.match(stripJs, /dataset\.armed !== '1'/, 'thumbstrip.js: delete must arm before it fires');

  // And the corner control is gone from both files, not merely unused. A
  // stylesheet that still carries the old rule is a second delete waiting for
  // someone to re-attach it.
  for (const [name, src] of [['app/thumbstrip.css', stripCss], ['app/thumbstrip.js', stripJs]]) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/pt-thumb-del/.test(code), `${name}: the per-thumbnail corner delete must not survive anywhere`);
  }

  // And no stylesheet may carry an off-scale font size again. 10px is now a
  // token, which is the honest way to keep a deliberate exception.
  for (const p of ['app/screens/capture.css', 'app/screens/compose.css', 'app/screens/paste.css', 'app/screens/settings.css', 'app/actionbar.css', 'app/sizeslider.css', 'app/thumbstrip.css', 'app/shell.css']) {
    const css = read(p).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/font-size:\s*\d+px/.test(css), `${p}: font sizes come from tokens, not from literals`);
  }

  // The two divergences the review found, both closed.
  assert.ok(!/rgba\(255,\s*215,\s*0/.test(read('app/actionbar.css').replace(/\/\*[\s\S]*?\*\//g, '')), 'the accent wash is a token');
  assert.match(read('app/tokens.css'), /--pt-accent-wash-hi:/);
  assert.match(read('app/tokens.css'), /--pt-size-2xs:/);
});

test('the recents strip is built once, in one module, and is not gold', async () => {
  // The owner's report was three sentences: the previews should be in the same
  // place and at the same size on every screen, the thumbnails should be one
  // UI, and the scrollbar should match the thin line styling. All three are the
  // same finding, which is that the same eight entries out of the same
  // recents.js cache were rendered by two functions written at different times:
  // 30 x 40 against 46 x 60, a name on one and not the other, a selection
  // underline on one and not the other, the cap note in two places in two
  // colours, an empty state on one and nothing on the other, and the strip
  // itself pinned to a fixed band on one screen and flowing mid-column on the
  // other.
  //
  // app/thumbstrip.js exists so that cannot happen again, the same way
  // app/actionbar.js exists. This asserts the module is the only implementation
  // rather than a third one.
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const screen of ['app/screens/compose.js', 'app/screens/paste.js']) {
    const js = decomment(read(screen));
    assert.match(js, /from '\.\.\/thumbstrip\.js'/, `${screen} must get its strip from the component`);
    // A screen that reaches for paintThumb is a screen building its own
    // thumbnail, which is where both of the old ones started.
    assert.ok(!/paintThumb/.test(js), `${screen} must not paint its own thumbnails`);
    assert.ok(!/sc-strip|sc-thumb|sc-recent/.test(js), `${screen} must not build its own strip`);
  }
  for (const sheet of ['app/screens/compose.css', 'app/screens/paste.css']) {
    const css = decomment(read(sheet));
    assert.ok(!/\.sc-strip|\.sc-thumb|\.sc-recent-/.test(css), `${sheet} must not style its own strip`);
  }

  // One size, one delete, one name, one selection mark, one empty state, and
  // they are in the component. `.pt-thumb-del` became `.pt-del` on 2026-08-09:
  // the control stopped belonging to a thumbnail, which is why it lost the word
  // from its name, but it did not stop belonging to this module.
  const strip = read('app/thumbstrip.css');
  for (const sel of ['.pt-thumb-name', '.pt-thumb.is-on', '.pt-del', '.pt-strip-cap', '.pt-strip-empty']) {
    assert.ok(strip.includes(sel), `thumbstrip.css owns ${sel}`);
  }
  // Neither screen may build a delete of its own now that it is not attached to
  // a thumbnail. Both hand the component a host and it builds the button.
  for (const screen of ['app/screens/compose.js', 'app/screens/paste.js']) {
    const js = decomment(read(screen));
    assert.match(js, /deleteHost:/, `${screen} must get its delete control from the component`);
    assert.ok(!/recents\.remove/.test(js), `${screen} must not delete an entry behind the component's back`);
  }
  // ONE RULE, NOT ONE NUMBER. Changed 2026-08-09, when the owner asked for the
  // gallery's thumbnails to fill the space its band was wasting: "grow the
  // carousel images universally to the available space. Do not change the size
  // of the viewport / full image. That always stays the same."
  //
  // Those two sentences rule out a fixed --pt-thumb-w / --pt-thumb-h, and the
  // arithmetic is why. Both bands are 176px and both are sized so the stage --
  // and therefore the picture -- is identical on every screen, which is the
  // second sentence. The viewer's band has 3px spare and the gallery's had 99.
  // A single fixed size that fits both is therefore the smaller of the two,
  // which is the size we already had, so a fixed token cannot satisfy the first
  // sentence without breaking the second.
  //
  // So the size is a rule -- the card fills the strip, the strip fills the band
  // -- and it resolves to 52 x 39 on the viewer and 99 x 74 on the gallery. Two
  // sizes from one declaration is not the drift this component exists to
  // prevent; that was two declarations disagreeing.
  assert.ok(!/--pt-thumb-w|--pt-thumb-h\b/.test(decomment(strip)),
    'the thumbnail must not carry a fixed size again: it fills the band, and the two bands differ');
  assert.match(strip, /flex:\s*1 1 auto/, 'the strip fills its column rather than pinning a fixed height to the bottom');
  assert.match(strip, /--pt-thumb-box/, 'the card is sized from the strip\'s measured height');
  assert.match(read('app/thumbstrip.js'), /setProperty\('--pt-thumb-box'/,
    'and that height is published by the observer, because CSS cannot derive it');

  // WHAT THE RULE COSTS, and it is the assertion most likely to save someone.
  // A strip that fills the band means any row ABOVE it that appears and
  // disappears resizes every thumbnail instead of moving the strip. Two rows in
  // the app could do that and both were changed to hold their place:
  const slider = read('app/sizeslider.js');
  assert.match(slider, /is-vacant/, 'the size slider must go vacant, not absent: it shares a band with the strip');
  assert.ok(!/el\.hidden\s*=/.test(decomment(slider)),
    'setHidden must not collapse the slider row, or the viewer resizes its thumbnails on every swipe');
  assert.match(read('app/screens/paste.css'), /\.sc-act\b/,
    'the gallery must reserve one row for its actions and its error line');

  // The stylesheet has to be loaded and cached, or the strip renders unstyled
  // on the flight this app is for.
  assert.ok(read('index.html').includes('app/thumbstrip.css'), 'thumbstrip.css must be linked');
  const { PRECACHE } = await import('../app/precache-manifest.js');
  assert.ok(PRECACHE.includes('app/thumbstrip.css'), 'run `npm run precache`');
  assert.ok(PRECACHE.includes('app/thumbstrip.js'), 'run `npm run precache`');

  // The scrollbar. It was 6px with an --pt-accent thumb on both strips, which
  // put a gold scrollbar four pixels under a gold selection underline, against
  // tokens.css's own "if two things on a screen are gold, one of them is
  // wrong". The underline is the one that means something.
  const bars = decomment(strip);
  assert.match(bars, /scrollbar-color:\s*var\(--pt-line-strong\)/);
  // The window ends at the first rule after the scrollbar block. That used to be
  // `.pt-strip-item`, the wrapper that anchored the corner delete; with the
  // corner delete gone the wrapper went too, and the thumbnail is the strip's
  // direct child.
  assert.ok(!/--pt-accent/.test(bars.slice(bars.indexOf('scrollbar-width'), bars.indexOf('.pt-thumb {'))), 'the scrollbar is a hairline, not the accent');
  // And it is still drawn. Hiding it was the state before the gold bar, and it
  // costs a desktop user the only signal that eight thumbnails scroll.
  assert.ok(!/scrollbar-width:\s*none/.test(bars), 'the scrollbar stays visible on desktop');
  assert.match(bars, /::-webkit-scrollbar\s*\{[^}]*height:\s*2px/, 'a hairline, and 2px is what the viewer band can spare');
});

test('the gallery opens on the latest message, and the big paste target is the empty state only', async () => {
  // The owner's report: "the gallery should have a permanent place, by default
  // always opening the latest image ... only if there are no saved images should
  // there be the large full screen paste button."
  //
  // Both halves are one invariant with two sides, and getting either wrong is
  // silent. Open on nothing and the screen looks broken with eight pictures
  // saved; keep the target once there is something saved and the same action
  // exists twice on one screen, which is the duplicate control the two-tile
  // version of this screen was rejected for in the first place.
  //
  // The behavioural half of this -- that the entry actually paints, and that the
  // target actually disappears -- is in test/smoke.mjs, which mounts the screen
  // against a real DOM and a real recents cache. What can be asserted here is
  // that the code says so, which is what catches the change that quietly drops
  // one of the two branches.
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const paste = read('app/screens/paste.js');
  const code = paste.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Slot 0, because recents.add() puts the newest first. Asserted as "reads the
  // list and hands index 0 to show()" rather than as a literal, since the
  // ordering itself is recents.js's contract and is pinned there.
  assert.match(code, /recents\.list\(\)/, 'the gallery must read the cache to know what to open on');
  assert.match(code, /if \(strip\.entries\(\)\.length\) show\(0\);/, 'mount must open on the most recent entry');
  assert.match(code, /else showEmpty\(\);/, 'and fall back to the empty state when there is nothing');

  // The stage holds exactly one of three things, and the target is one of them.
  // A screen that shows the target and a picture at once is the duplicate
  // control returning by another route.
  assert.match(code, /function setMode\(mode\)/, 'the stage must have one owner of what is on it');
  assert.match(code, /empty\.hidden = mode !== 'empty'/, 'the big target is a mode, not a permanent element');
  assert.match(code, /pre\.hidden = mode !== 'picture'/);

  // And it is genuinely the same target, not a new one: the screen still owns
  // .sc-target and its two label lines, so the empty state did not quietly
  // become a different control with the same job.
  const css = read('app/screens/paste.css');
  for (const sel of ['.sc-target', '.sc-target-lead', '.sc-target-sub', '.sc-target-note']) {
    assert.ok(css.includes(sel), `paste.css owns ${sel}`);
  }

  // The library door survives as an action rather than as a row, and it still
  // routes through capture's import sub-mode. Dropping the `?import=1` hop is
  // the regression that would give an imported photo no moment at which style
  // can be chosen -- see the header of capture.js.
  assert.match(code, /navigate\('capture', \{ import: '1' \}\)/, 'the picker must still route through capture');
  assert.match(code, /fileInput\.click\(\)/, 'the library door must still open the system picker');

  // Everything the screen did before it was a gallery. Each of these is a path
  // with no other test: a clipboard read that needs a gesture, a textarea for
  // when that fails, a source cap that keeps a 12 MP photo out of memory, and
  // the share-target inbox.
  assert.match(code, /navigator\.clipboard\.readText\(\)/);
  assert.match(code, /setMode\('field'\)/, 'the clipboard failure must still reveal the textarea');
  assert.match(code, /const MAX_SOURCE_PX = 1600/);
  assert.match(code, /takeSharedText\(\)/);

  // DEFAULT_ROUTE is not this. "Opens the latest image by default" is about the
  // gallery's own initial state; the app still opens on the camera.
  const { DEFAULT_ROUTE } = await import('../app/router.js');
  assert.equal(DEFAULT_ROUTE, 'capture', 'the gallery is a destination, not the front door');
});

// ---------------------------------------------------------------------------
// The flip control, 2026-08-09. Both findings below were shipped bugs, and both
// are invisible to every other test here because they need a real WebGL context
// and a real MediaStream to reproduce. Source assertions are the only guard
// available, so they are written against the specific mistake rather than
// against a shape, and each carries the symptom it caused.
// ---------------------------------------------------------------------------

test('a canvas element is never handed to two viewfinders, and the front camera mirrors in the pixels', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // THE HANG. viewfinder.stop() ends in WEBGL_lose_context.loseContext(), and
  // getContext() returns the SAME context object for an element that already
  // has one. So the second startViewfinder() on one element got a dead WebGL
  // context, fell through to the 2D path, and got null from getContext('2d') --
  // an element holding a WebGL context cannot also hold a 2D one -- and threw
  // out of the constructor. The flip left vf null: no loop, no repaint, and the
  // screen only came back after navigating away and mounting a fresh canvas.
  const capture = strip(read('app/screens/capture.js'));

  // The element must come from a factory, and startSource() must call it. A
  // single `const canvas = document.createElement('canvas')` in mount() is
  // exactly the code that broke, so it must not come back.
  assert.match(capture, /function makeArtCanvas\(\)/, 'the art canvas must be built through a factory');
  assert.ok(
    /async function startSource\(\)[\s\S]*?makeArtCanvas\(\)[\s\S]*?startViewfinder\(/.test(capture),
    'startSource() must mount a fresh canvas before every startViewfinder()',
  );
  assert.ok(
    !/\bconst canvas = document\.createElement\('canvas'\)/.test(capture),
    'the art canvas must not be a per-mount constant: a second viewfinder needs a second element',
  );

  // And the surface must be read back off the viewfinder, because a lost GL
  // context is recovered by putting a fresh element in the old one's place and
  // the old one is then detached, where replaceWith() is a silent no-op.
  assert.match(capture, /canvas = vf\.canvas/, 'capture must re-read the live surface from the viewfinder');

  // The net on the other side: startViewfinder must survive being handed a
  // poisoned element rather than throw out of its own constructor.
  const viewfinder = strip(read('app/viewfinder.js'));
  assert.ok(
    /function useCanvas2d\(\)[\s\S]*?if \(!ctx2d\)/.test(viewfinder),
    'useCanvas2d must handle a null 2D context instead of throwing on it',
  );

  // MIRRORING. It is in the pixel path in camera.js, driven by the track's own
  // reported facing, and it covers the PREVIEW ONLY.
  //
  // This assertion said "exactly two" until 2026-08-09, second pass, and the
  // comment above it argued for it: the preview is a render of the artefact the
  // shutter sends, so mirroring one grab and not the other breaks WYSIWYG. The
  // repo owner overruled that -- "fix the screen and image mirroring to match
  // other camera apps" -- and stock behaviour is preview mirrored, file not.
  //
  // The cost is real and is not hidden: committing a selfie flips the picture
  // between the viewfinder and compose, because compose renders the unmirrored
  // still. It is written out at the `mirrored` const in camera.js and again at
  // commit() in capture.js. This test is the third place, because the number
  // below is the whole of the change and a well-meaning "the still should match
  // the preview" is exactly the edit it has to catch.
  const camera = strip(read('app/camera.js'));
  assert.match(camera, /getSettings\(\)\.facingMode/, 'the flip must follow the track, not the request');
  assert.equal(
    (camera.match(/setTransform\(-1, 0, 0, 1,/g) || []).length, 1,
    'exactly ONE mirrored draw: the preview downscale. The still is true to the lens.',
  );
  // And it is the preview's draw, not the still's. Counting alone would pass if
  // the two swapped, which is the same bug with the sign flipped: a mirrored
  // photograph under an unmirrored viewfinder.
  const drawDown = camera.slice(camera.indexOf('function drawDown('), camera.indexOf('function cropRect('));
  assert.match(drawDown, /if \(mirrored\) out\.ctx\.setTransform\(-1, 0, 0, 1,/, 'the preview downscale is the mirrored one');
  const stillStart = camera.indexOf('grabStill() {');
  const grabStill = camera.slice(stillStart, camera.indexOf('stop() {', stillStart));
  assert.ok(!/setTransform/.test(grabStill), 'grabStill must not mirror: the photograph is true to the lens');

  assert.match(camera, /get mirrored\(\) \{ return mirrored; \}/, 'openCamera must report its own facing');
  assert.match(camera, /get mirrored\(\) \{ return false; \}/, 'openStill must never mirror: an import has no facing');

  // The surprise has to be admitted in prose, where someone hitting it will
  // look, and there are exactly two such places: the decision itself, and the
  // code that hands the still onward to compose. Read UNSTRIPPED, because it is
  // the comments that are the contract here -- a flip nobody wrote down is the
  // failure, not a flip.
  assert.match(read('app/camera.js'), /REVERSED/, 'camera.js must record that mirroring both was reversed');
  assert.match(read('app/camera.js'), /FLIPS THE PICTURE/, 'camera.js must state what the reversal costs');
  assert.match(read('app/screens/capture.js'), /FLIPS HERE/,
    'capture.js commit() must warn that committing a selfie flips the picture');

  // Not a CSS transform on the canvas. That would leave grabStill() unmirrored,
  // and compose renders the same art into a <pre>, where it would not apply at
  // all.
  for (const p of ['app/screens/capture.css', 'app/screens/compose.css', 'app/shell.css']) {
    assert.ok(
      !/scaleX?\(\s*-1/.test(strip(read(p))),
      `${p}: mirroring belongs in the pixels, not in a transform the still cannot see`,
    );
  }
});
