// Plane Text: shared constants.
// Spec: every budget and geometry figure is defined once, here, so a single
// measurement (Test A, Test D) updates the whole app.

// ---------------------------------------------------------------------------
// Transport (spec 2.1). Provisional until Test A. Low stakes: at ~7.7%
// utilisation we could be wrong by half and nothing changes.
// ---------------------------------------------------------------------------
export const TRANSPORT_CEILING = 65536;

// ---------------------------------------------------------------------------
// Viewport geometry (spec 2.0). The binding constraint.
// ---------------------------------------------------------------------------

// Monospace advance width as a fraction of font-size.
//
// Measured 2026-08-09, Test D round 5. There is no single number here:
// ADVANCE IS A PROPERTY OF THE CHARSET, NOT OF THE DEVICE.
//
//   charset              Pixel/Chrome   iPad/Safari   cross-device spread
//   Latin (ramp)             0.6001        0.6002          0.02%
//   Braille                  0.7002        0.6836          2.4%
//   Block Elements           0.7080        0.6021         17.6%
//
// Latin is identical to four decimal places across two unrelated font stacks.
// Braille and Block Elements resolve to different fallback fonts from Latin on
// at least one platform, which is why they differ at all. It is the strongest
// argument in the project for ramp as the default codec: ramp is the only
// charset whose CSS baseline can be a fixed number and be right everywhere.
export const ADVANCE_MEASURED = {
  latin:   { android: 0.6001, ipad: 0.6002 },
  braille: { android: 0.7002, ipad: 0.6836 },
  block:   { android: 0.7080, ipad: 0.6021 },
};

// Nominal, for sizing arithmetic that is not codec-specific. Latin, because
// that is the default codec and the only stable one.
export const ADVANCE_NOMINAL = 0.60;

// ---------------------------------------------------------------------------
// The CSS baseline, per codec. Replaces the single ADVANCE_CSS_GUESS = 0.68.
//
// EVERY VALUE ROUNDS UP from the largest measurement. Spec 4.4: guessing high
// wastes width, guessing low causes horizontal scroll, and only one of those is
// fatal. 0.68 was below braille's real 0.7002 on Android, the fatal direction,
// and the shipping wrapper sets overflow-x:hidden, so it did not scroll. It
// clipped about 3% off the right edge of every braille message with JS
// disabled, silently. That is what this table exists to prevent.
//
//   codec      value   waste with JS off (android / ipad)
//   ramp       0.61     1.6% / 1.6%     effectively exact
//   braille    0.71     1.4% / 3.9%     comfortable
//   quadrant   0.71     0.3% / 17.9%    no single value works; see below
//
// Quadrant is why the fit shim is no longer optional in practice. Block
// Elements span 0.6021 to 0.7080 across two devices, so any fixed CSS value is
// badly wrong on one of them. The shim measures the real advance at runtime and
// recovers it; without JS, quadrant on an iPad wastes a sixth of the width.
// ---------------------------------------------------------------------------
export const ADVANCE_CSS = {
  [3 /* CODEC.RAMP */]: 0.61,
  [1 /* CODEC.BRAILLE */]: 0.71,
  [2 /* CODEC.QUADRANT */]: 0.71,
};

// Codec-keyed lookup with a safe default. Nothing should read ADVANCE_CSS
// directly: a missing codec must not silently become undefined inside a calc().
export function advanceCssFor(codec) {
  const a = ADVANCE_CSS[codec];
  if (!a) throw new Error(`no CSS advance baseline for codec ${codec}`);
  return a;
}

// The viewport every round-5 measurement was taken at. Any figure below
// expressed as a ratio of pixels to columns is only meaningful with this.
export const MEASURE_VIEWPORT_PX = 411;

// ---------------------------------------------------------------------------
// Legibility floors.
//
// Units warning, and this bit a test on the first run: spec 2.0 states its
// floor as a font size (6 px) while spec 5.8 states its floor as an advance
// width (5-6 px). Those are not the same quantity: a 6 px font at advance 0.6
// has a 3.6 px advance. Reading both as font sizes makes the ramp cap come out
// larger than the braille cap, which is backwards.
//
// Both are normalised to advance in px here, and nothing in this codebase
// should express a legibility floor as a font size.
// ---------------------------------------------------------------------------

