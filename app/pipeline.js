// Plane Text: the bridge between a screen and src/.
//
// Two jobs, plus one piece of state the store does not hold.
//
// SHELL.md fixes `state.capture` as `{ source, width, height, takenAt }`. There
// is nowhere in that shape for an RGBA buffer, and there should not be: the
// store is shallow-merged, JSON-serialised for the persisted slice, and read by
// screens that only need to know a photo exists. A 1.2 MB typed array would be
// carried through every set() and every subscriber.
//
// Compose has to re-encode when the size slider moves, and that needs the source
// pixels. So the pixels sit here in a module holder and the store keeps the
// metadata the contract describes. `subject` below is the object the two screens
// hand between them. It has one writer at a time: capture sets it and navigates,
// compose reads it. It is cleared on consumption rather than left behind, for
// the same reason `capture` and `encoded` are not persisted.
//
// If a third screen needs it, that is the argument for a store field with a
// documented owner, and it belongs in SHELL.md's disagreements section.

import { encode } from '../src/encode.js';
import { parseMessage } from '../src/wire.js';
import { gridToRows } from '../src/cells.js';
import { currentStyle, currentCols } from './state.js';

// { kind: 'mine',   photo, word, takenAt, source }   an image we can re-encode
// { kind: 'theirs', message, name, decoded }         a message we received
let subject = null;

export function setSubject(next) {
  subject = next;
}

export function getSubject() {
  return subject;
}

export function clearSubject() {
  subject = null;
}

// Encode a photo at the current style and size.
//
// Every option is read from the store or resolved from src/. currentCols() is
// the only place the app converts the slider's character count into columns,
// and currentStyle() is the only place a style id becomes a codec and a ramp.
// Rule 4 of SHELL.md; the reason for it is the first paragraph of README.md.
export function encodePhoto(state, photo, { title }) {
  const style = currentStyle(state);
  return encode(photo.rgba, photo.width, photo.height, {
    codec: style.codec,
    cols: currentCols(state),
    // Halftone carries `ramp: null`, and passing that through would override
    // the encoder's default with a null. Only send a ramp when there is one.
    ...(style.ramp ? { ramp: style.ramp } : {}),
    invert: state.invert,
    title,
  });
}

// Decode a pasted or shared message.
//
// parseMessage never throws. A message with no header, a truncated one, or one
// whose header disagrees with its rows all come back with a grid and a list of
// warnings, and the rows are always authoritative for geometry. A screen should
// show the picture and surface the warnings, not refuse the picture.
//
// Returns null only when there was nothing decodable at all, which is the case
// that deserves the error state in spec 8.
export function decodeMessage(text) {
  const parsed = parseMessage(String(text || ''));
  if (!parsed.grid || !parsed.lines.length) return null;
  return {
    ...parsed,
    // Re-serialising the grid rather than reusing parsed.lines round-trips
    // through the same function the encoder uses, so a decode that lost a row
    // shows up here rather than three screens later.
    rows: gridToRows(parsed.grid),
  };
}

// Does this text claim to be one of ours? Cheap enough to run on a paste before
// doing any work, and it decides between showing the picture and spec 8's
// "that doesn't look like a Plane Text image".
export function looksLikeMessage(text) {
  const parsed = parseMessage(String(text || ''));
  return Boolean(parsed.magic || (parsed.grid && parsed.lines.length));
}
