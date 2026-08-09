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

// The Web Share Target hand-off. Added 2026-08-09.
//
// The manifest declares a POST share target (spec 5.5). sw.js takes the body,
// stashes it and redirects; main.js reads the stash and puts it here. iOS
// cannot have any of this, since Safari does not implement Web Share Target,
// which is the argument for Android having it: without it, receiving on Android
// costs the same copy, switch app, paste as iOS, for no reason.
//
// Here rather than in the router because a share is a message arriving, and
// this module is where messages arrive from.
//
// Taken rather than read, so it is consumed once. A launch payload that
// survives re-opens somebody's photograph on the next navigation.
let shared = null;

export function setSharedText(text) {
  shared = typeof text === 'string' && text ? text : null;
}

export function takeSharedText() {
  const out = shared;
  shared = null;
  return out;
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

// Is one of our messages sitting on the clipboard right now?
//
// Implemented 2026-08-09. It was `return false;` in capture.js, with a paragraph
// above it describing the real version, and the gold dot it feeds -- the only
// gold the action bar permits on a non-hero slot -- had therefore never rendered
// once. A rule in actionbar.css for an element no code path could produce is the
// same shape as the PNG export that was a console.warn and the settings routes
// nothing linked to.
//
// It is HERE rather than on the screen that draws the dot, because the question
// is "is this ours", and this module is where that is answered. It does NOT use
// looksLikeMessage() above, and the reason is at the return statement: the two
// are asked at different moments and a false positive costs different things.
//
// ---------------------------------------------------------------------------
// THE POLICY, WHICH IS MOST OF THE CODE.
//
// 1. NEVER PROMPT. Permissions.query() does not show UI, but clipboard.readText()
//    on a 'prompt' state does -- and this runs at mount on the app's launch
//    screen, with no user gesture behind it. A permission dialog nobody asked
//    for, over a viewfinder, to decide whether to draw a 4px dot, is a trade
//    nothing could justify. So `granted` is the only state that reads. On
//    'prompt' and 'denied' the answer is false and the user is never told there
//    was a question.
//
//    The paste path is unaffected and always was: PASTE on the gallery is a
//    button, the read happens inside the user's own tap, and iOS shows its own
//    paste confirmation there. That is the interaction this one must not
//    duplicate.
//
// 2. FALSE FOREVER ON WEBKIT, and that is the correct outcome rather than a gap.
//    Safari does not implement the `clipboard-read` permission name, so query()
//    rejects with a TypeError and the catch returns false. Firefox is the same.
//    The dot is a progressive enhancement -- the slot is always tappable and its
//    label already says where it goes -- so a platform that cannot support it
//    loses nothing it can see.
//
// 3. NO POLLING. The caller checks at mount and when the tab becomes visible
//    again, which is exactly the moment the scenario happens: you switched to
//    WhatsApp, copied a message, and came back. Reading the clipboard on a timer
//    is surveillance of a system buffer that holds passwords, and it would be
//    doing it to keep a dot up to date.
//
// Returns a promise, and every failure resolves false. There is no error path a
// caller could do anything with: the dot either appears or it does not.
export async function clipboardMayHavePayload() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) return false;
    if (!navigator.permissions || !navigator.permissions.query) return false;
    // Throws on any engine that does not know the name. See 2 above.
    const status = await navigator.permissions.query({ name: 'clipboard-read' });
    if (status.state !== 'granted') return false;
    // THE MAGIC, NOT looksLikeMessage(). They answer different questions and the
    // difference is the whole value of the dot.
    //
    // looksLikeMessage() is deliberately lenient: it is asked AFTER the user has
    // tapped PASTE, where the cost of a false positive is a better error message
    // ("this image looks incomplete") instead of a worse one. It accepts
    // anything that parses into a grid, and almost any text does -- a shopping
    // list is a one-row grid.
    //
    // This runs unprompted and its output is a claim to the user that a message
    // is waiting. A false positive here sends them to the gallery to be told the
    // paste did not work, for something they never said they wanted to paste. So
    // it wants the strict test, which is the header: src/wire.js says the magic
    // exists to answer "is this ours" for exactly this scan (spec 5.5) and is
    // cheap to find for the same reason.
    return Boolean(parseMessage(String(await navigator.clipboard.readText() || '')).magic);
  } catch {
    // Unsupported name, revoked mid-flight, a document that is not focused --
    // readText() rejects on that last one and it is the common case when the
    // tab is being restored. One answer to all of them.
    return false;
  }
}