// Measured on device 2026-08-08, replacing the guesses.
//
// Braille keeps improving as columns rise, up to about 150 on a 390 px
// viewport: 2.6 px per cell, 1.3 px per dot. Below that the dots stop reading
// as solid, which is what synthetic bolding (TEXT_STROKE_EM) exists to hold
// off. 150 is the useful maximum, not merely the tolerable one.
export const MIN_ADVANCE_CELL_PX = 390 / 150; // 2.6

// Ramp: re-measured 2026-08-09, and the old value was wrong by a factor of 1.6.
//
// 78 columns was recorded as "measured on device" in round 4, which is also
// when every panel was being squashed to 60% of its height by a line-height
// bug. The cap was judged on glyphs compressed 40% vertically, which stop being
// readable sooner than correct ones do. Re-taken on a correct render: 65
// columns is legible and "could go lower", 130 is a good top end.
//
// At 130 columns on the 411 px measuring viewport a cell is 3.16 px. Spec 5.8
// claims a glyph needs 5-6 px where a grey level needs 3.6 px. Disconfirmed: at
// 3.16 px a ramp glyph still reads.
//
// The device verdict on what it looks like: "almost a grey photo, but that is a
// feature." That closes the oldest open question in the project and removes the
// reason for a per-codec column clamp. See maxColsFor().
export const MIN_ADVANCE_GLYPH_PX = MEASURE_VIEWPORT_PX / 130; // 3.16

// ---------------------------------------------------------------------------
// Size range: the slider is in characters, not columns (reversed 2026-08-09).
//
// The 2026-08-08 decision moved it to columns on the grounds that the user is
// not managing a scarce character budget, they are choosing how big the
// recipient's screen has to be. Both halves of that changed:
//
//   1. At ramp/130/3:4 a message is 22,663 characters, 34.6% of the ceiling,
//      not the 7% the surplus argument was built on. It is a budget again.
//   2. You cannot hold both invariant. Fix columns and file size swings 2.0x
//      across a codec swap (ramp costs exactly 2x braille at equal columns);
//      fix characters and required screen width swings 1.42x (sqrt 2, because
//      rows scale with columns so cost is quadratic). Characters is the
//      smaller swing, and it protects the property a user can be surprised by:
//      a message that was fine becoming too big because they changed style.
//
// Endpoints are shared across codecs and derived from the ramp column
// measurements, so swapping style keeps the file size and changes the geometry.
// There is no per-codec legibility clamp: the app will let you produce an
// illegible message and the user slides until it reads. Accepted.
// ---------------------------------------------------------------------------
export const RAMP_COLS_MIN = 65;   // legible, and could go lower
export const RAMP_COLS_MAX = 130;  // "a good top end"

// Which end the slider opens at: 'min' | 'mid' | 'max'.
//
// Was 'min', decided earlier on 2026-08-09: the low end is where the artefact
// is most recognisably text art rather than a grey photograph, and it is the
// safe end for fit, cost and unknown screens. The note recorded the cost --
// "the default output is the lowest-resolution one the app can make" -- and set
// the condition for revisiting: "if the reflex is always to push the slider up,
// this is wrong."
//
// MOVED TO 'mid' LATER THE SAME DAY, and by the condition rather than by taste.
// The condition was already met before a single real send, from inside the
// project's own documents: SHELL.md item 10 says a 65-column grid is too coarse
// to frame with, and 65 is RAMP_COLS_MIN -- so the slider was opening at a size
// the app's own notes say you cannot judge a picture at. The reflex to push it
// up was not a prediction; it was written down.
//
// 'mid' is the midpoint in COLUMNS, not in characters, and the two are not the
// same point: cost is quadratic in columns, so bisecting the character range
// lands at ~103 columns on a 65-130 track while bisecting the column range
// gives 98. Columns win because columns are what the slider is choosing and
// what the readout names. A control whose middle is not the middle of the thing
// it names has to be learned.
//
// The new cost, stated as plainly as the old one: the default message is now
// ~12,969 characters rather than ~5,742. That is 2.3x, and it is still under a
// fifth of the transport ceiling. If the reflex turns out to be pulling the
// slider DOWN, this is wrong in the other direction.
export const SIZE_DEFAULT_END = 'mid';

// Retained for the spec 2.0 arithmetic, which is written in font-size terms.
export const MIN_LEGIBLE_PX = MIN_ADVANCE_CELL_PX / 0.6; // 6

