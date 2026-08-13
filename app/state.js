// Plane Text: shared state.
//
// A store, not a framework: get() / set() / subscribe(). Screens and components
// own fields, and a component owner outranks a screen; see the two rows below
// that name a module. The store owns nothing but the notification. Every field
// names one owner, the only thing allowed to write it. Everybody may read.
//
//  field           type                       default              owner
//  --------------  -------------------------  -------------------  ----------------------
//  styleId         string                     DEFAULT_STYLE 'art'  app/stylerow.js
//  facing          'environment' | 'user'     'environment'        capture
//  customCharsets  [{ id, name, ramp }]       []                   settings/charsets
//  sizeChars       int, CHARACTERS            sizeRange().default  app/sizeslider.js
//  capture         { source, width, height,   null                 capture
//                    takenAt } | null
//  encoded         encode() result | null     null                 compose
//  calibration     'auto' | 'off' | 'force'   CALIBRATION_DEFAULT  settings
//  invert          bool (dark polarity)       INVERT_DEFAULT true  settings
//  offline         { state, ready, version,   { state:'caching', … } offline shell / SW
//                    missing, shell, update,
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
// STYLE WAS CHOSEN AT CAPTURE, AND NOW IT IS NOT. Rewritten 2026-08-13.
//
// Spec 5.1 called style "a lens, not an export option": choosing it at capture
// keeps it framing rather than filtering. That is why this table said styleId's
// owner was `capture`, and why the composer had no style picker to write one.
//
// It was false for an imported photo. There was no capture -- the picker lived
// on `paste` and dropped the user straight into `compose` -- so a library import
// had no moment at which style could be chosen. A gap rather than a preference.
//
// Two repairs were available. Give compose a style row, which makes styleId a
// two-owner field and this table wrong. Or route imports through capture so the
// moment exists. The second was taken on 2026-08-09, as a frozen sub-mode in
// capture.js reading [ USE ], and styleId kept one owning screen.
//
// It was reversed on 2026-08-13: the sub-mode was the composer with a different
// hero label. See app/stylerow.js.
//
// The third repair was available all along, and the row below had already taken
// it: give the FIELD a component owner. app/stylerow.js writes styleId; both
// picture screens mount it; no screen writes it, capture included. Under the old
// rule two screens could each have written the field with nothing mechanical to
// stop them. A test greps all three.
//
// It retires spec 5.1's "style is a lens". Style is changeable after the fact
// now, for photographs you shot as well as ones you imported. That argument was
// always in tension with the library path, where there is no framing moment.
//
// TWO ROWS OF THIS TABLE NAME A MODULE RATHER THAN A SCREEN. 2026-08-09,
// 2026-08-13.
//
// sizeChars' owner was `compose`, on the same reasoning styleId's is `capture`:
// the size was chosen after the shot, so the composer chose it. The owner
// reversed that -- "be able to edit the line count in the live viewfinder, not
// just after the image was taken" -- and asked for the control on BOTH screens.
//
// That is a two-writer field, which is the problem styleId had, and the rule
// above is that it gets repaired rather than accepted. styleId's first repair
// was to make the missing moment exist so the field kept one owning screen.
// There was no equivalent here: two screens genuinely do choose the size, by
// instruction, and no amount of routing makes that one screen.
//
// So the repair is applied one level down. The control is a component,
// app/sizeslider.js, and the component is the only thing in the app that writes
// this field. Both screens mount it and neither sets it. The owner column names
// the writer, so the writer is what it names -- and unlike a prose convention
// this is greppable, which is how a test pins it.
//
// This row carried a caveat until the migration finished, and the caveat is
// gone because the exception is: compose.js built its own slider inline and set
// sizeChars itself, which made the row a statement of where the write BELONGED
// rather than of where it was. That control, its DEVICE_MARKERS and its
// sliderTicks were deleted on 2026-08-09 and it mounts the component like
// capture does, so there is no direct write left anywhere. The test that greps
// for one now greps BOTH picture screens, which is what turns this row from a
// prose convention into something that fails when it stops being true.
//
// This row went first and styleId followed on 2026-08-13, once keeping a screen
// in its owner column had cost a whole screen mode.
//
// The consequence: capture and compose now share a stage geometry (shell.css
// .app-frame) and differ only in their chrome bands, so they read as one screen
// with two modes. That is also why the style gesture is capture only. On
// compose a horizontal drag is the carousel, and a screen where every drag is a
// mode guess is worse than one with a gesture fewer.

import { DEFAULT_STYLE, resolveStyle, customStyle } from '../src/styles.js';
import { sizeRange, colsForChars } from '../src/sizing.js';
import { CALIBRATION_DEFAULT, INVERT_DEFAULT } from '../src/constants.js';

export function initialState() {
  return {
    styleId: DEFAULT_STYLE,
    // Which camera. The getUserMedia constraint value verbatim, rather than a
    // boolean like `selfie`, so nothing between here and camera.js has to
    // translate it and there is no chance of the two ends disagreeing about
    // which way round the flag means.
    //
    // Rear by default: the app photographs a thing to send to somebody, and the
    // front camera is the exception. Persisted, because a user who flipped to
    // the front camera and navigated to compose and back has not changed their
    // mind, and a control that silently resets is a control you stop trusting.
    //
    // It is a request, not a fact. camera.js passes it as `{ ideal: … }`, so a
    // device with one camera quietly ignores it, which is exactly why the flip
    // button is hidden unless enumerateDevices() finds a second one.
    facing: 'environment',
    customCharsets: [],
    // Wherever SIZE_DEFAULT_END says, which is the middle of the COLUMN range
    // as of 2026-08-09. The store must not carry its own opinion about this:
    // that is how two files end up disagreeing about the same default.
    sizeChars: sizeRange().defaultChars,
    capture: null,
    encoded: null,
    calibration: CALIBRATION_DEFAULT,
    invert: INVERT_DEFAULT,
    // `state` is the word the readout renders; `ready` is the boolean anything
    // else should branch on. Both, because a tick cannot say "caching" and a
    // string cannot be tested without parsing it. See app/offline.js.
    offline: { state: 'caching', ready: false, version: null, missing: [], shell: false, update: false, checkedAt: null },
    sizeTestLog: [],
  };
}

// What survives a reload. `capture` and `encoded` do not: a photo is a
// session, and a stale encode is worse than none.
export const PERSISTED = ['styleId', 'facing', 'customCharsets', 'sizeChars', 'calibration', 'invert', 'sizeTestLog'];

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
