// Plane Text: the style row, and the field it owns.
//
// A segmented row of words -- ART, LINE, HALFTONE, and any custom charsets the
// user has made -- with a gold underline on the active one and no box. As of
// 2026-08-13 it is the only thing in the app that writes state.styleId.
//
// ---------------------------------------------------------------------------
// WHY THE FIELD MOVED
//
// state.js named `capture` as styleId's owner, and spec 5.1 justified the
// composer having no style picker with "style was chosen at capture". True for a
// photograph, false for a library import: the picker was on the gallery and
// dropped into the viewer, so an imported photo had no moment at which style
// could be chosen.
//
// The 2026-08-09 repair gave the import a capture moment -- `capture?import=1`,
// a frozen still with the shutter reading [ USE ]. It worked, and what it built
// was a second viewer: same pinned art box, same style row, same re-encode on a
// style change, differing from compose only in a missing slider and a hero
// label.
//
// This file is the other repair. One writer per field still holds; the writer is
// a component. Any screen may mount it and none may write styleId, capture
// included. A test greps for it. app/sizeslider.js has owned sizeChars the same
// way since 2026-08-09.
//
// ---------------------------------------------------------------------------
// THE `live` FLAG
//
// It sets the tablist's accessible description and nothing else. Both screens
// repaint themselves -- capture through vf.refresh(), the viewer through
// reencode() and refit() -- and moving that in here would mean this component
// holding a viewfinder handle and an encoder.
//
//   live: true    capture. Repaints a live preview. Instant and reversible.
//   live: false   the viewer. Re-encodes a full-resolution still and refits the
//                 <pre>. Tens of milliseconds, and it rewrites the message that
//                 is about to be shared.
//
// ---------------------------------------------------------------------------
//   styleRow(host, ctx, { live, onChange })  ->  { el, destroy, cycle }
//
//     host      where to mount. The top band on every screen that has one.
//     ctx       the screen context. Uses ctx.state and ctx.signal only, so it
//               cannot be handed a snapshot instead of the store.
//     live      see above.
//     onChange  optional. (style) after a change this row made, for a screen
//               that wants to name it out loud. Not called for a change that
//               arrived through the store, since whoever made it has already
//               said what it wanted to.
//
//     cycle(n)  move n places along the row and write the result. app/
//               stylegesture.js computes a direction and this performs the
//               write, so the gesture does not have to touch the field.
//
// There is no setVacant() to match sizeslider.js's setHidden(). The slider needs
// one because it shares a band with the strip, and a row that vanishes resizes
// every thumbnail in it. This row shares a grid cell with the name line and the
// two swap, so the viewer hides it with `hidden` and the name takes the cell.
// See .pt-styles[hidden] in stylerow.css.

import { styleList } from '../src/styles.js';
import { currentStyle } from './state.js';
import { cycleStyle } from './stylegesture.js';

export function styleRow(host, ctx, { live = false, onChange = null } = {}) {
  if (!ctx || !ctx.state || typeof ctx.state.set !== 'function') {
    // Thrown rather than defaulted, like sizeslider.js's check and
    // thumbstrip.js's. A style row handed a snapshot renders, highlights,
    // accepts taps and changes nothing, which looks like a renderer bug.
    throw new Error('styleRow: `ctx.state` must be the store, not a snapshot. This component writes styleId.');
  }
  const state = ctx.state;

  const el = document.createElement('div');
  el.className = 'pt-styles';
  el.setAttribute('role', 'tablist');
  el.setAttribute('aria-label', 'Style');
  // The whole of what `live` does. See the header.
  el.setAttribute('aria-description', live
    ? 'Changes the viewfinder as you choose'
    : 'Re-encodes this photo');

  // CUSTOM CHARSETS ARE IN THE ROW. Fixed on the way past, 2026-08-13.
  //
  // capture.js built the row from `styleList()`, the built-ins alone, while
  // app/stylegesture.js walks `styleOrder()`, the built-ins plus
  // state.customCharsets. A user who made a charset in settings could swipe onto
  // it, find no word underlined anywhere, and have no way back except swiping
  // past every built-in again.
  //
  // Two lists in two files, which nobody decided. The row and the gesture now
  // walk the same one, defined here.
  function options() {
    const custom = state.get().customCharsets.map((c) => ({
      id: c.id,
      name: c.name,
      description: 'Your charset',
    }));
    return [...styleList(), ...custom];
  }

  // Rebuilt rather than patched when the custom charset list changes, because
  // the row's CONTENTS change: a deleted charset must lose its word, and a new
  // one must gain it. Patching would need a diff against a list of at most a
  // dozen buttons, which is more code than recreating them.
  let buttons = new Map();

  function build() {
    el.textContent = '';
    buttons = new Map();
    for (const style of options()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pt-style';
      b.setAttribute('role', 'tab');
      b.textContent = String(style.name).toUpperCase();
      if (style.description) b.title = style.description;
      b.addEventListener('click', () => write(style.id), { signal: ctx.signal });
      buttons.set(style.id, b);
      el.append(b);
    }
  }

  function write(id) {
    if (id === state.get().styleId) return;
    state.set({ styleId: id });
    // After the write, so a handler that reads the store sees the new value.
    if (onChange) onChange(currentStyle(state.get()));
  }

  function render() {
    const active = currentStyle(state.get()).id;
    for (const [id, b] of buttons) {
      const on = id === active;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    }
  }

  // So two mounted rows cannot disagree, and so a row stays right when the field
  // moves without a tap on it: the style gesture, a charset deleted in settings,
  // state restored from storage.
  //
  // `customCharsets` rebuilds; `styleId` only re-marks. Rebuilding on both would
  // recreate a dozen buttons mid-swipe on every style gesture.
  const unsubscribe = state.subscribe((_s, changed) => {
    if (changed.has('customCharsets')) { build(); render(); return; }
    if (changed.has('styleId')) render();
  }, { signal: ctx.signal });

  build();
  render();
  if (host) host.append(el);

  return {
    el,

    cycle(n) {
      write(cycleStyle(state.get(), styleList(), n));
    },

    // ctx.signal tears down the listeners, so this is only for a screen that
    // drops the row without unmounting itself. Nothing does that today; it is
    // here so such a screen does not reach for el.remove() and leave a live
    // subscription on a detached node.
    destroy() {
      if (typeof unsubscribe === 'function') unsubscribe();
      el.remove();
    },
  };
}