// Reference phone viewport, CSS px.
export const PHONE_VIEWPORT_PX = 390;

// ---------------------------------------------------------------------------
// Fixed capture aspect: 4:3 portrait, i.e. 3 wide : 4 tall.
// Decided 2026-08-08. Mobile is the target; the viewfinder and every output
// use this and nothing else.
//
// Why fix it rather than follow the source:
//   - A portrait phone shows a portrait image at full width. Fitting a
//     landscape image onto a portrait screen wastes most of the screen, and
//     width is the binding constraint (spec 2.0).
//   - If the user wants landscape they rotate the phone, which shows the same
//     image larger than letterboxing it would.
//   - The part that pays for itself: with the aspect a known constant, the
//     wrapper can carry the target ratio and the fit shim can force it with
//     scaleY. No reasoning about glyph internals, no per-codec correction,
//     which is what fixes the quadrant vertical stretch generically.
// ---------------------------------------------------------------------------
export const CAPTURE_ASPECT = 3 / 4; // width / height

// Wrapper overhead, characters.
//
// Measured, not estimated: 694 for a braille grid (513 markup+CSS, 181 shim).
// The spec's stated figure was ~600, a guess made before the wrapper existed,
// 16% low. The budget below carries headroom so a small addition does not
// immediately fail the test, and the test asserts both bounds so it fails if
// the wrapper grows or if something is silently dropped.
//
// Moved five times, all device-driven: 694 -> 1005 (canvas ink measurement) ->
// 764 (ink measurement reverted, it squashed the image) -> 796 (synthetic
// bolding for small dots) -> 857 (transform-based shim plus its wrapper div) ->
// 1037 (2026-08-09: the P2 measured-line-height shim, plus data-r) ->
// 1066 (2026-08-09: the header line replaced the bare magic string). Every move
// was a measurement replacing a guess, which is the process working; the spec's
// original ~600 estimate is now 78% low.
//
// The last move is the only one that was not device-driven. The header costs 29
// characters over the bare `PLANETEXT1` it replaced on a braille message, and
// about 40 on a ramp message because the ramp glyphs travel with it. That is
// the price of the message decoding at all when the header survives, against a
// format that decodes from the rows alone when it does not.
//
// Keep an eye on the last move. It bought glyph-shape correctness on ramp and
// quadrant for ~174 characters, which at a 5,742-character default message is
// 3% overhead. Cheap, but the wrapper has grown 50% in a day and "the wrapper
// is ~600 bytes of markup" has stopped being true.
export const WRAPPER_BUDGET = 1200;
export const WRAPPER_MEASURED = 1066;

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------
// The magic string, and the only one. `TXC1` appeared in the spec's binary
// header table and never in any code; it was deleted from the spec 2026-08-09
// along with the binary header itself. One string to scan the clipboard for
// (spec 5.5), one string to grep.
export const MAGIC = 'PLANETEXT1';

// Wire format version, carried explicitly as `v=` on the header line rather
// than folded into the magic. The magic answers "is this ours" and wants to be
// stable; the version answers "can we read it" and wants to move. Folding them
// would make a v2 message report as "not a Plane Text image" instead of "sent
// from a newer version", which is a different error state (spec 8).
//
// Lives here rather than in wire.js because it is a property of the format, the
// way MAGIC is. The header KEY NAMES do not: they are grammar, they have
// exactly one consumer, and they belong next to the parser that defines them.
export const WIRE_VERSION = 1;

export const CODEC = {
  BRAILLE: 1,
  QUADRANT: 2,
  RAMP: 3,
  WEBP: 8, // v1.1
};

// Codec names for the wire. The header carries the name, not the number: `c=3`
// tells a human reading the raw message nothing, and the message being readable
// by a human is the entire product. The numbers stay the in-code
// representation, and the parser accepts either (spec 4.2).
export const CODEC_NAME = {
  [CODEC.BRAILLE]: 'braille',
  [CODEC.QUADRANT]: 'quadrant',
  [CODEC.RAMP]: 'ramp',
  [CODEC.WEBP]: 'webp',
};

export const CODEC_BY_NAME = Object.fromEntries(
  Object.entries(CODEC_NAME).map(([n, name]) => [name, Number(n)]),
);

