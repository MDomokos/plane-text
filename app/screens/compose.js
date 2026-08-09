// Plane Text: the viewer. One screen for every image.
//
// A picture you just shot, one you picked from the library, and one someone
// sent you are the same thing on screen: full-bleed art, a name, and back /
// save / share. Two things differ, and both follow from one fact, that a
// received message is already encoded and there is nothing left to decide
// about it:
//
//   the size slider   present for yours, absent for theirs
//   the fit readout   "103 columns, fits a phone" against "received"
//
// That is why this file serves the `compose` route and the paste screen
// navigates here rather than to a viewer of its own.
//
// The double-tap hazard. The action bar's primary slot never moves, and
// arriving here from a shutter tap leaves the thumb over it. It was SHOOT a
// moment ago and it is now SHARE, so without a guard a double-tap on the
// shutter opens the system share sheet for a message the user has not seen.
// `armAfter` on the hero is that guard. 250ms is longer than a double-tap
// interval and shorter than anyone's intent.
//
// ---------------------------------------------------------------------------
// CHANGED 2026-08-09 by the UX review.
//
// 1. The stage belongs to the shell. This file built its own flex column, which
//    is why the picture moved 45px and shrank 12% between the viewfinder and
//    here. See tokens.css --pt-chrome-top / --pt-chrome-bot.
//
// 2. There is a carousel. Recents was reachable only from the bottom of
//    `paste`, so moving between pictures cost BACK, a screen and a tap. Strip
//    and swipe both: the swipe costs no height, the strip makes it findable.
//
//    The strip itself is app/thumbstrip.js as of the second pass on 2026-08-09.
//    It was built here and again in paste.js, and the two copies had drifted on
//    thumbnail size, the name label, the selection mark, the cap note and the
//    empty state. What is left in this file is the half a viewer actually owns:
//    which entry is on the stage, and what a swipe means.
//
//    One limit will look like a bug and is not. A recents entry is a message,
//    with no source pixels to re-encode, so swiping off the live subject hides
//    the size slider. That is what "the payload is the thumbnail" means
//    (recents.js); the alternative is the blob store that was cut.
//
// 3. The slider is no longer the platform control. A bare <input type="range">
//    with accent-color renders a round thumb on a pill track on iOS Safari and
//    Android Chrome, against a house rule of one 2px radius on everything. It
//    was the only element breaking that rule, directly under the picture.
//
//    The rebuild is app/sizeslider.js and app/sizeslider.css as of the second
//    pass on 2026-08-09, for the reason the strip is a component: the owner
//    asked for the same control in the live viewfinder, and a range input is a
//    worse candidate for a second copy than a thumbnail is. Two of its rules
//    are invisible when broken and would show up as "the slider looks wrong on
//    iOS", which is a report nobody files from a desk.
//
// 4. There is a status line. Saving a TXT said nothing, and the clipboard
//    fallback in share() overwrote the message name to report itself, with
//    nothing to restore it from.
//
// 5. Decode warnings are shown. They were computed, this file's own comment
//    pointed at them, and no code path rendered them.
//
// 6. PNG export exists. It was a console.warn, and a dead row in a list of
//    three teaches the user the other two might be dead too.

import { defineScreen } from '../screen.js';
import { register } from '../router.js';
import { currentStyle, currentCols } from '../state.js';
import { actionBar } from '../actionbar.js';
import { sizeSlider } from '../sizeslider.js';
import { artefact } from '../artefact.js';
import { paintArt, autoFit, publishArtWidth, stageArtWidth } from '../art.js';
import { messageName } from '../words.js';
import * as recents from '../recents.js';
import { thumbStrip } from '../thumbstrip.js';
import { encodePhoto, getSubject, clearSubject, decodeMessage } from '../pipeline.js';
import { flash } from '../motion.js';

// SAVE_FORMATS, the save sheet, download(), renderPng() and share() are
// app/artefact.js as of 2026-08-09. They were all inside mount() below, closed
// over this screen's `lines`, `message`, `geom` and `viewName`, and the gallery
// now needs the same four behaviours over its own four variables. The choice was
// one module taking an accessor or a second copy on `paste`, and this codebase
// has recorded five instances of what the second copy costs.
//
// Two things went with them and are worth knowing where to find:
//
//   The PNG advance trap -- canvas has its own text metrics, so the advance must
//   be MEASURED rather than assumed -- is in artefact.js above renderPng(). It is
//   the mistake this project has now made five times and it is the one comment in
//   that file that must not be summarised away.
//
//   The sheet's rules are app/artefact.css. The dimming selector changed on the
//   way over: it was keyed on `.sc-view`, this screen's own class, which would
//   have left the gallery's picture undimmed and tappable behind a modal.

