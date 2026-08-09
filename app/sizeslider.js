// Plane Text: the size control, built once.
//
// One <input type="range"> plus its tick marks, mounted by both picture
// screens. Added 2026-08-09 for the owner's "be able to edit the line count in
// the live viewfinder, not just after the image was taken."
//
// WHY IT IS A MODULE AND NOT A SECOND COPY ON capture.
//
// The precedent is app/actionbar.js and app/thumbstrip.js, and thumbstrip.js's
// header is the argument in full: the last time two screens each rendered the
// same eight recents entries, they disagreed about the thumbnail size, the
// name, the selection mark, the empty state and the cap note, and nobody chose
// any of it. A range input is a worse candidate for copy-paste than a
// thumbnail, because the rebuild in app/sizeslider.css carries two rules that
// are invisible when broken:
//
//   1. -webkit-appearance: none must be set on the INPUT and again on the thumb
//      pseudo-element. Set on the input alone, iOS draws its own round platform
//      thumb on our hairline track.
//   2. The WebKit and Firefox pseudo-element selectors CANNOT be merged into
//      one selector list. An unknown pseudo-element invalidates the whole rule
//      in both engines, so a "tidied" shared block silently applies to neither.
//
// A second copy would be 130 lines of CSS and 25 of tick geometry that are free
// to drift, and the drift would show up as "the slider looks different on the
// other screen", which is exactly the report that produced thumbstrip.js.
//
// ---------------------------------------------------------------------------
// OWNERSHIP OF state.sizeChars. Read this before adding a third caller.
//
// state.js's table names one owner per field, and sizeChars' owner was
// `compose`. A slider on capture makes that a two-writer field, which is the
// problem styleId had and which was REPAIRED rather than accepted (state.js,
// "That rule was repaired rather than broken"). The repair there was to give
// the import a capture moment so styleId kept one writer.
//
// There is no equivalent available here: the owner has asked for the control on
// both screens by name, so two screens genuinely do choose the size. What can
// still be true is that there is one WRITER, and this module is it. Both
// screens mount it; neither sets sizeChars itself; the field's owner in the
// table is this file. That is the same shape as the repair, applied to the
// write rather than to the moment, and it is checkable -- a test greps the
// screens for a direct write.
//
// That is now true of the whole tree. compose.js's inline build, its own
// DEVICE_MARKERS and its own sliderTicks were deleted on 2026-08-09 and it
// mounts this module like capture does, so the last direct write is gone and
// the grep in test/planetext.test.js covers BOTH screens rather than one. Read
// the test before adding a caller: a third screen that sets sizeChars itself
// fails there, which is the point of doing it this way rather than in prose.
//
// ---------------------------------------------------------------------------
// UNITS. The range is in CHARACTERS and columns are derived (state.js, and the
// 2026-08-09 note in src/sizing.js that was reversed twice). Nothing here
// stores or accepts a column count. `cols` is handed to the callbacks as a
// convenience, computed through currentCols() -- the app's only
// characters-to-columns conversion -- so a caller never has to reach for
// colsForChars() and get the codec wrong.
//
// COLUMNS ARE WHAT A CALLER SHOULD ACT ON, NOT CHARACTERS. Measured: the track
// is 5,742 to 22,663 characters, 16,921 one-step positions, and those map onto
// exactly 66 distinct ramp column counts. So ~99.6% of the values the thumb can
// take produce a grid identical to the one already on screen -- identical cols,
// identical rows, and therefore an identical messageChars, since that is
// cells + rows + WRAPPER_BUDGET and nothing else. Re-encoding on those is
// provably re-encoding for the same answer. `cols` is in the callback payload
// so the caller can skip them; capture does, and the arithmetic is at its call
// site.
//
// ---------------------------------------------------------------------------
// WHERE THE CSS IS. app/sizeslider.css, linked from index.html beside
// app/thumbstrip.css and precached with it.
//
// It was app/screens/compose.css until 2026-08-09, under that file's SLIDER
// heading, because the control was compose's before it was anybody's. That was
// recorded here as wrong and deliberate: the only two options the day this
// module was extracted were to copy 130 lines of range input into a second
// file, which is the exact thing this module prevents, or to emit the class
// names the one existing definition already styled. The second was the smaller
// lie, and it was a lie -- capture rendered correctly only because index.html
// links every screen sheet on every route, so the viewfinder's slider was being
// drawn out of the VIEWER's stylesheet.
//
// The classes moved prefix with the rules: `sc-` was the viewer screen's
// namespace and this is not the viewer's control. They are `pt-` now, as
// .pt-actionbar and .pt-strip are. The input is .pt-slider-input rather than
// .pt-view-slider, because `view` is the word the viewer uses for itself and
// carrying it in here would have kept the drift under a new prefix.
//
// ---------------------------------------------------------------------------
// The interface:
//
//   sizeSlider(host, {
//     store,     the store. This module is the only thing that writes
//                sizeChars, so it needs set(), not a snapshot.
//     label      the accessible name. Defaults to the wording compose shipped.
//     onInput    ({ chars, cols }) after every store write, synchronously.
//                NOT coalesced here: what is expensive differs per screen --
//                capture repaints a live viewfinder, compose re-encodes a
//                full-resolution still and re-fits a <pre> -- and a component
//                that guessed would be wrong for one of them. Each caller
//                decides, and both have the `cols` above to decide with.
//     onSettle   ({ chars, cols }) on `change`: the drag has ended. This is
//                where compose updates the recents entry, because doing it per
//                input would fill all eight slots with one photograph at eight
//                sizes.
//     signal     AbortSignal, as everywhere in this codebase.
//   })
//   -> { el, input, sync(), setHidden(on) }
//
// `sync()` pulls the store's value back into the thumb. Call it after anything
// that changes sizeChars without going through this control. It is a no-op when
// they already agree, because writing `input.value` mid-drag on some engines
// interrupts the drag.