// ---------------------------------------------------------------------------
// Default codec: ramp, decided 2026-08-08.
//
// Zsolt's call, on the best balance of readability and on the ramp being the
// more interesting artefact: a ramp message reads as text art in a plain text
// viewer, which is the property the whole product is built around. A braille
// message read as text is a wall of dots.
//
// It also retires most of the project's open font risk in one move. That was
// not the reason given, and it is a large second prize. The ramp charset is
// Latin plus U+00A0, so:
//   - no tofu risk    every glyph is in every monospace font
//   - no shear risk   one Unicode block, one fallback font, one advance
//   - no two-lattice problem  a one-dot cell has no internal lattice to
//                     mismatch, so the row gutters and the per-codec
//                     line-height arguments do not arise
// Braille and quadrant each carry at least one of those as an open, unfixable
// failure mode. The "single most dangerous unknown in the project", braille
// advance consistency, stops being load-bearing the moment ramp is default.
//
// What this costs, stated so it is not discovered later:
//   - Fidelity per character. Braille packs 8 dots per cell against ramp's ~3.5
//     bits of tone, so at equal characters braille carries more information.
//     Section 3 of Test D is the measurement of whether that translates into a
//     better-looking picture; this decision pre-empts it rather than settling
//     it.
//   - The ramp needs calibrating to the rendering font (spec 5.7). Braille
//     needed no atlas and consulted no font metrics for tone. That work is now
//     on the critical path rather than deferred.
//   - The default column count is unsettled. MIN_ADVANCE_GLYPH_PX is marked
//     provisional below (the 78-column cap was judged on art the harness was
//     squashing 40% vertically), so the default codec currently ships with a
//     size we know was measured wrong.
// ---------------------------------------------------------------------------
export const DEFAULT_CODEC = CODEC.RAMP;

// Cell geometry in dots, per codec. The renderer derives pixel dimensions
// from this rather than the header carrying both.
export const CELL_DOTS = {
  [CODEC.BRAILLE]: { w: 2, h: 4 },
  [CODEC.QUADRANT]: { w: 2, h: 2 },
  [CODEC.RAMP]: { w: 1, h: 1 },
};

// ---------------------------------------------------------------------------
// Character bans (spec 4.1). WhatsApp markdown, plus HTML-significant chars.
// The second group is banned because escaped entities inside a <pre> break the
// one-character-per-cell correspondence, not because of escaping cost, which
// stopped mattering at 7.7% utilisation.
// ---------------------------------------------------------------------------
export const BANNED_MARKDOWN = ['*', '_', '~', '`'];
export const BANNED_HTML = ['<', '>', '&'];
export const BANNED_ALL = [...BANNED_MARKDOWN, ...BANNED_HTML];

// Default ramp. Coverage-sorted lightest-first.
//
// The lightest glyph is U+00A0 (no-break space), written as an escape so it
// cannot be confused with U+0020 by eye or by an editor. Spec 3 flagged this
// tension and the linter caught it on the first test run: any ramp containing
// a plain space produces leading whitespace wherever the image's left edge is
// bright, and WhatsApp trims leading whitespace per line, which shifts those
// rows and shears the picture.
//
// U+00A0 rather than U+2800 because a braille blank would resolve to a
// different fallback font than the Latin ramp glyphs, reintroducing exactly
// the advance-width mismatch this codec is meant to avoid.
export const RAMP_BLANK = '\u00A0';

