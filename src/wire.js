// Plane Text: the wire format (spec 4.1, 4.2).
//
// Serialise and parse only. There is no decoder in the message and there is no
// UI in here: the paste screen (spec 5.5), the canvas render and the error
// states (spec 8) are the app's problem and import this.
//
// ---------------------------------------------------------------------------
// The header is an optimisation and a disambiguator. It is never a dependency.
//
// Decided 2026-08-09, closing the four-option table the spec had carried since
// 2026-08-08 (header in an HTML comment / one text line / no header at all /
// Base64 the header). Two of them combine and the other two lose:
//
//   inferred from the rows   width  = row length
//                            height = row count
//                            codec  = the code-point range of the glyphs
//   carried on one line      version, codec, polarity, ramp
//
// The load-bearing case is a recipient who copies text out of the rendered
// page. They get the art rows and nothing else: no header, no wrapper, no
// magic. That is the format working as designed, not a corruption, because the
// whole reason the wire format is one row per line is that the message is
// readable as art in a plain text viewer (spec 4.4). So this parser is written
// so that the rows alone are sufficient, and the header only refines what the
// rows already say. Where the two disagree THE ROWS WIN and a warning is
// returned. Nothing in here throws on a malformed header, an unknown key, a
// missing header or a geometry mismatch; a parser that throws would make the
// header load-bearing by the back door.
//
// The binary header the spec used to specify (magic 4 / version 1 / codec 1 /
// w 2 / h 2 / flags 1 / rampLen 1 / ramp var / partIndex 1 / partTotal 1 /
// reserved 3) is deleted, not ported. It was designed for a Base64 payload; in
// front of plain braille it renders as garbage on row 1 and destroys the
// readable-as-text property that is the point of the Compatible wrapper.
//
// Dropped with it, and not replaced:
//   gzipped flag   spec 9 removes gzip from v1, and spec 4.3 records why it can
//                  never come back on this tier: compressing the grid turns the
//                  art into noise. A flag for a configuration that cannot exist.
//   part index     unreachable. A full-size message is a few thousand
//   part total     characters against a 65,536 ceiling (spec 2.2), so there is
//                  no second part to index.
//   reserved bytes  a key=value text header extends by adding a key. Reserving
//                  space in a format that has no fixed-width fields is a
//                  category error inherited from the binary layout.
//
// Version stays an explicit field rather than being folded into the magic. The
// magic answers "is this ours" for a clipboard scan (spec 5.5) and wants to be
// one stable string to grep for; the version answers "can we read it" and wants
// to move. Folding them makes every version bump invisible to the detector,
// which would report a v2 message as "not a Plane Text image" instead of "sent
// from a newer version" (spec 8).
// ---------------------------------------------------------------------------

import {
  MAGIC, WIRE_VERSION, CODEC, CODEC_NAME, CODEC_BY_NAME,
  DEFAULT_RAMP, INVERT_DEFAULT, BRAILLE_BASE,
} from './constants.js';
import { QUADRANT_CHARS } from './cells.js';
import { lintPayload, assertClean } from './lint.js';

// ---------------------------------------------------------------------------
// The grammar.
//
//   message := header LF wrapper
//   header  := "PLANETEXT1" ( SP field )*
//   field   := key "=" value
//   key     := one lowercase letter
//   value   := one or more characters, none of them U+0020
//
// e.g.  PLANETEXT1 v=1 c=ramp i=1 w=65 h=87 r=<0xA0>-;+([]$#%@
//       PLANETEXT1 v=1 c=braille i=1 w=108 h=41
//
// Three rules that are not arbitrary:
//
// 1. The separator is U+0020 and the split is on U+0020, never on \s. In
//    JavaScript \s MATCHES U+00A0, and U+00A0 is the first glyph of every ramp
//    we ship (constants.js, RAMP_BLANK). A /\s+/ split would silently eat the
//    lightest glyph out of every ramp header. This is the single sharpest edge
//    in the file.
// 2. A value is split on the FIRST '=' only. '=' is a legal ramp glyph and is
//    in RAMP_CONVENTIONAL, so a greedy or symmetric split corrupts it.
// 3. Fields are order-independent on parse and emitted in a fixed order, with
//    the ramp last because it is the only variable-length value.
// ---------------------------------------------------------------------------

