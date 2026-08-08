// Plane Text: the cell grid (spec 4.3).
//
// "The artifact is a cell grid, not a string." Everything derives from an array
// of cell values. Characters are a serialisation of it. In v1 they are also the
// rendering, because the browser lays them out, which is what removed the
// decoder.

import { CODEC, CELL_DOTS, DEFAULT_RAMP, DITHER_MIN_COLS, DITHER_DEFAULT } from './constants.js';
import { downscale, dither, orderedDither } from './tone.js';

// Braille dot numbering is not raster order. The Unicode block inherits the
// historical dot numbering, where bit positions run down the left column then
// down the right, with dots 7 and 8 appended at the bottom afterwards:
//
//   dot layout        bit
//   (x,y)             index
//   (0,0) (1,0)       0     3
//   (0,1) (1,1)       1     4
//   (0,2) (1,2)       2     5
//   (0,3) (1,3)       6     7
//
// Getting this wrong produces a picture that is scrambled within each cell but
// globally plausible: the kind of bug that survives a casual look.
const BRAILLE_BIT = [
  [0, 3],
  [1, 4],
  [2, 5],
  [6, 7],
];

// Quadrant blocks, indexed by a 4-bit mask:
//   bit 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right
//
// Device bug, 2026-08-08: index 0 was U+2800 (blank braille) while every other
// entry is from Block Elements (U+2580-259F). Two Unicode blocks means two
// fallback fonts and two advance widths mixed within a single row, which shears
// the grid. Unlike a uniform wrong advance this cannot be corrected by
// font-size or line-height; the row is the wrong length wherever blanks appear.
// This is the failure the spec called "the one genuinely fatal font-metric
// failure", and we shipped it by accident.
//
// Measured and replaced 2026-08-09. The hypothesis this charset was kept alive
// to test turned out to be wrong.
//
// Round 5 measured the two Block Elements support tiers separately: the
// CP437-era half blocks against the Unicode 3.2 corner glyphs, expecting the
// corners to fall back to a different font. They do not. 0.0% deviation on both
// devices. Block Elements is one tier.
//
// The shear was the blank, and the arithmetic is exact: on Android,
// latin 0.6001 / block 0.7080 = 0.8476, which is the reported 15.2% worst
// per-glyph deviation. On iPad the same charset is clean, because iPad resolves
// Block Elements to effectively the latin font (0.6021 against 0.6002, 0.3%
// apart). So U+00A0 was an Android-only fault, invisible on the other device.
//
// Round 2 swapped U+2800 -> U+00A0 to fix a shear against braille. Round 3
// confirmed it against braille. Neither ever tested it against Block Elements.
// The fix and its confirmation were both measured against the wrong reference.
//
// U+2591 LIGHT SHADE keeps the entire charset inside Block Elements, the only
// structural guarantee available. It costs a permanent grey floor: the "empty"
// cell is no longer empty, so quadrant cannot render true black. Accepted, a
// uniform grey floor is a tone offset and correctable; a shear is not
// correctable at all.
//
// STILL UNVERIFIED: U+2591's own advance has not been measured against the
// block tier on either device. Check it before trusting quadrant, or this is
// the same mistake for a third time.
const QUADRANT_CHARS = [
  '░', // 0000 none. U+2591 LIGHT SHADE. Not U+0020 (leading-whitespace
            //         trim), not U+2800 (braille block, shears everywhere),
            //         not U+00A0 (latin block, shears on Android only).
  '▘', // 0001 TL
  '▝', // 0010 TR
  '▀', // 0011 top half
  '▖', // 0100 BL
  '▌', // 0101 left half
  '▞', // 0110 TR+BL
  '▛', // 0111 all but BR
  '▗', // 1000 BR
  '▚', // 1001 TL+BR
  '▐', // 1010 right half
  '▜', // 1011 all but BL
  '▄', // 1100 bottom half
  '▙', // 1101 all but TR
  '▟', // 1110 all but TL
  '█', // 1111 full block
];