// ---------------------------------------------------------------------------
// The conventional ramp is broken, and this is measured rather than argued.
//
// " .:-=+ox#%@" is not monotonic in ink coverage in any font tested. DejaVu
// Sans Mono, Liberation Mono and Latin Modern Mono all agree. Measured coverage
// against the position the encoder assumes:
//
//   '-'  0.10 where the encoder assumes 0.30    LIGHTER than ':' before it
//   '+'  0.39 where the encoder assumes 0.50    LIGHTER than '=' before it
//   'x'  0.53 where the encoder assumes 0.70    LIGHTER than 'o' before it
//   '%'  0.66 where the encoder assumes 0.90    LIGHTER than '#' before it
//
// Four inversions. In those bands a darker source pixel produces a lighter
// glyph: not uneven spacing, a local tone reversal. Worst error is 20-22% of
// the tonal range, consistently across the three fonts, so this is a property
// of the character choice and not of any one font.
//
// Priced by the bench, as the recipient sees it (mean SSIM, worst font):
// current 0.563, art-calibrated 0.678, fully calibrated 0.789. For scale,
// braille at the same character count scores 0.341, so an uncalibrated ramp
// gives away most of the margin that made ramp the default.
//
// Two ramps ship, as styles (spec 5.1: a style is a codec, a charset and tone
// settings). They are the two ends of a real trade, not a good one and a bad
// one:
//
//   ART       calibrated within the traditional ASCII-art alphabet. Still reads
//             as text art in a plain text viewer, which is the property the
//             product is built on. 2.3% evenness error.
//   FIDELITY  calibrated across the whole safe alphabet. Best picture on every
//             font tested, 1.0% evenness error, and it renders as a page of
//             random letters and digits. Better photograph, weaker artefact.
//
// Both were calibrated against DejaVu Sans Mono. A ramp calibrated for one font
// scores ~0.79 on fonts it has never seen, which is why a static default is
// worth having at all and why runtime calibration is an improvement rather than
// a prerequisite. Test D section 5 measures the real coverage on device.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Replaced 2026-08-09. Both ramps are now designed on a real device.
//
// Test D section 5 measured the old ramps on a Pixel and found Art itself
// non-monotonic: inversions at ']' -> '{' and '%' -> '$', worst error 11.8%,
// and only 7 usable tone levels of 11 once glyph pairs closer than 0.05 in
// coverage are merged. Art had been selected over Conventional *precisely
// because* it was monotonic, measured on DejaVu, Liberation and Latin Modern:
// three Linux fonts, none of which any phone uses. The replacement inherited
// the exact defect it was chosen to fix.
//
// Standing rule this cost us: a calibration is only valid in the font it was
// measured in, and the build machine is never that font. Both strings below
// were selected by Test D section 6, which rasterises every candidate glyph in
// the font the device resolves `monospace` to and picks eleven by dynamic
// programming against an even 0-1 coverage ladder.
//
//   art pool    U+00A0 - ; + ( [ ] $ # % @      punctuation only
//   any pool    U+00A0 - ; + ( [ a K % B @      letters and digits allowed
//                             ^ ^ ^ ^
//
// They agree on 7 of 11 slots (the whole light end plus the terminal '@') and
// diverge only at slots 6-9, coverage ~0.6-0.9, where dense punctuation runs
// out and only letterforms are left. So the art-versus-fidelity trade is four
// glyphs, not a charset. Both are monotonic by construction: the selector walks
// the pool in coverage order, so an inversion is not reachable.
//
// Still a bet: these are calibrated on one Pixel. On SF Mono, still unmeasured,
// they carry the same inversion risk the old strings carried on Roboto Mono.
// This is why CALIBRATION_DEFAULT below is 'auto' and not 'off'.
export const RAMP_ART = RAMP_BLANK + '-;+([]$#%@';
export const RAMP_FIDELITY = RAMP_BLANK + '-;+([aK%B@';

// Superseded, kept so the bench can keep pricing them and so the regression is
// visible rather than deleted. The DejaVu-calibrated strings that measured
// non-monotonic on a real phone.
export const RAMP_ART_LINUX = RAMP_BLANK + '.:!+]{%$O@';
export const RAMP_FIDELITY_LINUX = RAMP_BLANK + '.:!/vn5URM';

// The old ramp. Kept so the bench can keep pricing it, and so the next person
// to propose " .:-=+ox#%@" because it looks right has a number to look at.
// Measured on the same Pixel: three inversions, 21.4% worst error.
export const RAMP_CONVENTIONAL = RAMP_BLANK + '.:-=+ox#%@';

export const DEFAULT_RAMP = RAMP_ART;

// ---------------------------------------------------------------------------
// Runtime coverage calibration: 'auto', decided 2026-08-09.
//
// 'auto' means on wherever a 2d canvas exists, not an opt-in toggle buried in
// settings. The distinction matters: the defaults above are correct on one
// measured font, and an unmeasured font with calibration switched off is the
// configuration that shipped a non-monotonic default ramp in the first place.
// Test D section 5 proved the canvas measurement works on both tested
// platforms; it costs one pass at capture.
//
//   'auto'  measure on device if canvas is available, else use the strings
//   'off'   always use the shipped strings
//   'force' fail loudly if the device cannot be measured (testing only)
// ---------------------------------------------------------------------------
export const CALIBRATION_DEFAULT = 'auto';