// Key names. Single letters, and the argument for them is not byte count -- at
// ~40 characters against a 65,536 ceiling the header is free either way. It is
// that the header is one line of a document whose whole selling point is that
// it reads as a picture, so it should occupy one short line rather than
// competing with the art for the reader's eye. `verbose=false` is not a virtue
// here; a short line that a human can still decode at a glance is.
//
//   v  version   the format version, not the app version
//   c  codec     a NAME, not the numeric codec id. The number is what the code
//                passes around, but a human reading the raw message learns
//                nothing from `c=3`. The parser accepts either, so a sender
//                that emits the digit still decodes.
//   i  invert    polarity. Named for the option it sets everywhere else in the
//                codebase (INVERT_DEFAULT, encode's `invert`), because a header
//                key that renames a field is a bug waiting to happen -- the old
//                `invert` bug (constants.js) was exactly a setting that meant
//                two different things in two places.
//   w  width     columns, i.e. CELLS not dots or pixels. Same unit as the old
//   h  height    rows.       binary header, and derived per codec via CELL_DOTS.
//   r  ramp      the glyphs, coverage-sorted lightest-first by the sender.
//
// `w`/`h` are emitted even though they are inferable, purely for
// self-description: a header that says nothing about geometry is a header a
// human cannot sanity-check. They are advisory. See parseMessage().
export const HEADER_KEY = {
  version: 'v',
  codec: 'c',
  invert: 'i',
  cols: 'w',
  rows: 'h',
  ramp: 'r',
};

const KEY_TO_FIELD = Object.fromEntries(
  Object.entries(HEADER_KEY).map(([field, key]) => [key, field]),
);

// The braille and Block Elements ranges, used for codec inference. Quadrant is
// the whole Block Elements block rather than just the sixteen glyphs we emit,
// so a message from a future charset revision still infers as quadrant.
const BRAILLE_RANGE = [0x2800, 0x28ff];
const BLOCK_RANGE = [0x2580, 0x259f];

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

export function emitHeader({ codec, cols, rows, invert = INVERT_DEFAULT, ramp = null }) {
  const name = CODEC_NAME[codec];
  if (!name) throw new Error(`unknown codec ${codec}`);

  const fields = [
    HEADER_KEY.version + '=' + WIRE_VERSION,
    HEADER_KEY.codec + '=' + name,
    HEADER_KEY.invert + '=' + (invert ? 1 : 0),
    HEADER_KEY.cols + '=' + cols,
    HEADER_KEY.rows + '=' + rows,
  ];

  const glyphs = codec === CODEC.RAMP ? (ramp ?? DEFAULT_RAMP) : null;
  if (glyphs !== null) fields.push(HEADER_KEY.ramp + '=' + glyphs);

  const line = MAGIC + ' ' + fields.join(' ');

  // The payload rule, not the wrapper rule, and deliberately the stricter of
  // the two: the header carries no markup, so there is no reason to allow
  // < > & through it, and a ramp glyph of '<' would break the <pre> the ramp is
  // about to be rendered in anyway.
  //
  // This is also the only place a bad ramp is guaranteed to be caught. Linting
  // the rows catches a banned glyph only if the image happens to use it; a
  // ramp whose '*' sits at a tone level this particular photograph never
  // reaches would ship clean. Here it is checked whether or not it is used.
  //
  // It runs BEFORE the two separator checks below, deliberately. Hand-typed
  // ramps trip both rules at once -- the obvious ramp opens with U+0020 (spec 3
  // flagged that tension) and the obvious dark end reaches for '*' -- and when
  // both fire the banned-character diagnostic is the actionable one. "That
  // character is the field separator" is true and tells the user nothing.
  assertClean(lintPayload(line));

  // The separator and the line break are the two characters a ramp cannot
  // contain without splitting its own header. styles.js already refuses U+0020
  // in a user ramp for an unrelated reason -- WhatsApp trims leading whitespace
  // and the row shears -- so this is a second, independent argument for the same
  // rule, and it is checked here rather than assumed to have happened upstream.
  if (glyphs !== null) {
    if (glyphs.includes(' ')) {
      throw new Error('ramp contains U+0020, which is the header field separator');
    }
    if (/[\r\n]/.test(glyphs)) {
      throw new Error('ramp contains a line break, and the header is one line');
    }
  }
  return line;
}

