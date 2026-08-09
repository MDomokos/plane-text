// Plane Text: the recents strip.
//
// Eight entries out of one cache, drawn one way, in one place, on every screen
// that shows them. The strip, the thumbnail, its name, the selection underline,
// the armed delete, the cap note and the empty state all live here, because the
// last time they lived in two screens the two screens disagreed about all of
// them: 30 x 40 against 46 x 60, a name on one and not the other, a selection
// mark on one and not the other, the cap note in two different places in two
// different colours, and an empty state that existed on `paste` and had no
// equivalent on `compose`. None of that was decided. It is what two renderers
// written at different times converge on, which is the drift README.md opens
// with five instances of.
//
// ---------------------------------------------------------------------------
// DELETE IS ONE LABELLED BUTTON NOW, NOT A CORNER GLYPH ON EVERY THUMBNAIL.
// Changed 2026-08-09, on the owner's report: "add an actual delete button, not
// the corner dismiss method."
//
// What went: `.pt-thumb-del`, a 22 x 22 `×` hung off the top-right corner of
// each card. Its whole design was an apology for its size. It could not be given
// a 44px hit box, because a 44px box on a 36px card covers the card and the one
// next to it -- that was the shipped bug, where tapping a picture deleted it --
// so thumbstrip.css carried twenty lines of arithmetic proving that 22px, hung
// into the 8px gap, was the largest target that did not overlap anything, and a
// paragraph in planetext.test.js explaining why this one control was allowed
// under the floor actionbar.js throws over.
//
// None of that argument is needed any more, so none of it is kept. The control
// below is a normal button with a word on it and --pt-tap of height, in the
// chrome band, where there is room for one. It deletes the entry the screen is
// currently showing, which is the one the user is looking at and the only one
// they can have formed an intention about.
//
// WHAT SURVIVES, and it is the part that mattered: it arms on the first tap and
// deletes on the second. That was never a compensation for the small target,
// even though the old comment framed it that way. There is no undo, this and
// settings' CLEAR ALL are the only destructive controls in the app, and a
// destructive control that fires on one tap is one mis-tap away from losing a
// picture. Same `data-armed="1"` idiom as `.sc-set-btn.is-danger[data-armed="1"]`
// in settings.css, same 3000ms window, same "quiet until armed" colouring.
//
// WHERE IT SITS is the screen's business, like the strip's own position: the
// component builds it into a host the caller supplies. Both screens put that
// host in the top chrome band. See the note in compose.js.
//
// This reverses a decision recorded in paste.js on 2026-08-09, which said the
// arming code was "deliberately not factored out ... twenty lines that close
// over one screen's root and its own render function, and a shared module would
// have to be handed both plus the glyph and the label wording, which is more
// interface than duplication". That was a fair reading of the arming code ALONE.
// It stopped being fair once the owner asked for one thumbnail: the interface
// below is five options, and the arming is the smallest of the seven things it
// carries. The cross-references that decision relied on to keep the two copies
// honest are gone with the copies.
//
// WHAT IS NOT HERE, and why. Where the strip sits vertically is the screen's
// business, but the component insists on `margin-top: auto` (thumbstrip.css) so
// that whatever flex column it lands in pins it to the bottom. That is what puts
// it in the same place on both screens without either screen naming a number.
//
// The interface:
//
//   thumbStrip(host, {
//     state,        () => the store snapshot. paintThumb() reads the current
//                   charset out of it, and it must be read at paint time rather
//                   than captured, since a style change repaints these.
//     selected      the name of the entry currently on screen, or null for
//                   "this strip has no current entry". The viewer passes a name
//                   and `open` passes nothing, which is the only data
//                   difference between the two: the gold underline is rendered
//                   on both and simply never lights on `open`.
//     pickVerb      the verb in a thumbnail's accessible name. 'Show' on the
//                   viewer, where a tap swaps the stage; 'Open' on `open`,
//                   where it navigates.
//     onPick        (entry, index)
//     deleteHost    the element the DELETE button is built into, or null for a
//                   strip with no delete at all. Nothing is positioned by the
//                   component: it appends one button and the host decides where
//                   that lands, exactly as the strip itself does.
//     deleteFill    the DELETE button is one of several equal controls in a row
//                   rather than a fixed column beside a centred name. See
//                   `.pt-del.is-fill` in thumbstrip.css: it releases the 88px
//                   width, which is a measurement taken against the title band
//                   and means nothing in an action row. The viewer passes
//                   nothing; the gallery passes true.
//     onDelete      (entry, { index }) -- the SECOND tap only. The first arms.
//                   The entry is already out of recents and the strip has
//                   already redrawn by the time this fires, so a caller only
//                   has to decide where to land. `index` is the slot the entry
//                   occupied, which is what "land on the neighbour" needs.
//
//                   There is no `wasSelected` any more. The old per-thumbnail
//                   control could delete an entry you were not looking at, so
//                   compose had a second branch that only fixed up its swipe
//                   index. One control that acts on the current entry makes
//                   that branch unreachable, and an unreachable branch in the
//                   only destructive path in the app is worse than no branch.
//     say           optional sink for one transient line. Both screens have a
//                   status line as of 2026-08-09 and both pass it; the button's
//                   own label is still the state of record.
//     signal        AbortSignal, as everywhere in this codebase.
//   })
//   -> { el, render, select, entries }
//
// `selected` is what decides the ARIA shape, and that is not a shortcut. A
// tablist whose tabs do not mark one of themselves current is a lie to a screen
// reader, so a strip with no current entry is a plain labelled group of buttons
// instead.

