// Plane Text: the capture word, and the name it becomes.
//
// The shutter announces the word it is about to make: `[ KACHUNK ]` before you
// press, not after. That reading is what removes the objection to putting a
// word on a button. `CLACK` does not read as an instruction to clack, it reads
// as a promise about the noise, so the button is telling you what will happen
// rather than mislabelling itself.
//
// The word also names the message. `kachunk 20260809 1432` labels the recents
// strip, and it is the basis of the wrapper <title>, so it becomes the filename
// the recipient gets when they save the page.
//
// TWO NAMES, TWO READERS. Added 2026-08-13. messageName() and fileName() used to
// agree, and this header claimed one name served both the title and the file. It
// does not: the two are read by different people in different places.
//
//   in the app   `zap 20260809 1432`   word first. At 46px the art is texture
//                                      and the word is the only thing that
//                                      identifies an entry, and it is the token
//                                      people say out loud. Date first would put
//                                      `2026` under every thumbnail.
//   on disk      `planetext_20260809-1432_zap.txt`
//                                      date first. A folder of these sorts
//                                      chronologically, which is the only
//                                      ordering anyone wants for photographs.
//                                      The prefix says what the file is -- a
//                                      .txt full of braille is otherwise
//                                      unidentifiable in a Downloads folder --
//                                      and echoes the wire magic PLANETEXT1.
//
// Three consequences of the word naming the message:
//
//   1. The list is a payload surface. These words go into the message, so they
//      go through lintPayload() like everything else: no * _ ~ ` < > &. The
//      eight below are A-Z only. A user-editable word list would need linting
//      at edit time, the same way a custom charset does.
//   2. The list is public. A word appears in someone else's chat and someone
//      else's filesystem, permanently, next to a photograph the author did not
//      choose. MAYDAY was cut for this: it is a distress call and the app's
//      premise is that you are on an aircraft.
//   3. The words must be short. The hero slot is ~174px at a 390px viewport,
//      set in monospace at 0.2em tracking. Eight characters fits; twelve does
//      not, and the label would ellipsis mid-word.
//
// The rotation is sequential rather than random. Random repeats, and a repeat
// inside one session makes the name look like it is not a name.

export const WORDS = [
  'KACHUNK',
  'ZAP',
  'CLACK',
  'PEW',
  'SNAP',
  'THWIP',
  'BLIP',
  'WHUMP',
];

// Longest word, so a layout check can confirm the hero slot fits it.
export const LONGEST_WORD = WORDS.reduce((a, b) => (b.length > a.length ? b : a));

export function wordAt(index) {
  return WORDS[((index % WORDS.length) + WORDS.length) % WORDS.length];
}

// Which word the shutter is currently promising. Kept out of the store because
// nothing reads it as state: it is a cursor, and it exists so the sequence does
// not restart at KACHUNK on every launch.
const CURSOR_KEY = 'planetext.word.v1';

export function currentWord() {
  return wordAt(readCursor());
}

export function advanceWord() {
  const next = readCursor() + 1;
  try { localStorage.setItem(CURSOR_KEY, String(next)); } catch { /* opaque origin */ }
  return wordAt(next);
}

function readCursor() {
  try {
    const n = Number(localStorage.getItem(CURSOR_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// `kachunk 20260809 1432`.
//
// Space-separated rather than hyphenated because this lands in a <title>, and a
// title is prose. Browsers turn it into a filename on save and handle the
// spaces. A hyphenated slug would look like a machine identifier in the one
// place a human reads it.
//
// Local time, not UTC: the name is a memory aid for the person who took the
// photo, and 1432 should be the time they remember. The cost, recorded so it is
// not rediscovered later, is that this puts capture time into a message that
// previously carried no metadata. Date alone would leak less and collide
// sooner; time was chosen 2026-08-09 because "which of these two" is the
// question the name has to answer.
//
// Word first, and it stays word first. fileName() below reverses the order and
// that is not drift -- see the two-names note at the top of this file.
export function messageName(word, at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
  const time = `${p(at.getHours())}${p(at.getMinutes())}`;
  return `${String(word).toLowerCase()} ${date} ${time}`;
}

// `planetext_20260809-1432_zap.txt`.
//
// Takes a messageName() string and turns it inside out: format prefix, then the
// date and time joined by a hyphen so the stamp is one token, then the word.
// Underscores and hyphens only, never spaces -- the old output had them, which
// survives on macOS and is friction everywhere else.
//
// The word survives the reordering because it is the spoken handle, and because
// it disambiguates two captures inside the same minute. The rotation guarantees
// consecutive captures differ.
//
// A NAME THAT IS NOT ONE OF OURS still has to produce a file. A received
// message carries whatever name the sender's app gave it, and after a custom
// word list (spec 5.1, charset editor) even our own names carry user-supplied
// text. So the parse is a fast path, not a precondition: anything that does not
// match falls through to the same sanitiser the old implementation used, with
// spaces folded to underscores rather than kept. This function stays the one
// place that guarantees a filesystem-safe result.
const NAME_RE = /^([a-z0-9]+)\s+(\d{8})\s+(\d{4})$/i;

export function fileName(name, ext) {
  const raw = String(name).trim();
  const m = NAME_RE.exec(raw);
  if (m) {
    const [, word, date, time] = m;
    return `planetext_${date}-${time}_${word.toLowerCase()}.${ext}`;
  }
  const safe = raw
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'untitled';
  return `planetext_${safe}.${ext}`;
}

// The <title> the wrapper carries -- and therefore the filename the RECIPIENT
// gets when their browser saves the page -- is NOT built here. It is
// `Plane Text — zap 20260809 1432`, prose rather than a slug, and src/wrap.js
// applies the prefix because src/ is below app/ in the import graph and because
// the wrapper's own character budget has to measure the string it actually
// emits. See titleFor() there. messageName() feeds it unchanged.