// ---------------------------------------------------------------------------
// Parse. Nothing below this line throws on bad input.
// ---------------------------------------------------------------------------

// One line -> whatever of it made sense. Fields that are absent, unparseable or
// unknown come back null / collected, with a warning each. `magic:false` means
// this was not a header at all, which is not an error either: the caller is
// expected to carry on with the rows.
export function parseHeader(line) {
  const warnings = [];
  const header = {
    magic: false,
    version: null,
    codec: null,
    invert: null,
    cols: null,
    rows: null,
    ramp: null,
    unknown: {},
    warnings,
  };
  if (typeof line !== 'string' || !line.length) return header;

  // Split on U+0020 only. See rule 1 in the grammar note above.
  const tokens = line.split(' ').filter((t) => t.length);
  if (!tokens.length || tokens[0] !== MAGIC) return header;
  header.magic = true;

  for (const token of tokens.slice(1)) {
    const at = token.indexOf('=');
    if (at < 1) {
      warnings.push(`header token ${JSON.stringify(token)} is not key=value, ignored`);
      continue;
    }
    const key = token.slice(0, at);
    const value = token.slice(at + 1); // first '=' only. See rule 2.
    const field = KEY_TO_FIELD[key];

    if (!field) {
      // An unknown key is how this format grows. Keep the value so a caller
      // can look at it, warn so it is not silent, and never fail: a v1 reader
      // refusing a v2 field is precisely the forward compatibility the deleted
      // `reserved` bytes were supposed to buy.
      header.unknown[key] = value;
      warnings.push(`unknown header key ${JSON.stringify(key)}, ignored`);
      continue;
    }

    if (field === 'version') {
      const v = intOrNull(value);
      if (v === null) warnings.push(`unreadable version ${JSON.stringify(value)}, ignored`);
      else if (v > WIRE_VERSION) {
        // Spec 8 has a user-facing string for this. Still not an error here:
        // the rows are very likely still readable, and refusing to look at
        // them would be worse than trying.
        header.version = v;
        warnings.push(`message is wire version ${v}, this build knows ${WIRE_VERSION}`);
      } else header.version = v;
    } else if (field === 'codec') {
      const c = codecFromValue(value);
      if (c === null) warnings.push(`unknown codec ${JSON.stringify(value)}, inferring from the rows`);
      else header.codec = c;
    } else if (field === 'invert') {
      const b = boolOrNull(value);
      if (b === null) warnings.push(`unreadable polarity ${JSON.stringify(value)}, ignored`);
      else header.invert = b;
    } else if (field === 'cols' || field === 'rows') {
      const n = intOrNull(value);
      if (n === null || n <= 0) warnings.push(`unreadable ${field} ${JSON.stringify(value)}, ignored`);
      else header[field] = n;
    } else if (field === 'ramp') {
      // Two glyphs is the floor: a one-level ramp has no tone at all, and
      // styles.js refuses it at the editor.
      if ([...value].length < 2) warnings.push(`ramp ${JSON.stringify(value)} has fewer than two glyphs, ignored`);
      else header.ramp = value;
    }
  }
  return header;
}

// Codec from the rows themselves, which is the property that makes the header
// optional. Braille and Block Elements each occupy a private Unicode range, so
// a single scan settles it; anything else is a ramp, because a ramp is by
// construction Latin plus U+00A0 (constants.js) and therefore the residual
// case rather than a positively identified one.
//
// Returns null only when the rows are empty or mix two cell blocks. Mixed is
// not "probably braille": it is a corrupted or hand-edited message, and the
// caller should say so rather than guess.
export function inferCodec(lines) {
  let braille = 0;
  let block = 0;
  let other = 0;
  for (const line of lines) {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (cp >= BRAILLE_RANGE[0] && cp <= BRAILLE_RANGE[1]) braille++;
      else if (cp >= BLOCK_RANGE[0] && cp <= BLOCK_RANGE[1]) block++;
      else other++;
    }
  }
  if (!braille && !block && !other) return null;
  if (braille && !block && !other) return CODEC.BRAILLE;
  if (block && !braille && !other) return CODEC.QUADRANT;
  if (!braille && !block) return CODEC.RAMP;
  return null; // two cell charsets in one grid; nothing honest to return
}

