// Plane Text: sizing (spec 5.4).
//
// Columns are derived from the recipient's viewport, not from the character
// budget. This inverts the original formula, which was cols = sqrt(budget/...).
// The character count is now an output, not an input.

import {
  advanceCssFor,
  ADVANCE_NOMINAL,
  MIN_LEGIBLE_PX,
  MIN_ADVANCE_CELL_PX,
  MIN_ADVANCE_GLYPH_PX,
  PHONE_VIEWPORT_PX,
  MEASURE_VIEWPORT_PX,
  RAMP_COLS_MIN,
  RAMP_COLS_MAX,
  SIZE_DEFAULT_END,
  CELL_DOTS,
  CODEC,
  DEFAULT_CODEC,
  TRANSPORT_CEILING,
  WRAPPER_BUDGET,
} from './constants.js';

// line-height that gives square dot pitch for a given codec.
//
//   horizontal dot pitch = (fontSize * advance) / cellDotsW
//   vertical   dot pitch = (fontSize * lineHeight) / cellDotsH
//
// Setting them equal and cancelling fontSize:
//
//   lineHeight = advance * cellDotsH / cellDotsW
//
// For braille (2x4) that is 2 * advance -> 1.2 at advance 0.6.
//
// fontSize cancels. The aspect ratio is invariant under font-size, so scaling
// text to fit the width does nothing about a wrong advance. Only line-height
// fixes it, and CSS cannot read a font's advance width. This is the one job
// that genuinely requires JS (spec 2.0).
export function lineHeightFor(codec, advance = ADVANCE_NOMINAL) {
  const cell = CELL_DOTS[codec];
  if (!cell) throw new Error(`unknown codec ${codec}`);
  return (advance * cell.h) / cell.w;
}

// Vertical stretch factor if the real advance differs from what line-height
// was computed against. 1.0 = correct. >1 = image is too tall.
export function aspectError(codec, assumedAdvance, realAdvance) {
  const lh = lineHeightFor(codec, assumedAdvance);
  const cell = CELL_DOTS[codec];
  const vPitch = lh / cell.h;
  const hPitch = realAdvance / cell.w;
  return vPitch / hPitch;
}

// How many columns fit a viewport, unzoomed.
export function colsForViewport(
  viewportPx = PHONE_VIEWPORT_PX,
  fontPx = MIN_LEGIBLE_PX,
  advance = ADVANCE_NOMINAL,
) {
  return Math.floor(viewportPx / (fontPx * advance));
}

// ---------------------------------------------------------------------------
// The size range, in characters. Reversed from columns 2026-08-09.
//
// One range, shared by every codec, derived once from the ramp column
// measurements. Swapping style therefore preserves the file size and changes
// the geometry, rather than the other way round. See constants.js for why that
// is the invariant to keep, and for the 2.0x-versus-1.42x arithmetic that
// decided it.
// ---------------------------------------------------------------------------

// Characters a grid costs: one per cell, plus one newline per row. The newlines
// are kept: one row per line is what makes the message readable in a plain text
// viewer, a hard constraint rather than a formatting choice.
export function charsForCols(codec, cols, aspect = 3 / 4) {
  const rows = rowsForAspect(codec, cols, aspect);
  return cols * rows + rows;
}

function rowsForAspect(codec, cols, aspect) {
  const cell = CELL_DOTS[codec];
  if (!cell) throw new Error(`unknown codec ${codec}`);
  return Math.max(1, Math.round(cols * (1 / aspect) * (cell.w / cell.h)));
}

// The slider's endpoints. Both ends are the ramp column measurements converted
// to characters, because ramp is the default codec and its numbers are the ones
// that were measured.
export function sizeRange(aspect = 3 / 4) {
  const minChars = charsForCols(CODEC.RAMP, RAMP_COLS_MIN, aspect);
  const maxChars = charsForCols(CODEC.RAMP, RAMP_COLS_MAX, aspect);
  // The midpoint is taken in COLUMNS and then converted, not taken in
  // characters, and the two are different points.
  //
  // Cost is quadratic in columns, so bisecting the CHARACTER range lands at
  // about 103 columns on a 65-130 track -- past the true middle of 97.5, in the
  // upper third of what the user is actually choosing. Bisecting the COLUMN
  // range gives 98 and 12,969 characters, which is below the character midpoint
  // of 14,203 precisely because of that curvature.
  //
  // Columns win because columns are what the slider is for: the readout says
  // "98 columns · fits a phone", and a control whose middle is not in the
  // middle of the thing it names is a control that has to be learned. See
  // SIZE_DEFAULT_END in constants.js for why the default moved off the bottom.
  const midChars = charsForCols(CODEC.RAMP, Math.round((RAMP_COLS_MIN + RAMP_COLS_MAX) / 2), aspect);
  let defaultChars = minChars;
  if (SIZE_DEFAULT_END === 'max') defaultChars = maxChars;
  else if (SIZE_DEFAULT_END === 'mid') defaultChars = midChars;
  return {
    minChars,
    maxChars,
    midChars,
    defaultChars,
  };
}

// Default columns for a codec, from the shared character default.
//
// This used to return the codec's legibility cap, so swapping codec changed the
// file size. It now returns whatever column count lands that codec on the same
// character count, so swapping codec changes the geometry instead.
export function defaultCols(codec = DEFAULT_CODEC, aspect = 3 / 4) {
  return colsForChars(codec, sizeRange(aspect).defaultChars, aspect);
}

