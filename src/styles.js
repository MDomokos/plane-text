// Plane Text: styles (spec 5.1).
//
// "A style is a codec + charset + tone settings, chosen at capture, not
// compose." This module makes that true, and it is why shipping two calibrated
// ramps costs nothing architecturally: they are one field apart.
//
// Style also clamps the size slider rather than the reverse (spec 5.1). Style is
// the expressive choice and is made first; size is a consequence. The cap is
// derived from the codec here rather than written down again, because a second
// copy of a legibility figure is how the last three of those drifted.

import { CODEC, RAMP_ART, RAMP_FIDELITY, RAMP_CONVENTIONAL, TONE, STROKE_EM } from './constants.js';
import { maxColsFor, defaultCols, legibleColsFor, sizeRange } from './sizing.js';
import { lintPayload, assertClean } from './lint.js';

// ---------------------------------------------------------------------------
// Art is the default. Two reasons, and the second decided it:
//
//   1. It is calibrated: monotonic in ink coverage, 2.3% evenness error against
//      the conventional ramp's 20-22% and its four tone inversions.
//   2. It still reads as ASCII art in a plain text viewer. Fidelity scores
//      better as a photograph and renders as a page of random letters, and
//      "the message is the art" is the constraint the whole product derives
//      from, so the better picture is not automatically the better default.
//
// Fidelity exists because that trade is real and the sender should own it:
// +0.11 SSIM on the worst font, paid for in the artefact looking like noise.
// ---------------------------------------------------------------------------
export const STYLES = {
  art: {
    id: 'art',
    name: 'Art',
    description: 'Calibrated ASCII art. Reads as text art in any viewer.',
    codec: CODEC.RAMP,
    ramp: RAMP_ART,
  },
  fidelity: {
    id: 'fidelity',
    name: 'Fidelity',
    description: 'Best picture. Renders as letters rather than art.',
    codec: CODEC.RAMP,
    ramp: RAMP_FIDELITY,
  },
  // Kept as a selectable style rather than deleted, decided 2026-08-09. It is
  // measurably the worst of the three (three tone inversions and 21.4% worst
  // error on a real device), but it is also the ramp everyone recognises, and
  // a user who wants it should be able to pick it rather than retype it.
  conventional: {
    id: 'conventional',
    name: 'Conventional',
    description: 'The classic ASCII ramp. Familiar, and measurably the least accurate.',
    codec: CODEC.RAMP,
    ramp: RAMP_CONVENTIONAL,
  },
  halftone: {
    id: 'halftone',
    name: 'Halftone',
    description: 'Braille dots. Highest dot resolution, reads as a wall of dots.',
    codec: CODEC.BRAILLE,
    ramp: null,
  },
};

export const DEFAULT_STYLE = 'art';

// ---------------------------------------------------------------------------
// User-editable charsets, in v1 (decided 2026-08-09).
//
// A custom style is the ramp codec with a user string, which is why this is
// nine lines rather than a subsystem. It is not free to own: it adds a header
// field, an editor screen, a linter surface and a quality-floor warning. That
// was the reason to hesitate and the decision went the other way anyway,
// recorded so the cost is attributed if it bites.
//
// The ramp is validated here rather than at encode time so a bad charset fails
// where the user typed it.
// ---------------------------------------------------------------------------
export function customStyle(ramp, { id = 'custom', name = 'Custom' } = {}) {
  if (typeof ramp !== 'string' || [...ramp].length < 2) {
    throw new Error('a ramp needs at least two glyphs');
  }
  const problems = lintPayload(ramp);
  if (problems.length) {
    assertClean(problems);
  }
  if (ramp.includes(' ')) {
    throw new Error('U+0020 is trimmed at line start and shears the grid. Use U+00A0.');
  }
  return {
    id,
    name,
    description: 'Your charset, lightest glyph first.',
    codec: CODEC.RAMP,
    ramp,
    custom: true,
  };
}

// Resolve a style to everything the encoder needs. Nothing here is stored on
// the style itself if it can be derived: tone, stroke and the size range all
// follow from the codec, and duplicating them is how they go stale.
//
// Changed 2026-08-09: maxCols/defaultCols now come from the shared character
// range, not from the codec's legibility cap. Style no longer clamps the size
// slider to a different track. The endpoints are the same for every style, so
// switching style preserves file size and changes geometry. The legibility cap
// survives as `legibleCols`, which the UI should warn against rather than
// enforce.
export function resolveStyle(id = DEFAULT_STYLE) {
  const style = typeof id === 'object' ? id : STYLES[id];
  if (!style) throw new Error(`unknown style ${id}`);
  return {
    ...style,
    tone: TONE[style.codec],
    stroke: STROKE_EM[style.codec] ?? 0,
    maxCols: maxColsFor(style.codec),
    defaultCols: defaultCols(style.codec),
    legibleCols: legibleColsFor(style.codec),
    sizeRange: sizeRange(),
  };
}

export function styleList() {
  return Object.keys(STYLES).map((id) => resolveStyle(id));
}
