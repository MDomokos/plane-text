// Plane Text: recents.
//
// This is not History (spec 5.6). History was cut from v1, correctly: the chat
// thread is already a gallery. It is sorted, timestamped, attributed,
// searchable, backed up, and it holds the original artefact rather than a
// re-render. Rebuilding that inside this app duplicates WhatsApp's job.
//
// What the chat thread cannot do is get you back to a picture you were looking
// at ten seconds ago. Leave the app and the decode is gone, and returning to it
// costs the full paste path, which on iOS is five taps because Safari has no
// Web Share Target. So this is an undo for leaving the app, not an archive. It
// is capped, it is lossy, and nobody should be told their pictures are saved
// here.
//
// It is close to free because the payload is the thumbnail. Every entry is the
// message string and nothing else. To draw a thumbnail you render the same text
// at a smaller font: no thumbnail generation, no PNG cache, no IndexedDB blob
// store, no second representation to keep in sync. Eight entries at ~16 KB is
// ~130 KB of localStorage.
//
// Be honest about what the thumbnails are. At 46px a grid of ramp glyphs reads
// as texture, not as a picture, and you recognise an entry by its shape. That
// is why every entry carries its word-name and the strip is labelled with it:
// the name identifies, the image does not.
//
// It is not in state.js because the store's field table names one owning screen
// per field, and recents is written by both compose (after a capture) and paste
// (after a decode). A two-owner field is a change to the shell's contract, so
// this is a service with its own key instead, the same standing SHELL.md gives
// a `let` inside mount(). If three screens end up needing it reactively, that
// is the argument for promoting it, and it belongs in the disagreements section
// rather than in a quiet patch.

const KEY = 'planetext.recents.v1';

// Eight is the strip, not a limit anyone should reach for. Past this the oldest
// falls off silently, which is right for an undo and wrong for an archive.
export const MAX = 8;

// { name, message, source, at }
//   name     'kachunk 20260809 1432', from words.js
//   message  the full wire message, header line and all. The only copy.
//   source   'shot' | 'library' | 'received'. Shown next to the name in the
//            viewer, since one interface serves all three and provenance is
//            what distinguishes them.
//   at       epoch ms, for ordering. The name carries the human time.

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return []; // opaque origin, private mode, corrupt JSON. Same answer to all three.
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Quota is a real possibility here in a way it is not for settings: eight
    // messages is ~130 KB against an origin budget shared with the store.
    // Dropping the oldest and retrying once is cheap. Failing silently after
    // that is correct, because losing an undo entry must not interrupt a
    // capture.
    if (list.length > 1) {
      try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, list.length - 1))); } catch { /* give up quietly */ }
    }
  }
}

export function list() {
  return read();
}

export function add(entry) {
  if (!entry || typeof entry.message !== 'string' || !entry.message) return list();
  const next = [
    { name: entry.name, message: entry.message, source: entry.source || 'received', at: entry.at || Date.now() },
    // De-duplicate by message, not by name. Pasting the same message twice is
    // the commonest route to two identical entries, and it should move the
    // existing one to the front rather than add a second.
    ...read().filter((e) => e.message !== entry.message),
  ].slice(0, MAX);
  write(next);
  return next;
}

export function find(name) {
  return read().find((e) => e.name === name) || null;
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}