// Blank braille. Never U+0020, for the same reason.
export const BRAILLE_BASE = 0x2800;
export const BRAILLE_BLANK = '⠀';

// Dithering is auto-disabled below this width, where added noise costs more
// than the banding it removes (spec 5.7).
export const DITHER_MIN_COLS = 24;

// ---------------------------------------------------------------------------
// Tone defaults, per codec. Added 2026-08-08 after measuring against the
// VectorCamera reference.
//
// The original single default (auto-levels 2/98 plus gamma 1.2) was reasoned
// for the ramp codec, where the goal is to spread the histogram across all 11
// glyph levels. Applied to a 1-bit codec it is actively harmful: dot density
// carries tone, so pushing values toward the extremes produces flat black and
// flat white regions with no dot texture, which is where the information goes.
// Measured ink coverage fell to 32%, a third of the frame carrying nothing.
//
// For cell codecs the tone curve should gently compress contrast instead.
// Target ink coverage is roughly 40-45%.
// ---------------------------------------------------------------------------
// Ramp, 2026-08-08: measured, and it reverses "the ramp codec should not
// compress". 180 tone variants through the bench harness on two photographs, a
// portrait and a detail-heavy truck, scored at equal displayed size.
//
// The old curve (2/98, gamma 1.2, compress 1.0) was reasoned rather than
// measured, and the measurement says it was tuned, by accident, for the
// portrait: SSIM 0.832 on the face against 0.755 on the truck. Moving to 4/96
// with a mild 0.92 compression costs 0.7% of SSIM and buys:
//
//   end-glyph clipping   21.8% -> 11.8%   cells carrying no gradient at all
//   subject spread       0.077 -> 0.008   90% less dependent on the subject
//
// The original reasoning was not wrong about the mechanism: a ramp does have
// levels to fill, and compression does fill fewer of them. It never checked the
// price, a fifth of the frame pinned to a blank or an '@'. That is the ramp's
// version of the "a third of the frame carrying nothing" failure the
// ink-coverage band was invented to catch on braille, and it went unnoticed
// because the metric applied to ramp was measuring the wrong quantity.
//
// unsharp stays at 0.6 and was not swept: fidelity metrics punish sharpening
// halos, so a bench would drive it to zero. That one is a device judgement.
//
// A default has to work on a photo nobody has taken yet, which is why spread
// outranked the small SSIM win here.
export const TONE = {
  [CODEC.BRAILLE]:  { unsharp: 0.4, clipLo: 4, clipHi: 96, gamma: 1.0, compress: 0.82 },
  [CODEC.QUADRANT]: { unsharp: 0.4, clipLo: 4, clipHi: 96, gamma: 1.0, compress: 0.86 },
  [CODEC.RAMP]:     { unsharp: 0.6, clipLo: 4, clipHi: 96, gamma: 1.2, compress: 0.92 },
};

// ---------------------------------------------------------------------------
// Ramp health band, replacing INK_TARGET applied to a ramp.
//
// inkCoverage() returns the fraction of dots inked for a cell codec and the
// mean glyph index for a ramp. Those are different quantities, and the 30-60%
// band was derived for the first one. Two ordinary photographs landed at 30.7%
// and 59.1%, opposite edges of a band that never meant anything for this codec,
// one shrug away from warning on perfectly good input.
//
// The ramp's real failure is not using the levels it has. So:
//   clipped   share of cells pinned to the first or last glyph. Those carry no
//             gradient. Above 20% the picture is going flat at the ends.
//   entropy   normalised level occupancy. Below 0.75 the ramp is effectively
//             shorter than it claims to be.
// Both warn, neither clamps, same rule as ink coverage. A snow scene and a
// night shot legitimately sit outside.
// ---------------------------------------------------------------------------
export const RAMP_CLIP_MAX = 0.20;
export const RAMP_ENTROPY_MIN = 0.75;

// Ink coverage sanity band for a 1-bit halftone.
//
// Applied to the polarity-normalised coverage, so the same band works in both
// light and dark mode. Flipping polarity turns coverage x into 1-x exactly,
// which would otherwise make the band meaningless in dark mode.
//
// A loose band to catch gross crushing, not a tuning target. The old defaults
// produced 32% on real photos, meaning a third of the frame was flat white and
// carrying nothing; the current defaults land near 42%. Legitimate images sit
// outside it in both directions (a snow scene runs bright, a night shot runs
// dark), so this warns, it never clamps.
export const INK_TARGET = [0.30, 0.60];

