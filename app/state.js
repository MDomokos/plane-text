// Plane Text: shared state.
//
// A store, not a framework: get() / set() / subscribe(). Screens own fields.
// The store owns nothing but the notification. Every field below names one
// owner, the screen allowed to write it. Everybody may read.
//
//  field           type                       default              owner
//  --------------  -------------------------  -------------------  ----------------------
//  styleId         string                     DEFAULT_STYLE 'art'  capture
//  customCharsets  [{ id, name, ramp }]       []                   settings/charsets
//  sizeChars       int, CHARACTERS            sizeRange().default  compose
//  capture         { source, width, height,   null                 capture
//                    takenAt } | null
//  encoded         encode() result | null     null                 compose
//  calibration     'auto' | 'off' | 'force'   CALIBRATION_DEFAULT  settings
//  invert          bool (dark polarity)       INVERT_DEFAULT true  settings (no v1 UI)
//  offline         { ready, version,          { ready:false, … }   offline shell / SW
//                    checkedAt }
//  sizeTestLog     [{ chars, at, network,     []                   settings/size-test
//                     outcome }]
//
// Three things the shape leaves out:
//
//  - Columns. The slider is in characters, on a range shared by every codec
//    (2026-08-09, reversed twice. Read the decision before touching it).
//    Columns are derived: currentCols() below, via colsForChars() from
//    src/sizing.js. Do not store a column count, and do not re-derive one.
//  - Codec. It follows from the style (a style is a codec + charset + tone).
//    currentStyle().codec.
//  - Anything a screen alone cares about. A local `let` inside mount() is not
//    a lesser thing than a store field.
//
// Style is chosen at capture, not in the composer (spec 5.1). That is why
// styleId's owner is the capture screen, and why the compose screen has no
// style picker to write one.

import { DEFAULT_STYLE, resolveStyle, customStyle } from '../src/styles.js';
import { sizeRange, colsForChars } from '../src/sizing.js';
import { CALIBRATION_DEFAULT, INVERT_DEFAULT } from '../src/constants.js';

export function initialState() {
  return {
    styleId: DEFAULT_STYLE,
    customCharsets: [],
    sizeChars: sizeRange().defaultChars, // opens at the bottom of the range
    capture: null,
    encoded: null,
    calibration: CALIBRATION_DEFAULT,
    invert: INVERT_DEFAULT,
    offline: { ready: false, version: null, checkedAt: null },
    sizeTestLog: [],
  };
}

// What survives a reload. `capture` and `encoded` do not: a photo is a
// session, and a stale encode is worse than none.
export const PERSISTED = ['styleId', 'customCharsets', 'sizeChars', 'calibration', 'invert', 'sizeTestLog'];

const STORAGE_KEY = 'planetext.state.v1';

function readStorage(storage) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // file:// opaque origin, private mode, corrupt JSON. Same answer to all three.
  }
}

function writeStorage(storage, state) {
  if (!storage) return;
  try {
    const slice = {};
    for (const key of PERSISTED) slice[key] = state[key];
    storage.setItem(STORAGE_KEY, JSON.stringify(slice));
  } catch { /* quota or opaque origin. Settings are not worth an exception. */ }
}

export function createStore({ storage = null, initial = initialState() } = {}) {
  const saved = readStorage(storage);
  let state = { ...initial };
  if (saved) for (const key of PERSISTED) if (key in saved) state[key] = saved[key];

  const listeners = new Set();

  function get() {
    return state;
  }

  // Shallow merge. Notifies once, with the set of keys that actually changed
  // by reference, so a screen can ignore updates it does not care about.
  function set(patch) {
    const changed = new Set();
    for (const key of Object.keys(patch)) {
      if (!(key in state)) throw new Error(`state.set: unknown field "${key}". Add it to initialState() and to the owner table.`);
      if (state[key] !== patch[key]) changed.add(key);
    }
    if (!changed.size) return state;
    state = { ...state, ...patch };
    for (const key of changed) if (PERSISTED.includes(key)) { writeStorage(storage, state); break; }
    for (const fn of [...listeners]) {
      try { fn(state, changed); } catch (err) { console.error('state subscriber', err); }
    }
    return state;
  }

  // subscribe(fn, { signal }). Pass ctx.signal and cleanup is automatic.
  function subscribe(fn, { signal = null } = {}) {
    listeners.add(fn);
    const off = () => listeners.delete(fn);
    if (signal) signal.addEventListener('abort', off, { once: true });
    return off;
  }

  return { get, set, subscribe };
}

// The app's one store. Import this; create your own only in tests.
export const store = createStore({
  storage: typeof localStorage === 'undefined' ? null : localStorage,
});

// ---------------------------------------------------------------------------
// Derived values. They exist so four screens cannot each write their own
// slightly different version of the same two lines, which is the shape of the
// drift this codebase keeps paying for.
// ---------------------------------------------------------------------------

// The resolved style: codec, ramp, tone, stroke, size range, legibility cap.
// A custom charset resolves through customStyle(), so its ramp is linted at the
// same place a built-in one is validated. An unknown or deleted id falls back
// to the default rather than throwing, because deleting a charset must not
// brick the capture screen.
export function currentStyle(state) {
  const custom = state.customCharsets.find((c) => c.id === state.styleId);
  try {
    return resolveStyle(custom ? customStyle(custom.ramp, { id: custom.id, name: custom.name }) : state.styleId);
  } catch {
    return resolveStyle(DEFAULT_STYLE);
  }
}

// Columns for the current style at the current character count. The only place
// the app converts the slider's units. src/sizing.js owns the arithmetic.
export function currentCols(state) {
  return colsForChars(currentStyle(state).codec, state.sizeChars);
}