// Pull the art rows out of whatever arrived. Three shapes, in the order they
// are worth trying:
//
//   1. a whole message or a saved .html   -> the contents of the <pre>
//   2. the art rows with the header still attached
//   3. the art rows alone, copied out of a rendered page
//
// Case 3 is the one the format exists to survive, and it is the reason this
// does not require a wrapper, a magic string or an <html> element.
export function extractRows(text) {
  if (typeof text !== 'string' || !text.length) return [];

  const open = text.indexOf('<pre');
  if (open !== -1) {
    const gt = text.indexOf('>', open);
    const close = text.indexOf('</pre>', gt);
    if (gt !== -1 && close !== -1) return text.slice(gt + 1, close).split('\n');
  }

  // No wrapper. Every non-empty line is a row. A blank braille or ramp row is
  // not an empty line -- it is a row of U+2800 or U+00A0 -- so dropping empty
  // lines cannot delete a row of the picture, only the padding a mail client
  // added around it.
  return text.split('\n').filter((l) => l.length > 0);
}

// Split a leading header line off the front. Returns header:null when there
// isn't one, which is the copied-out-of-the-page case and is not a failure.
export function splitHeader(text) {
  if (typeof text !== 'string') return { header: null, body: '' };
  const at = text.indexOf('\n');
  const first = at === -1 ? text : text.slice(0, at);
  if (!first.startsWith(MAGIC)) return { header: null, body: text };
  return {
    header: parseHeader(first),
    body: at === -1 ? '' : text.slice(at + 1),
  };
}

// Rows -> grid. The exact inverse of cells.js gridToRows, and deliberately a
// second implementation of it rather than a call to cells.js rowsToGrid.
//
// rowsToGrid is the strict inverse: it throws on a ragged grid or an unmappable
// glyph, which is what a test wants, because in the encoder those conditions
// are bugs. Here they are Tuesday. This input has been through a clipboard, a
// messaging app and possibly a text editor, so it is padded, trimmed,
// smart-quoted and truncated, and the recipient is better served by a picture
// with a corrupt corner plus a warning than by an exception.
export function decodeRows(lines, { codec, ramp = DEFAULT_RAMP } = {}) {
  const warnings = [];
  const grid = { codec, cols: 0, rows: lines.length, values: new Uint8Array(0), ramp };
  if (!lines.length) return { grid, warnings };

  const widths = lines.map((l) => [...l].length);
  const cols = Math.max(...widths);
  const ragged = widths.some((w) => w !== cols);
  if (ragged) {
    // Right-trimming is explicitly allowed (spec 4.4 rule 3), so short rows are
    // expected from any transport that trims, and padding them back out is the
    // correct repair rather than a guess.
    warnings.push(
      `rows are not all the same length (${Math.min(...widths)}-${cols} cells); ` +
        `short rows padded to ${cols}`,
    );
  }

  // A ramp we were not given cannot be recovered from the glyphs -- coverage
  // order is a measurement, not a property of the characters. What CAN be
  // preserved is the text: appending the unseen glyphs to the ramp keeps every
  // known index correct and makes gridToRows(decodeRows(x)) reproduce x exactly.
  // Tone ordering is wrong for the appended glyphs and that is warned about.
  // The alternative, mapping them all to zero, throws away the picture in order
  // to protect an ordering that was already lost.
  let rampGlyphs = codec === CODEC.RAMP ? [...ramp] : null;
  let appended = 0;

  const values = new Uint8Array(cols * lines.length);
  let unmappable = 0;
  let firstBad = null;

  for (let y = 0; y < lines.length; y++) {
    const chars = [...lines[y]];
    for (let x = 0; x < chars.length && x < cols; x++) {
      const ch = chars[x];
      let v = -1;
      if (codec === CODEC.BRAILLE) {
        const cp = ch.codePointAt(0) - BRAILLE_BASE;
        if (cp >= 0 && cp <= 255) v = cp;
      } else if (codec === CODEC.QUADRANT) {
        v = QUADRANT_CHARS.indexOf(ch);
      } else {
        v = rampGlyphs.indexOf(ch);
        if (v === -1) {
          rampGlyphs.push(ch);
          v = rampGlyphs.length - 1;
          appended++;
        }
      }
      if (v < 0) {
        unmappable++;
        if (firstBad === null) firstBad = { ch, x, y };
        v = 0;
      }
      values[y * cols + x] = v;
    }
  }

  if (unmappable) {
    warnings.push(
      `${unmappable} character(s) are not in this codec's charset, first ` +
        `U+${firstBad.ch.codePointAt(0).toString(16).toUpperCase()} at ${firstBad.x},${firstBad.y}; ` +
        `treated as blank`,
    );
  }
  if (appended) {
    warnings.push(
      `${appended} glyph(s) in the rows are outside the ramp we have, so the ramp ` +
        `carried no coverage order for them; the text round-trips but their tone is a guess`,
    );
  }

  grid.cols = cols;
  grid.values = values;
  if (rampGlyphs) grid.ramp = rampGlyphs.join('');
  return { grid, warnings };
}