import { sizeRange, charsForCols, colsForChars } from '../src/sizing.js';
import { CODEC, CAPTURE_ASPECT } from '../src/constants.js';
import { currentCols } from './state.js';

// Spec 5.4's four device markers, in COLUMNS.
//
// Moved here from compose.js unchanged, including the contradiction it records:
// three of the four are off the end of the range, because the 2026-08-09
// reversal moved the slider to characters on a range derived from RAMP_COLS_MIN
// 65 to RAMP_COLS_MAX 130 and the spec was not updated with it. What gets drawn
// is the one that is in range, plus the range's own endpoints. Spec 5.4 needs
// rewriting, which is a decision rather than a patch; a test in
// test/planetext.test.js pins the disagreement from the other side so that
// widening the range, or rewriting the spec, fails loudly here.
export const DEVICE_MARKERS = [
  { cols: 40, label: 'BUBBLE' },
  { cols: 108, label: 'PHONE' },
  { cols: 222, label: 'TABLET' },
  { cols: 355, label: 'DESKTOP' },
];

// The marks to draw on a track, as { chars, label, device }.
//
// Pure, and exported, so the disagreement above is testable without a DOM.
export function sliderTicks(range) {
  const ticks = [];
  for (const m of DEVICE_MARKERS) {
    const chars = charsForCols(CODEC.RAMP, m.cols, CAPTURE_ASPECT);
    if (chars <= range.minChars || chars >= range.maxChars) continue;
    ticks.push({ chars, label: m.label, device: true });
  }
  // The endpoints, labelled with the column counts they actually are. Without
  // these the track has one mark on it and reads as decoration.
  ticks.unshift({ chars: range.minChars, label: `${colsForChars(CODEC.RAMP, range.minChars, CAPTURE_ASPECT)}`, device: false });
  ticks.push({ chars: range.maxChars, label: `${colsForChars(CODEC.RAMP, range.maxChars, CAPTURE_ASPECT)}`, device: false });
  return ticks;
}