import * as recents from './recents.js';
import { paintThumb } from './thumb.js';

// settings.js's window for the same decision, and compose.js's before this file
// existed. Two disarm timings for one idiom would be two idioms.
const ARM_MS = 3000;

// Phrased as what the strip is FOR rather than "nothing here", so a first-time
// user learns it exists before they have anything in it. This used to be one
// screen's copy; it is now the only copy, which is the point.
const EMPTY_COPY = 'Pictures you open or take appear here, so you can get back to them without pasting again.';

export function thumbStrip(host, {
  state,
  selected = null,
  pickVerb = 'Open',
  onPick = null,
  deleteHost = null,
  deleteFill = false,
  onDelete = null,
  say = null,
  signal = null,
} = {}) {
  if (typeof state !== 'function') {
    // Thrown rather than defaulted, in the spirit of actionbar.js's check():
    // a strip that silently draws eight blank boxes because the store was
    // passed by value looks like a decode bug and is not one.
    throw new Error('thumbStrip: `state` must be a function returning the store snapshot, not a snapshot. Thumbnails repaint after the snapshot you have now.');
  }

  const el = document.createElement('div');
  el.className = 'pt-strip';
  el.setAttribute('aria-label', 'Recent pictures');
  host.append(el);

  let entries = [];
  let current = selected;
  let buttons = [];

  // One AbortController per render, chained to the caller's signal. The two
  // screens used to hand every thumbnail's listener the SCREEN's signal, so a
  // delete left the listeners of the discarded buttons registered until the
  // screen unmounted, and the signal's reference to each closure kept the
  // detached nodes alive with them. Bounded and small, but this strip now
  // re-renders on every delete on both screens, and "re-render in place" is
  // most of what it does.
  let pass = null;
  let frames = [];

  // Where every thumbnail's art was painted, kept so the strip can repaint
  // WITHOUT rebuilding. See the observer below.
  let cards = [];
  let repaintFrame = 0;
  let paintedAt = 0;

  // --- delete ------------------------------------------------------------
  //
  // One button, one target: whatever `current` names. Built once and kept, not
  // rebuilt per render, because it does not belong to any thumbnail -- which is
  // the whole change. Its listener therefore takes the CALLER's signal rather
  // than the per-render one below.
  //
  // Hidden rather than disabled when there is nothing selected. A disabled
  // control is low-contrast, shows no tooltip on touch and implies it could be
  // enabled, which is the same argument sizeslider.css makes for the size
  // slider on a received message. On an empty gallery there is genuinely
  // nothing to delete, and the strip's empty state already says why.
  const del = deleteHost ? document.createElement('button') : null;
  if (del) {
    del.type = 'button';
    del.className = deleteFill ? 'pt-del is-fill' : 'pt-del';
    del.hidden = true;
    del.textContent = 'DELETE';
    deleteHost.append(del);
  }

  // Two taps, the second on a different word, exactly as CLEAR ALL in
  // settings.js. There is no undo and these are the only two destructive
  // controls in the app.
  //
  // 'TAP AGAIN' rather than settings' 'TAP AGAIN TO CLEAR': this button shares a
  // --pt-tap band with the message name and is width-limited to twice the tap
  // minimum (see .pt-del in thumbstrip.css), where the longer phrase does not
  // fit. The accessible name below carries the full sentence, which is the half
  // of the announcement that has to be unambiguous -- a screen reader user gets
  // no colour and no ring, so without it the control announces itself as Delete
  // twice and the second announcement is the one that fires.
  let armTimer = 0;

  function disarm() {
    clearTimeout(armTimer);
    armTimer = 0;
    if (!del || del.dataset.armed !== '1') return;
    del.dataset.armed = '';
    del.textContent = 'DELETE';
    del.setAttribute('aria-label', current ? `Delete ${current}` : 'Delete');
  }

  function arm(name) {
    del.dataset.armed = '1';
    del.textContent = 'TAP AGAIN';
    del.setAttribute('aria-label', `Confirm deleting ${name}`);
    clearTimeout(armTimer);
    armTimer = setTimeout(disarm, ARM_MS);
  }

  // It disarms on the next pointerdown that is not on it.
  //
  // On `document`, not on a screen root, and that is a fix rather than a
  // convenience. Both screens used to bind this to the element they built their
  // own contents into, which is inside #app-screen -- and the action bar is a
  // SIBLING of #app-screen, in #app-bottom. So an armed delete survived a tap on
  // SHARE, on SAVE and on BACK, and on the viewer it survived the navigation
  // that BACK performs, disarming three seconds later against a screen that no
  // longer existed. A capture-phase listener on the document is the only
  // position that sees every tap in the app.
  //
  // Still true, and now also true of the picture: the button sits in the top
  // chrome band and the stage is a sibling of that band, so a tap on the picture
  // or a swipe across it passes through here and drops the arming.
  //
  // `contains` rather than `===`, because a tap on whatever the button holds is
  // still a tap on the button.
  document.addEventListener('pointerdown', (e) => {
    if (del && del.dataset.armed === '1' && !del.contains(e.target)) disarm();
  }, { signal, capture: true });

  del?.addEventListener('click', () => {
    // Read out of `entries` rather than out of recents, for the same reason
    // show() on both screens does: the OTHER screen can rewrite the cache
    // between a render and a tap, and the eight on screen are the eight the
    // user is choosing from.
    const at = entries.findIndex((e) => e.name === current);
    if (at === -1) return;
    const entry = entries[at];
    if (del.dataset.armed !== '1') {
      arm(entry.name);
      // The status line says what one word cannot. Transient at 2600ms against
      // a 3000ms window, so it leaves fractionally early: the button is the
      // state of record, the line is a caption on it.
      say?.(`Tap DELETE again to remove ${entry.name.split(' ')[0]}`);
      return;
    }
    disarm();
    recents.remove(entry.name);
    render();
    onDelete?.(entry, { index: at });
  }, { signal });

  // --- repaint on resize ---------------------------------------------------
  //
  // NEW, AND REQUIRED BY THE CARD SIZING. Added 2026-08-09 with `flex: 1 1 auto`
  // on .pt-strip.
  //
  // A thumbnail used to be --pt-thumb-w x --pt-thumb-h, a constant, so the box
  // paintThumb() measured could only change when the app was reloaded. The card
  // now fills the row and the row is what the band has left, so the box changes
  // on a rotation, on a foldable, and on any viewport change that moves
  // --pt-art-w. Without this the art keeps the font size it was fitted at and
  // either overflows its card or sits in the corner of it.
  //
  // Guarded on the height rather than fired on every delivery. ResizeObserver
  // always delivers an initial observation, and at mount the per-thumbnail rAF
  // paints below have already done the work; repainting again in the same task
  // would double the cost of every mount for nothing. The rAF path stays because
  // it is what paints where ResizeObserver is unavailable.
  //
  // rAF-coalesced, because a rotation delivers a burst.
  function repaint() {
    const s = state();
    for (const c of cards) paintThumb(c.art, c.message, c.box, s);
  }

  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver((obs) => {
      // THE BORDER BOX, NOT THE CONTENT BOX, and this is a loop rather than a
      // preference.
      //
      // This strip is `overflow-x: auto`. On a platform with classic scrollbars
      // -- a desktop, and Firefox with `scrollbar-width: thin` -- a horizontal
      // bar eats its height out of the CONTENT box. So publishing a height from
      // contentRect makes the cards wider, wider cards overflow, the bar
      // appears, the content box shrinks, the cards get narrower, the overflow
      // goes away, the bar disappears, and the observer is called again with the
      // height it started from. That oscillates for as long as the screen is
      // open, at one rAF per lap, and only on a machine nobody tests the phone
      // app on.
      //
      // The border box is set by the flex line above it and a scrollbar cannot
      // move it, so it is a fixed point. The cost is that on those platforms the
      // card is a scrollbar taller than the visible strip and the last pixels of
      // the selection underline are clipped -- which is exactly the trade
      // thumbstrip.css already records at the foot of its height budget, and
      // unchanged in kind.
      const e = obs[0];
      const h = Math.round(e?.borderBoxSize?.[0]?.blockSize ?? e?.contentRect?.height ?? 0);
      if (!h || h === paintedAt) return;
      paintedAt = h;
      // Publish it before repainting. This is the number every thumbnail is
      // sized from -- see --pt-thumb-box at the top of thumbstrip.css for why
      // the card cannot work it out in CSS -- so the cards must be their new
      // width before paintThumb() measures the box inside them.
      el.style.setProperty('--pt-thumb-box', `${h}px`);
      cancelAnimationFrame(repaintFrame);
      repaintFrame = requestAnimationFrame(repaint);
    })
    : null;
  ro?.observe(el);

  signal?.addEventListener('abort', () => {
    clearTimeout(armTimer);
    pass?.abort();
    ro?.disconnect();
    cancelAnimationFrame(repaintFrame);
    for (const id of frames) cancelAnimationFrame(id);
    frames = [];
    cards = [];
  }, { once: true });

  // --- selection ---------------------------------------------------------

  // Point the delete button at whatever is current, and show it only when that
  // is a real entry. Called from select(), so the button follows the picture
  // without either screen having to remember to move it.
  //
  // It disarms on the way through, which is the correct reading of a selection
  // change: you armed DELETE against one picture and are now looking at
  // another, so the promise the armed state made is no longer about anything on
  // screen. The document listener above covers a tap that lands nowhere; this
  // covers a swipe, a carousel tap and a delete that lands on the neighbour.
  function syncDel() {
    if (!del) return;
    disarm();
    const live = Boolean(current) && entries.some((e) => e.name === current);
    del.hidden = !live;
    if (live) del.setAttribute('aria-label', `Delete ${current}`);
  }

  // Move the underline. Separate from render() because the viewer changes which
  // picture is on the stage on every swipe and on every carousel tap, and
  // rebuilding eight thumbnails to move a 1px border would repaint the strip
  // under the user's thumb.
  //
  // `scroll` is opt-in for the same reason: the viewer calls this from its own
  // render(), which also runs on every settled slider drag, and scrolling the
  // strip because the character count changed would be a strip that twitches.
  function select(name, { scroll = false } = {}) {
    current = name ?? null;
    syncDel();
    let at = -1;
    for (let i = 0; i < buttons.length; i += 1) {
      const on = Boolean(current) && entries[i] && entries[i].name === current;
      buttons[i].classList.toggle('is-on', Boolean(on));
      if (buttons[i].hasAttribute('role')) buttons[i].setAttribute('aria-selected', String(Boolean(on)));
      if (on) at = i;
    }
    if (scroll && at >= 0) buttons[at].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    return at;
  }

  // --- render ------------------------------------------------------------

  // Rebuild from recents.list(). Returns the list it drew, so a caller does not
  // have to read the cache a second time and cannot end up holding a different
  // eight entries than the ones on screen.
  //
  // Called with no argument it keeps the current selection NAME even when that
  // name has just been deleted. That is deliberate: nothing lights for the
  // moment between the delete and the caller's onDelete deciding where to land,
  // and the strip does not flip out of tablist shape and back again in between.
  function render({ selected: next = current } = {}) {
    // The list is about to change under an armed control. The button survives a
    // render now -- it is not a child of any thumbnail -- but the entry it was
    // armed against may not, and an armed DELETE pointing at a name that is no
    // longer in the strip is a control whose next tap does nothing. select()
    // below disarms as well; this is the case where the ENTRY moved rather than
    // the selection, which select() cannot see.
    disarm();
    pass?.abort();
    pass = new AbortController();
    const pen = pass.signal;
    for (const id of frames) cancelAnimationFrame(id);
    frames = [];

    current = next;
    entries = recents.list();
    buttons = [];
    cards = [];
    el.replaceChildren();

    const asTabs = current !== null && entries.length > 0;
    el.setAttribute('role', asTabs ? 'tablist' : 'group');
    el.classList.toggle('is-empty', entries.length === 0);

    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'pt-strip-empty';
      empty.textContent = EMPTY_COPY;
      el.append(empty);
      // This path returns before select() at the foot of the function, so the
      // delete control has to be dealt with here or it would survive the list
      // it acts on: `current` still holds the name of the entry that was just
      // removed, which is exactly the state the caller's onDelete is about to
      // resolve. Both screens do call select() a moment later, and relying on
      // that is how the two strips this component replaced got out of step.
      syncDel();
      return entries;
    }

    entries.forEach((entry, i) => {
      // No wrapper element. There was one, `.pt-strip-item`, and its only job
      // was to be the positioned ancestor of the corner delete button that hung
      // off each card. With that gone the thumbnail is the flex item.
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pt-thumb';
      if (asTabs) b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', `${pickVerb} ${entry.name}`);

      const card = document.createElement('span');
      card.className = 'pt-thumb-card';
      const box = document.createElement('span');
      box.className = 'pt-thumb-box';
      const art = document.createElement('pre');
      art.className = 'pt-thumb-art';
      art.setAttribute('aria-hidden', 'true');
      box.append(art);

      const name = document.createElement('span');
      name.className = 'pt-thumb-name';
      // The word alone, not the full name: the date does not fit in 36px and
      // the word is what makes it recognisable. The full name is the accessible
      // label on the button above.
      name.textContent = entry.name.split(' ')[0];

      card.append(box, name);
      b.append(card);
      b.addEventListener('click', () => onPick?.(entry, i), { signal: pen });

      el.append(b);
      buttons.push(b);
      cards.push({ art, box, message: entry.message });

      // Draw after layout, so the box has a measured size to fit into. The
      // handle is kept so a re-render or an unmount can cancel it: a thumbnail
      // painted into a node that was replaced a microsecond ago is work nobody
      // sees, and on the viewer the first render at mount is always followed by
      // a second one in the same task once the live message has been encoded.
      const id = requestAnimationFrame(() => {
        frames = frames.filter((f) => f !== id);
        paintThumb(art, entry.message, box, state());
      });
      frames.push(id);
    });

    // The cap, said out loud, and only once it is in sight. See recents.js: the
    // moment there is a delete control the user believes this is storage, and
    // silent eviction at eight entries is then data loss rather than an undo
    // cache doing its job.
    //
    // In the strip on both screens now. `open` used to hang it off a RECENT
    // heading in --pt-warn while the viewer set it beside the thumbnails in
    // --pt-ink-faint, so one screen described the cap as a warning and the other
    // as a footnote. It is a footnote: nothing is wrong, the oldest is simply
    // next out, and an amber line beside a gold underline is also the second
    // warm colour on a screen that is allowed one.
    const note = recents.capNote(entries.length);
    if (note) {
      const cap = document.createElement('p');
      cap.className = 'pt-strip-cap';
      cap.textContent = note;
      el.append(cap);
    }

    select(current);
    return entries;
  }

  render();

  return { el, render, select, entries: () => entries };
}