// ---------------------------------------------------------------------------
// THE SLIDER, AND ITS TICKS, ARE NOT HERE ANY MORE. Moved 2026-08-09.
//
// This file used to own the control outright: DEVICE_MARKERS, sliderTicks(),
// the wrapper, the input, the tick spans, and a `state.set({ sizeChars })` of
// its own. All of it is app/sizeslider.js now, mounted below, because the owner
// asked for the same control in the live viewfinder and a second copy of a
// range input is the drift README.md opens with five instances of.
//
// Two things went with it and are worth knowing where to find:
//
//   The spec 5.4 contradiction. Three of the four device markers are off the
//   end of the range, because the 2026-08-09 reversal moved the slider to
//   CHARACTERS and the spec was not updated with it. The note is in
//   sizeslider.js above DEVICE_MARKERS, and two tests pin it.
//
//   The write. sizeChars had `compose` as its owner in state.js's table and now
//   has app/sizeslider.js, because two screens choose the size and exactly one
//   module writes it. This screen must not set the field: a test greps it.
//
// What stayed is what is genuinely this screen's, and it is all at the mount
// below -- when the control is shown at all, how expensive its `input` is here,
// and what a settled drag means for recents.

export default register(defineScreen({
  id: 'compose',
  title: 'Compose',

  mount(el, ctx) {
    const state = ctx.state;
    const subject = getSubject();

    // Arriving with nothing to show. This happens on a reload, since neither
    // the subject nor state.capture survives one. Bounce to capture rather than
    // rendering an empty viewer.
    if (!subject) {
      ctx.navigate('capture', null, { replace: true });
      return;
    }

    const mine = subject.kind === 'mine';

    // Build into a child, never onto `el` itself. See capture.js. This screen
    // has a second reason: the save sheet is position:absolute against this
    // root, and anchoring it to the shell's own container would put it outside
    // the element the dimming rule applies to.
    const root = document.createElement('div');
    root.className = 'sc-view app-frame';
    el.append(root);

    const liveName = mine ? messageName(subject.word, new Date(subject.takenAt)) : subject.name;

    // Order matters, which is why this sits above the DOM and not with the rest
    // of the carousel: the live subject is written into recents BEFORE the strip
    // is built, so it occupies slot 0 and the strip's first thumbnail is the
    // picture you are looking at. The strip would otherwise open scrolled to
    // somebody else's photograph.
    //
    // A placeholder message, because the encode has not run yet. The slot is
    // what matters here; the real message is written into it at the end of
    // mount, before the strip's second and final render.
    if (mine) recents.add({ name: liveName, message: '\n', source: subject.source });

    // --- top band --------------------------------------------------------
    //
    // One row: the delete control, then the name. Both from the shell, because
    // the gallery draws the identical row (shell.css .app-chrome-row).
    //
    // WHY DELETE IS UP HERE. Added 2026-08-09, when the per-thumbnail corner `×`
    // was replaced by one labelled button. It had to be somewhere on both this
    // screen and the gallery, at --pt-tap, and not on top of the picture. That
    // leaves the two chrome bands, and the bottom one cannot have it: the budget
    // in tokens.css is 172 of 176 used here, so a 44px row would overflow
    // --pt-chrome-bot and start shrinking the picture on every screen at once.
    // The top band is 44px sized by capture's style row, and this screen puts an
    // 18px name line in it, so a --pt-tap control fits the band exactly with
    // nothing to move.
    //
    // LEFT, not right. actionbar.js's reasoning, applied outside the action bar:
    // for a right thumb the right edge is the easiest reach and the left the
    // hardest, so the control you least want to hit by accident takes the hard
    // side. The right corner of the top band is also where capture puts the
    // gear, and a destructive control under the pixel someone reaches for out of
    // habit is the double-tap hazard that file already warns about.
    const top = document.createElement('div');
    top.className = 'app-chrome-top';

    const topRow = document.createElement('div');
    topRow.className = 'app-chrome-row';

    // Appended before the name so the grid columns land in DOM order. The
    // button itself is built into this by thumbStrip(); the slot keeps its
    // width whether or not there is one.
    const delSlot = document.createElement('div');
    delSlot.className = 'app-chrome-slot';

    // Name line. Provenance is the only thing distinguishing three otherwise
    // identical screens, so it is stated rather than implied.
    const label = document.createElement('p');
    label.className = 'app-name';

    topRow.append(delSlot, label);
    top.append(topRow);

    // --- stage -----------------------------------------------------------
    const stage = document.createElement('div');
    stage.className = 'app-stage sc-view-stage';
    const pre = document.createElement('pre');
    // The <pre> rule is the shell's as of 2026-08-09, because the gallery paints
    // into the same object. See .app-art in shell.css.
    pre.className = 'app-art';
    pre.setAttribute('role', 'img');
    stage.append(pre);

    // --- bottom band -----------------------------------------------------
    const bottom = document.createElement('div');
    bottom.className = 'app-chrome-bot';

    // Readouts. Spec 5.2: the device-fit indicator is the primary metric and
    // the character count is secondary. The old fill bar is gone. At a third of
    // the ceiling it communicated "you have loads of room", which is true and
    // misleading, because the room cannot be spent on a bigger picture.
    const fit = document.createElement('p');
    fit.className = 'sc-view-fit';
    const chars = document.createElement('p');
    chars.className = 'sc-view-chars';

    const status = document.createElement('p');
    status.className = 'app-status';
    status.setAttribute('role', 'status');

    // The size slider, which is app/sizeslider.js and no longer this file's.
    // Mounted HERE, in the middle of assembling the band, through the host
    // argument rather than appended afterwards: the band is a flex column and
    // the order of these appends is the order of the rows. Readouts, slider,
    // strip, status, which is the row order this band has always had. capture
    // mounts the same component the same way.
    //
    // In characters, on a range shared by every codec (2026-08-09, after
    // reversing twice). The columns above it are a derived readout: switching
    // style holds the file size and changes the geometry, which is the property
    // a user can be surprised by.
    //
    // This screen does NOT write sizeChars. The component does, and it is the
    // only writer in the app; see state.js's owner table and the grep in
    // test/planetext.test.js that keeps it true. What this screen contributes
    // is setHidden() from render() and the two callbacks at the slider section
    // below, both of which are function declarations so they can be named from
    // up here.
    bottom.append(fit, chars);
    const sizeCtl = sizeSlider(bottom, {
      store: state,
      onInput: onSizeInput,
      onSettle: onSizeSettle,
      signal: ctx.signal,
    });

    // The carousel strip, which is app/thumbstrip.js and no longer this file's
    // either. Built here for the same reason as the slider above it: the strip
    // belongs between the slider and the status line. Everything it calls below
    // -- say, show, render -- is a function declaration, so all three are
    // defined long before a tap can reach them.
    //
    // It renders once now, against the placeholder message written into the
    // live slot a few lines down, and once more at the end of mount once that
    // slot holds the real encode. Both happen in this task, so the first
    // render's thumbnail paints are cancelled before a frame ever runs them.
    const strip = thumbStrip(bottom, {
      state: () => ctx.state.get(),
      selected: liveName,
      pickVerb: 'Show',
      say,
      deleteHost: delSlot,
      onPick: (_entry, i) => show(i),
      onDelete: (entry, { index }) => {
        say(`Deleted ${entry.name.split(' ')[0]}`);
        const left = strip.entries();
        // Deleting what you were looking at has to land somewhere. The
        // neighbour, not the top: the user's attention is where the picture
        // was.
        //
        // It landed on the top until 2026-08-09, and the comment saying
        // otherwise was written against code that could not do it. The old
        // renderStrip() recomputed `at` from the name of the entry being
        // viewed, and the entry being viewed had just been deleted, so
        // findIndex returned -1, Math.max(0, -1) made it 0, and every delete of
        // the current picture jumped to the front of the strip. The component
        // hands back the index the entry occupied, which is the number this
        // always needed.
        //
        // The `wasSelected` branch that used to sit above this is gone with the
        // corner delete. That control could remove an entry you were not
        // looking at, so this had to repair `at` -- the slot the swipe counts
        // from -- without changing the picture. One control that only ever acts
        // on the current entry makes that unreachable, and show() below sets
        // `at` itself.
        if (!left.length) { clearSubject(); ctx.navigate('paste'); return; }
        show(Math.min(index, left.length - 1));
      },
      signal: ctx.signal,
    });
    bottom.append(status);
    root.append(top, stage, bottom);

    // --- status ----------------------------------------------------------
    let statusTimer = 0;
    let stickyStatus = '';
    let stickyKind = '';

    // A sticky status is one the screen is not allowed to forget: a decode
    // warning describes the picture you are looking at, and it must not time
    // out the way "Saved" does. Transient messages replace it for a moment and
    // it comes back.
    function say(text, kind = '', { sticky = false } = {}) {
      clearTimeout(statusTimer);
      if (sticky) { stickyStatus = text; stickyKind = kind; }
      status.textContent = text;
      status.classList.toggle('is-warn', kind === 'warn');
      status.classList.toggle('is-error', kind === 'error');
      // See motion.js. It matters more on this screen than the other two: the
      // transient expiring RESTORES the sticky warning, and a warning
      // reappearing with no motion at all is the one status change a user is
      // most likely to miss, because they have already read that string once.
      flash(status);
      if (!sticky && text) {
        statusTimer = setTimeout(() => {
          status.textContent = stickyStatus;
          status.classList.toggle('is-warn', stickyKind === 'warn');
          status.classList.toggle('is-error', stickyKind === 'error');
          flash(status);
        }, 2600);
      }
    }
    ctx.signal.addEventListener('abort', () => clearTimeout(statusTimer), { once: true });

    // --- the carousel ----------------------------------------------------
    //
    // Both the live subject and a decoded recents entry are shown through the
    // same three variables below, so `draw` and the save/share paths do not
    // branch on which one is on screen.
    //
    // The strip itself is app/thumbstrip.js and was built with the band above.
    // What is left here is the half that is genuinely this screen's: which entry
    // is on the stage, and what a swipe means.

    // The slot the swipe counts from. The strip owns the list, so this is an
    // index into strip.entries() and nothing else may hold one across a render.
    let at = Math.max(0, recents.list().findIndex((e) => e.name === liveName));

    // What is currently on the stage.
    let encoded = null;
    let message = mine ? '' : subject.message;
    let lines = mine ? [] : subject.decoded.rows;
    let viewName = liveName;
    let viewSource = mine ? subject.source : 'received';
    let viewWarnings = mine ? [] : (subject.decoded.warnings || []);
    // The subject we mounted with is the only one with source pixels, and
    // therefore the only one with a slider.
    let onLive = true;

    let geom = mine
      ? null
      : {
        // parseMessage returns codec: null when the rows mix two cell charsets
        // and the header could not settle it. The picture is still decodable,
        // so fall back rather than throwing in advanceCssFor(). A message drawn
        // badly beats a screen that cannot be drawn.
        codec: subject.decoded.codec ?? currentStyle(state.get()).codec,
        cols: subject.decoded.grid.cols,
        rows: subject.decoded.grid.rows,
      };

    function reencode() {
      if (!mine || !onLive) return;
      const s = state.get();
      try {
        encoded = encodePhoto(s, subject.photo, { title: liveName });
        message = encoded.message;
        lines = encoded.lines;
        geom = { codec: currentStyle(s).codec, cols: encoded.stats.cols, rows: encoded.stats.rows };
        // The store's own field. compose owns `encoded`.
        state.set({ encoded });
      } catch (err) {
        console.error('compose: encode failed', err);
        say('That picture could not be encoded at this size.', 'error');
      }
    }

    function draw(w, h) {
      // The chrome's clamp comes from the RESERVED box, not from what was just
      // painted. See art.js: publishing the measured width is what made the
      // action bar and the save sheet resize on every navigation.
      publishArtWidth(stageArtWidth(w, h));
      if (!lines.length || !geom) return;
      paintArt(pre, lines, geom, w, h);
    }

    const refit = autoFit(stage, draw, { signal: ctx.signal });

    function render() {
      const s = state.get();
      pre.setAttribute('aria-label', `Photo as text: ${viewName}`);
      label.textContent = `${viewName} · ${viewSource}`;
      ctx.setTitle(viewName);

      // Absent, not disabled, for a received message: it is already encoded and
      // there is nothing left to choose. setHidden() puts the attribute on the
      // wrapper and on the input, because those are two rules in
      // sizeslider.css and a wrapper that collapses around a visible input is a
      // control that half exists. This screen is the only caller: capture's
      // slider is never hidden, because the viewfinder always has a size to
      // choose.
      const sliderOn = mine && onLive;
      sizeCtl.setHidden(!sliderOn);

      if (sliderOn) {
        const cols = currentCols(s);
        const warned = encoded && encoded.warnings.length > 0;
        // "fits a phone" is the claim the user is making with the slider, so it
        // is a sentence rather than a number.
        fit.textContent = warned
          ? `${cols} columns · the recipient will need to zoom`
          : `${cols} columns · fits a phone`;
        fit.classList.toggle('is-warn', Boolean(warned));
        chars.textContent = `${(encoded ? encoded.stats.messageChars : s.sizeChars).toLocaleString()} characters`;
        // The thumb follows anything that moved sizeChars without going through
        // the control: a mount that inherited a persisted value, or the other
        // screen's slider between two visits. sync() is a no-op when they
        // already agree, which is what makes it safe to call from render() on
        // every settled drag.
        sizeCtl.sync();
      } else {
        fit.textContent = `${geom ? geom.cols : 0} columns`;
        fit.classList.remove('is-warn');
        chars.textContent = `${viewSource} · ${message.length.toLocaleString()} characters`;
      }

      // The underline only. Not a re-render, and not a scroll: this runs on
      // every settled slider drag and on every style change, and a strip that
      // repaints eight thumbnails or scrolls itself because the character count
      // moved is a strip that twitches under your thumb.
      strip.select(viewName);
    }

    // Decode warnings, which were computed and thrown away.
    //
    // Phrased as a property of the message rather than an error: the picture is
    // on screen and readable, since parseMessage returns a grid and complaints
    // rather than refusing. The common case is a mixed charset, which draws
    // with a slightly wrong line-height.
    function announceWarnings() {
      if (!viewWarnings.length) { say('', '', { sticky: true }); return; }
      const first = viewWarnings[0];
      const more = viewWarnings.length - 1;
      say(more > 0 ? `${first} (+${more} more)` : first, 'warn', { sticky: true });
    }

    // Put entry `i` on the stage. The live subject restores the photo and the
    // slider; anything else is a decoded message.
    //
    // The list is read out of the strip rather than out of recents, so the index
    // this is handed is always an index into the eight thumbnails on screen. The
    // other screen can rewrite the cache between a render and a tap.
    function show(i) {
      const list = strip.entries();
      if (i < 0 || i >= list.length) return;
      const entry = list[i];
      const live = entry.name === liveName;

      if (live && mine) {
        onLive = true;
        viewName = liveName;
        viewSource = subject.source;
        viewWarnings = [];
        at = i;
        reencode();
      } else {
        const decoded = decodeMessage(entry.message);
        if (!decoded) { say('That picture could not be read.', 'error'); return; }
        onLive = false;
        message = entry.message;
        lines = decoded.rows;
        viewName = entry.name;
        viewSource = entry.source || 'received';
        viewWarnings = decoded.warnings || [];
        geom = {
          codec: decoded.codec ?? currentStyle(state.get()).codec,
          cols: decoded.grid.cols,
          rows: decoded.grid.rows,
        };
        at = i;
      }
      announceWarnings();
      render();
      refit();
      // The one place the strip is asked to scroll: the picture just changed, so
      // the thumbnail that says which one it is has to be in sight.
      strip.select(viewName, { scroll: true });
    }

    // --- swipe -----------------------------------------------------------
    //
    // Horizontal, on the picture. Vertical is deliberately NOT bound here: on
    // capture a vertical drag cycles the style, and styleId is owned by that
    // screen. See app/stylegesture.js. One axis, one meaning, per screen.
    const SWIPE_PX = 56;
    let swipeId = null;
    let sx0 = 0;
    let sy0 = 0;
    let swiped = false;

    stage.addEventListener('pointerdown', (e) => {
      if (swipeId !== null) { swipeId = null; return; } // pinch, not a swipe
      swipeId = e.pointerId; sx0 = e.clientX; sy0 = e.clientY; swiped = false;
    }, { signal: ctx.signal });

    stage.addEventListener('pointermove', (e) => {
      if (swipeId === null || e.pointerId !== swipeId || swiped) return;
      const dx = e.clientX - sx0;
      const dy = e.clientY - sy0;
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return;
      swiped = true;
      // Drag left to move forward through the list, the way every other
      // horizontally paged thing on a phone behaves.
      show(at + (dx < 0 ? 1 : -1));
    }, { signal: ctx.signal });

    const endSwipe = (e) => { if (swipeId === null || e.pointerId === swipeId) swipeId = null; };
    stage.addEventListener('pointerup', endSwipe, { signal: ctx.signal });
    stage.addEventListener('pointercancel', endSwipe, { signal: ctx.signal });
    stage.addEventListener('pointerleave', endSwipe, { signal: ctx.signal });

    // --- slider ----------------------------------------------------------
    //
    // The control is mounted with the band above, the same way capture mounts
    // it. These are the two callbacks it was handed, written as function
    // declarations so the mount can name them from further up the file. Neither
    // can run before mount() returns -- they only fire on a pointer -- which is
    // what makes it safe for the rAF handle below to be declared down here with
    // the code that uses it.
    //
    // rAF-coalesced, because a range input fires on every pixel of a drag and
    // an encode is not free. The store is written on every input, by the
    // component, so nothing desynchronises; only the expensive part is
    // throttled, and it is throttled HERE rather than inside the component.
    // sizeslider.js says why at length: what is expensive differs per screen.
    // This screen re-encodes a full-resolution still and re-fits a <pre>, which
    // is the heaviest of the two paths, and capture -- which repaints a live
    // viewfinder instead -- skips on the derived column count and repaints
    // synchronously. A component that coalesced for both would be wrong for one
    // of them.
    //
    // `cols` is in the payload and this screen does not read it, which is the
    // one thing here worth flagging rather than defending. capture skips an
    // input entirely when the derived column count has not moved, and the same
    // skip would be sound in front of this rAF -- the encoder's output is a
    // function of the column count alone -- so the coalescing would be doing
    // nothing on ~99.6% of the events it currently absorbs. It is not done here
    // because this rAF is the behaviour that shipped and the move to the
    // component was not the change to alter it under. An open item, not a
    // finding.
    let pending = 0;
    function onSizeInput() {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => { reencode(); render(); refit(); });
    }
    // The recents entry follows the picture, but only once the drag has
    // settled, which is what `change` means and why the component exposes it
    // separately. update() rather than add(): add() de-duplicates by message,
    // so re-adding after every re-encode would fill all eight slots with the
    // same photograph at eight sizes.
    function onSizeSettle() {
      if (mine && onLive && message) recents.update(liveName, message);
    }
    ctx.signal.addEventListener('abort', () => cancelAnimationFrame(pending), { once: true });

    state.subscribe((_s, changed) => {
      if (changed.has('styleId') || changed.has('customCharsets') || changed.has('invert')) {
        reencode(); render(); refit();
        if (mine && onLive && message) recents.update(liveName, message);
      }
    }, { signal: ctx.signal });

    // Save and share. The module owns the sheet, the three formats, the PNG
    // raster and the share/copy fallback; this screen owns only which picture
    // they act on and what the bar calls them.
    //
    // `current` is an accessor, not a snapshot, and that is load-bearing here in
    // a way it is not on the gallery: this screen re-encodes on every settled
    // slider drag and swaps the whole picture on every swipe, so a value
    // captured at mount would export the photograph at the size it had when you
    // arrived. `geom` and `lines` are reassigned by reencode() and by show().
    const acts = artefact({
      root,
      bottomBar: ctx.bottomBar,
      stage,
      say,
      current: () => ({ name: viewName, message, lines, geom }),
      signal: ctx.signal,
    });

    // Action bar. Leftmost is BACK, and it goes where you came from: capture
    // for one of yours, open for one of theirs.
    actionBar(ctx.bottomBar, [
      {
        label: 'BACK',
        flex: 22,
        onTap: () => { clearSubject(); ctx.navigate(mine ? 'capture' : 'paste'); },
      },
      { label: 'SAVE', flex: 28, onTap: acts.save },
      {
        label: 'SHARE',
        aria: 'Share this message',
        flex: 50,
        hero: true,
        armAfter: 250,
        onTap: acts.share,
      },
    ], { signal: ctx.signal });

    reencode();
    // Yours goes into recents too. The strip is an undo for leaving the app,
    // and leaving right after a capture is when you want it. The slot was
    // reserved before the strip was built; this fills it with the real message.
    //
    // Theirs is not added here. paste.js adds a received message when it
    // decodes, before navigating. add() de-duplicates by message so a second
    // call would only reorder, but relying on the other function being careful
    // is how the recorded contradictions in this project started.
    if (mine && message) recents.update(liveName, message);

    // The strip's second and final render of the mount, and the reason it is
    // ordered after the line above: the live slot held '\n' until then, and a
    // thumbnail cannot be painted from a placeholder. The first render's paints
    // are cancelled by this one before a frame runs them, so this costs nothing.
    strip.render({ selected: viewName });
    announceWarnings();
    render();
    refit();
  },
}));
