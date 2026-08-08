// Plane Text: drawing a recents entry small.
//
// Extracted 2026-08-09 when the viewer gained a carousel. Before that this was
// twenty lines inside paste.js's renderRecents(); two screens now draw the same
// thumbnail, and this project has paid five recorded times for the same
// geometry existing in two places.
//
// Be honest about what a thumbnail is here. At 40-46px a grid of ramp glyphs
// reads as TEXTURE, not as a picture, and you recognise an entry by its shape
// and its name rather than by seeing the photograph. That is why every entry is
// labelled and why the sampling below is allowed to be crude: it is not a
// preview, and pretending otherwise would mean decoding and re-encoding at a
// thumbnail column count on every render.

import { paintArt } from './art.js';
import { decodeMessage } from './pipeline.js';
import { currentStyle } from './state.js';

// Columns a thumbnail is sampled down to. Small enough that the sampling is
// cheap, large enough that two different photographs do not resolve to the
// same grey rectangle.
export const THUMB_COLS = 18;

// Nearest-neighbour, on the ROWS rather than on the source pixels.
//
// The entry holds a message and nothing else -- that is the whole reason
// recents is close to free -- so there are no pixels to resample. Decoding to
// rows and then dropping every nth row and every nth character is the only
// sampling available, and at this size it is enough.
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
    // Spread rather than slice: a braille or block cell is one code point but
    // string indexing is by UTF-16 unit, and taking every nth INDEX of a string
    // of astral characters would cut cells in half.
    .map((line) => [...line].filter((_c, i) => i % step === 0).join(''));

  paintArt(pre, rows, {
    // parseMessage returns codec: null when the rows mix two cell charsets.
    // Falling back to the current style's codec draws it slightly wrong rather
    // than not at all, which for a 40px thumbnail is the right trade.
    codec: decoded.codec ?? currentStyle(state).codec,
    cols: rows[0]?.length || THUMB_COLS,
    rows: rows.length,
  }, r.width, r.height);
  return true;
}