// Column ceiling, from the shared character ceiling. Not a legibility clamp;
// see legibleColsFor() for that, which now only warns.
export function maxColsFor(codec = DEFAULT_CODEC, aspect = 3 / 4) {
  return colsForChars(codec, sizeRange(aspect).maxChars, aspect);
}

// ---------------------------------------------------------------------------
// The legibility cap, demoted to advice 2026-08-09.
//
// The per-codec column clamp existed for one reason: spec 5.8 held that a ramp
// glyph needs a bigger cell to stay legible as a glyph than a braille cell
// needs to read as a grey level, so ramp had to be clamped lower. Round 5
// measured a ramp still reading at a 3.16 px cell, 130 columns, below braille's
// own floor. The premise is gone, the two caps converge, and the mechanism no
// longer earns a clamp.
//
// It survives as a warning because the physics is still real: past this the
// recipient has to zoom. The user is told, not stopped.
//
// Both floors are advance widths. Expressing one as a font size and the other
// as an advance is what once made this return a larger cap for ramp than for
// braille, and a test still pins it.
// ---------------------------------------------------------------------------
export function legibleColsFor(codec, viewportPx = PHONE_VIEWPORT_PX) {
  const minAdvancePx = codec === CODEC.RAMP ? MIN_ADVANCE_GLYPH_PX : MIN_ADVANCE_CELL_PX;
  return Math.floor(viewportPx / minAdvancePx);
}

// The measured ramp caps, at the viewport they were measured on. Exposed so a
// UI can label the track honestly instead of re-deriving them from a different
// viewport and quietly disagreeing with the device notes.
export function measuredRampCols() {
  return { min: RAMP_COLS_MIN, max: RAMP_COLS_MAX, viewportPx: MEASURE_VIEWPORT_PX };
}

// Rows for a source aspect ratio. Cells are cellDotsH/cellDotsW times taller
// than wide in dot terms, which for braille is the familiar 0.5 factor.
export function rowsFor(cols, srcW, srcH, codec = DEFAULT_CODEC) {
  const cell = CELL_DOTS[codec];
  const cellAspect = cell.w / cell.h; // 0.5 for braille
  return Math.max(1, Math.round(cols * (srcH / srcW) * cellAspect));
}

// The base line-height the CSS ships with, for a codec.
//
// One function, because having it written out twice caused the round-5 bug:
// wrap.js had `ADVANCE_CSS_GUESS * hRatio` while the Test D harness had bare
// `hRatio`, so every test panel rendered ~1.47x too tall and the transform shim
// quietly crushed it back to 60%. The harness reported success for geometry the
// shipping wrapper never produces.
//
// ANYTHING THAT EMITS A <pre> OF CELLS MUST GET ITS LINE-HEIGHT FROM HERE.
//
// The default advance is per codec (constants.js ADVANCE_CSS), because a single
// value cannot serve latin's 0.60 and Block Elements' 0.71. Passing an explicit
// advance is how the fit shim recomputes this from the measured advance at
// runtime.
export function baseLineHeight(codec, advance = advanceCssFor(codec)) {
  const cell = CELL_DOTS[codec];
  if (!cell) throw new Error(`unknown codec ${codec}`);
  return advance * (cell.h / cell.w);
}

// Columns that land a codec on a target character count, at the fixed capture
// aspect. Added 2026-08-08 for the codec comparison.
//
// The comparison this supports is "same file, which codec makes the better
// picture", so the constant is the message size and the column count is what
// varies. Comparing at equal columns instead would pit a 15,100-char braille
// message against a 30,200-char quadrant one, which flatters whichever codec is
// allowed to spend more.
//
// This exposes something: at equal columns braille and quadrant produce the
// same dot resolution, so quadrant is dominated exactly 2:1 on cost. It earns
// its place only as the fallback if braille has no glyph.
export function colsForChars(codec, targetChars, aspect = 3 / 4) {
  const cell = CELL_DOTS[codec];
  if (!cell) throw new Error(`unknown codec ${codec}`);
  // chars = cols * rows + rows, rows = cols * (1/aspect) * (cell.w/cell.h)
  const k = (1 / aspect) * (cell.w / cell.h);
  // cols^2 * k + cols * k = targetChars
  const cols = Math.round((-k + Math.sqrt(k * k + 4 * k * targetChars)) / (2 * k));
  return Math.max(1, cols);
}

// Full geometry + budget report for a grid.
export function describe(cols, rows, codec = DEFAULT_CODEC) {
  const cell = CELL_DOTS[codec];
  const cells = cols * rows;
  const payloadChars = cells + rows; // one newline per row; they are kept
  const messageChars = payloadChars + WRAPPER_BUDGET;
  return {
    cols,
    rows,
    cells,
    dotsW: cols * cell.w,
    dotsH: rows * cell.h,
    payloadChars,
    messageChars,
    utilisation: messageChars / TRANSPORT_CEILING,
    // The line-height the wrapper actually emits, not the one nominal advance
    // would imply. These disagreed: describe() reported 1.2 for braille from
    // ADVANCE_NOMINAL while the wrapper shipped 1.420 from the per-codec CSS
    // baseline. A report that quietly describes a different artefact than the
    // one on disk is the harness-drift failure this project keeps paying for,
    // five instances and counting.
    lineHeight: baseLineHeight(codec),
    // Kept alongside, because the two are different questions: this is what the
    // line-height would be if the font matched the nominal advance.
    lineHeightNominal: lineHeightFor(codec),
  };
}