// The whole job: text in, grid out, warnings for everything that had to be
// assumed. Never throws.
//
// Precedence, stated once because it is the design:
//   geometry  ALWAYS the rows. The header's w/h are compared and warned about.
//   codec     the rows when they identify one; the header only when they
//             cannot (empty input, or two cell charsets mixed together).
//   polarity  the header only. Not inferable -- a photograph and its negative
//             are the same characters. Falls back to INVERT_DEFAULT, warned.
//   ramp      the header only, for the same reason: coverage order is a
//             measurement. Falls back to DEFAULT_RAMP, warned if it did not fit.
export function parseMessage(text) {
  const warnings = [];
  const { header, body } = splitHeader(text);
  const lines = extractRows(body);

  if (!header) {
    warnings.push('no header line; everything not inferable from the rows is a default');
  } else {
    warnings.push(...header.warnings);
  }

  const inferred = inferCodec(lines);
  let codec = inferred;
  if (inferred === null) {
    codec = header?.codec ?? null;
    if (lines.length) {
      warnings.push('the rows mix two cell charsets, so the codec could not be inferred');
    }
  } else if (header?.codec != null && header.codec !== inferred) {
    warnings.push(
      `header says codec ${CODEC_NAME[header.codec] ?? header.codec} but the rows are ` +
        `${CODEC_NAME[inferred]}; the rows win`,
    );
  }

  const invert = header?.invert ?? INVERT_DEFAULT;
  if (header?.invert == null) {
    warnings.push(`polarity is not carried in the rows; assuming invert=${INVERT_DEFAULT}`);
  }

  let ramp = DEFAULT_RAMP;
  if (codec === CODEC.RAMP) {
    if (header?.ramp) ramp = header.ramp;
    else warnings.push('no ramp carried; assuming the default ramp, so tone may be wrong');
  }

  let grid = null;
  if (codec !== null && lines.length) {
    const decoded = decodeRows(lines, { codec, ramp });
    grid = decoded.grid;
    warnings.push(...decoded.warnings);

    // The self-description check. The header is allowed to be wrong about
    // geometry -- a sender that right-trims, a client that wraps a long line --
    // and being wrong about it must not cost the recipient the picture.
    if (header?.cols != null && header.cols !== grid.cols) {
      warnings.push(`header says w=${header.cols} but the rows are ${grid.cols} wide; the rows win`);
    }
    if (header?.rows != null && header.rows !== grid.rows) {
      warnings.push(`header says h=${header.rows} but there are ${grid.rows} rows; the rows win`);
    }
  } else if (!lines.length) {
    warnings.push('no art rows found');
  }

  return {
    magic: header?.magic ?? false,
    version: header?.version ?? null,
    header,
    lines,
    codec,
    invert,
    ramp: grid ? grid.ramp : ramp,
    grid,
    warnings,
  };
}

// ---------------------------------------------------------------------------

function intOrNull(value) {
  if (!/^[0-9]+$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(value) {
  if (value === '1' || value === 'true' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'no') return false;
  return null;
}

// Names on the wire, numbers in the code, and both accepted on the way in. The
// spec's own worked example was `c=1`, so a digit has to keep parsing even
// though nothing emits one any more.
function codecFromValue(value) {
  if (CODEC_BY_NAME[value] != null) return CODEC_BY_NAME[value];
  const n = intOrNull(value);
  if (n !== null && CODEC_NAME[n]) return n;
  return null;
}
