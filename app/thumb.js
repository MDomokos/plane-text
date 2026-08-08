// Plane Text: drawing a recents entry small.
//
// Shared by the open screen's strip and the viewer's carousel.
//
// At 40-46px a grid of ramp glyphs reads as texture, so an entry is recognised
// by its shape and its name. That is why the sampling below can be crude.

import { paintArt } from './art.js';
import { decodeMessage } from './pipeline.js';
import { currentStyle } from './state.js';

export const THUMB_COLS = 18;

// An entry holds a message and nothing else, so there are no pixels to
// resample. Decode to rows, then drop every nth row and every nth cell.
export function paintThumb(pre, message, box, state) {
  const decoded = decodeMessage(message);
  if (!decoded) return false;
  const r = box.getBoundingClientRect();
  if (!r.width || !r.height) return false;

  const src = decoded.rows;
  if (!src.length || !src[0].length) return false;

  const step = Math.max(1, Math.floor(src[0].length / THUMB_COLS));
  const rows = src
    .filter((_l, i) => i % step === 0)
    // Spread, not slice. A braille or block cell is one code point but string
    // indexing is by UTF-16 unit, so taking every nth index would cut cells in
    // half.
    .map((line) => [...line].filter((_c, i) => i % step === 0).join(''));

  paintArt(pre, rows, {
    // codec is null when the rows mix two cell charsets. At this size drawing
    // it slightly wrong beats not drawing it.
    codec: decoded.codec ?? currentStyle(state).codec,
    cols: rows[0]?.length || THUMB_COLS,
    rows: rows.length,
  }, r.width, r.height);
  return true;
}