export function sizeSlider(host, {
  store,
  label = 'Message size in characters',
  onInput = null,
  onSettle = null,
  signal = null,
} = {}) {
  if (!store || typeof store.set !== 'function' || typeof store.get !== 'function') {
    // Thrown rather than defaulted, in the spirit of actionbar.js's check() and
    // thumbstrip.js's. A slider handed a snapshot instead of the store would
    // render, drag, and change nothing -- which looks like an encoder bug and
    // is not one.
    throw new Error('sizeSlider: `store` must be the store, not a snapshot. This component writes sizeChars.');
  }

  const range = sizeRange();

  const el = document.createElement('div');
  el.className = 'pt-slider';

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'pt-slider-input';
  input.min = String(range.minChars);
  input.max = String(range.maxChars);
  input.step = '1';
  input.setAttribute('aria-label', label);

  // The ticks are drawn UNDER the track rather than on it, so the thumb passing
  // over one never hides it, and they are aria-hidden: they are labels on a
  // control that already has an accessible name and a value.
  const track = document.createElement('div');
  track.className = 'pt-slider-ticks';
  track.setAttribute('aria-hidden', 'true');
  for (const tick of sliderTicks(range)) {
    const pct = ((tick.chars - range.minChars) / (range.maxChars - range.minChars)) * 100;
    const mark = document.createElement('span');
    mark.className = tick.device ? 'pt-tick is-device' : 'pt-tick';
    mark.style.left = `${pct}%`;
    const text = document.createElement('span');
    text.className = 'pt-tick-label';
    text.textContent = tick.label;
    mark.append(text);
    track.append(mark);
  }

  // Input first, ticks second. The ticks are position:absolute inside this
  // wrapper and pointer-events:none, so the order is not a stacking decision;
  // it is the order compose has shipped and there is no reason for two screens
  // to disagree about even that.
  el.append(input, track);

  function payload() {
    const s = store.get();
    return { chars: s.sizeChars, cols: currentCols(s) };
  }

  input.addEventListener('input', () => {
    // The store is written on EVERY input, uncoalesced, because it is a shallow
    // merge and a notify and it is what keeps the readout, the persistence and
    // any other subscriber from desynchronising from the thumb. Only the
    // caller's expensive work is throttled, and only by the caller.
    store.set({ sizeChars: Number(input.value) });
    if (onInput) onInput(payload());
  }, { signal });

  input.addEventListener('change', () => {
    if (onSettle) onSettle(payload());
  }, { signal });

  function sync() {
    const want = String(store.get().sizeChars);
    if (input.value !== want) input.value = want;
  }

  sync();
  if (host) host.append(el);

  return {
    el,
    input,
    sync,
    // VACANT RATHER THAN ABSENT. Changed 2026-08-09.
    //
    // This set `hidden` on the wrapper and the input, which is `display: none`,
    // which took the whole 44px row out of the band. That was correct while the
    // recents strip below it was a fixed height pinned with `margin-top: auto`:
    // the strip stayed put and the band simply carried one row fewer.
    //
    // The strip fills the band now (thumbstrip.css), so a row that disappears
    // is 48px handed to the thumbnails, and every thumbnail changes size the
    // moment you swipe from your own photo onto a received one. The control
    // therefore keeps its row and stops being there inside it. See
    // `.pt-slider.is-vacant` in sizeslider.css for why that is `visibility`
    // rather than `opacity`.
    //
    // Still one call for the whole control. The old pair of `hidden` flags
    // existed because .pt-slider[hidden] and .pt-slider-input[hidden] are
    // separate rules; visibility inherits, so the wrapper carries both.
    setHidden(on) {
      el.classList.toggle('is-vacant', Boolean(on));
    },
  };
}