// A grid is { codec, cols, rows, values, ramp }.
// values[i] is a cell value: a 0..255 braille byte, a 0..15 quadrant mask, or
// a ramp index.
export function buildGrid(luma, srcW, srcH, { codec, cols, rows, ramp = DEFAULT_RAMP, useDither = true, ditherMode = DITHER_DEFAULT }) {
  const cell = CELL_DOTS[codec];
  if (!cell) throw new Error(`unknown codec ${codec}`);

  const dotsW = cols * cell.w;
  const dotsH = rows * cell.h;
  const small = downscale(luma, srcW, srcH, dotsW, dotsH);

  const isCellCodec = codec === CODEC.BRAILLE || codec === CODEC.QUADRANT;
  const levels = isCellCodec ? 2 : ramp.length;

  const shouldDither = useDither && cols >= DITHER_MIN_COLS;
  const kernel = ditherMode === 'fs' ? dither : orderedDither;
  const quantised = shouldDither ? kernel(small, dotsW, dotsH, levels) : small;

  const values = new Uint8Array(cols * rows);

  if (codec === CODEC.BRAILLE) {
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let byte = 0;
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const v = quantised[(cy * 4 + dy) * dotsW + (cx * 2 + dx)];
            // Dense glyph == dark ink. Ink where the source is dark.
            if (v < 0.5) byte |= 1 << BRAILLE_BIT[dy][dx];
          }
        }
        values[cy * cols + cx] = byte;
      }
    }
  } else if (codec === CODEC.QUADRANT) {
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let mask = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const v = quantised[(cy * 2 + dy) * dotsW + (cx * 2 + dx)];
            if (v < 0.5) mask |= 1 << (dy * 2 + dx);
          }
        }
        values[cy * cols + cx] = mask;
      }
    }
  } else if (codec === CODEC.RAMP) {
    const n = ramp.length;
    for (let i = 0; i < values.length; i++) {
      // ramp is sorted lightest-first, so a dark pixel picks a high index
      const idx = Math.round((1 - quantised[i]) * (n - 1));
      values[i] = Math.min(n - 1, Math.max(0, idx));
    }
  }

  return { codec, cols, rows, values, ramp, dithered: shouldDither, ditherMode };
}

// Grid -> array of row strings. One row per line: this is what makes the
// message readable as art in a plain text viewer, which is a hard constraint.
export function gridToRows(grid) {
  const { codec, cols, rows, values, ramp } = grid;
  const out = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      const v = values[y * cols + x];
      if (codec === CODEC.BRAILLE) line += String.fromCharCode(0x2800 + v);
      else if (codec === CODEC.QUADRANT) line += QUADRANT_CHARS[v];
      else line += ramp[v];
    }
    out.push(line);
  }
  return out;
}

// Rows -> grid. Used by the tests to prove serialisation is lossless, and by
// the app's paste-to-decode path. There is no decoder in the message; this
// lives in the app only.
export function rowsToGrid(rows, codec, ramp = DEFAULT_RAMP) {
  const nRows = rows.length;
  const cols = nRows ? [...rows[0]].length : 0;
  const values = new Uint8Array(cols * nRows);
  for (let y = 0; y < nRows; y++) {
    const chars = [...rows[y]];
    if (chars.length !== cols) {
      throw new Error(`row ${y} has ${chars.length} cells, expected ${cols} -- the grid is not rectangular`);
    }
    for (let x = 0; x < cols; x++) {
      const ch = chars[x];
      let v;
      if (codec === CODEC.BRAILLE) v = ch.charCodeAt(0) - 0x2800;
      else if (codec === CODEC.QUADRANT) v = QUADRANT_CHARS.indexOf(ch);
      else v = ramp.indexOf(ch);
      if (v < 0 || v === undefined) throw new Error(`unmappable character U+${ch.charCodeAt(0).toString(16)} at ${x},${y}`);
      values[y * cols + x] = v;
    }
  }
  return { codec, cols, rows: nRows, values, ramp };
}

export { QUADRANT_CHARS, BRAILLE_BIT };
