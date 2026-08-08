// Plane Text: the capture word, and the name it becomes.
//
// The shutter announces the word it is about to make: `[ KACHUNK ]` before you
// press, not after. That reading is what removes the objection to putting a
// word on a button. `CLACK` does not read as an instruction to clack, it reads
// as a promise about the noise, so the button is telling you what will happen
// rather than mislabelling itself.
//
// The word also names the message. `kachunk 20260809 1432` labels the recents
// strip, and it is the wrapper <title>, so it becomes the filename the
// recipient gets when they save the page.
//
// Three consequences of that:
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
export function messageName(word, at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
  const time = `${p(at.getHours())}${p(at.getMinutes())}`;
  return `${String(word).toLowerCase()} ${date} ${time}`;
}

// A filename for a saved export. The name is already filesystem-safe by
// construction (lowercase letters, digits, spaces), but a custom word list
// would not be, so this is the one place that guarantees it.
export function fileName(name, ext) {
  const safe = String(name).replace(/[^a-z0-9 ]/gi, '').trim() || 'plane text';
  return `${safe}.${ext}`;
}