// Dither kernels.
//   'ordered'  Bayer 8x8. Default for cell codecs. At 108 columns a braille
//              dot is ~5.4 device pixels on a DPR-3 phone, so the pattern is
//              fully resolved; a periodic screen reads as halftone texture
//              where error diffusion reads as grain.
//   'fs'       Floyd-Steinberg. Better when dots really are sub-pixel, i.e.
//              at high column counts or on a low-DPR screen.
export const DITHER_DEFAULT = 'ordered';

// ---------------------------------------------------------------------------
// Polarity. Dark is the default, decided 2026-08-08.
//
// Two reasons, and the second is the one that matters technically:
//   1. It is what the app should look like.
//   2. Small light features on a dark ground bloom; displays and eyes both
//      over-report them. A sub-pixel white dot on black stays visible where a
//      sub-pixel black dot on white antialiases into pale grey. Dark polarity
//      therefore raises the effective legibility floor rather than lowering it.
//
// Polarity is an encoder concern, not a stylesheet one. The dot is the
// foreground colour, so on a dark ground a dot must mark a bright source pixel.
// Flipping only the CSS produces a photographic negative, which is what the old
// `invert` option did, silently, because nothing exercised it.
// ---------------------------------------------------------------------------
export const INVERT_DEFAULT = true;

// Light mode is deferred to a later release. The encoder handles both
// polarities correctly (encode.js flips before quantisation) and the wrapper
// emits either, but only dark is exercised and the tone curve has been tuned
// against dark only. Do not ship light without re-tuning: light features on a
// dark ground bloom, so the two polarities do not want the same ink coverage
// for equal perceived weight.

// Synthetic bolding, in em, applied via -webkit-text-stroke.
//
// As a dot approaches one device pixel, antialiasing spreads its ink across
// neighbours: total ink is conserved but peak contrast is not, and the dot
// reads as grey rather than solid. Stroking the glyph outline thickens the dot
// and restores solidity. Zero character cost in the payload; ~40 in the CSS.
//
// Scales with font-size because it is specified in em.
//
// Confirmed in band 2026-08-09, and the round-5 answer added a constraint the
// spec had never stated: stroke 0 must be legible.
//
// Bolding lives in the CSS wrapper and the message is required to read as a
// plain text file, so stroke helps only the recipient who opens the .html, and
// braille's real legibility floor is its unstroked floor. Stroke can improve
// the wrapped rendering; it can never be relied on to carry tone.
// STROKE_EM_MAX is where adjacent dots start to merge, which destroys the
// sub-cell resolution braille exists for.
//
// It stays a braille concern: a ramp glyph is not a sub-pixel dot. With ramp as
// the default codec this setting applies to a non-default path.
export const TEXT_STROKE_EM = 0.07;
export const STROKE_EM_MAX = 0.10; // measured: dots merge above this

// Synthetic bolding is braille-only. This was a latent bug found while
// switching the default codec to ramp: wrap() applied TEXT_STROKE_EM to every
// codec, so making ramp the default would have silently started stroking
// letterforms.
//
// The mechanism only argues for braille. A braille dot is an isolated mark
// approaching one device pixel, and thickening its outline restores contrast
// the antialiasing took. Neither of the others is that:
//   quadrant  block glyphs already tile edge to edge, so a stroke expands each
//             block past its own cell and bleeds into its neighbours. It
//             destroys the quadrant boundaries rather than sharpening them
//   ramp      a glyph at a 5px advance is a legible letterform, not a
//             sub-pixel dot. Stroking it fills in counters and makes the whole
//             ramp read darker and muddier, which also invalidates the
//             coverage-sorted ordering the ramp depends on
//
// Same shape of bug as the old `invert` option, which swapped the CSS colours
// while the encoder ignored polarity: a setting only ever exercised on the one
// path it happened to be correct for.
export const STROKE_EM = {
  [CODEC.BRAILLE]: TEXT_STROKE_EM,
  [CODEC.QUADRANT]: 0,
  [CODEC.RAMP]: 0,
};
