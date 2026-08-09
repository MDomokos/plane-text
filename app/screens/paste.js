// Plane Text: open. Route id `paste`, per the shell's v1 route table.
//
// The route is called paste and the screen is called OPEN. "Open" covers both
// doors here: a message someone sent you, and a photo you already have. SHOOT
// makes a new picture, OPEN brings in an existing one, and where it came from
// is something the screen explains rather than something the button has to say
// in 48 pixels.
//
// ---------------------------------------------------------------------------
// IT IS THE GALLERY NOW. Rewritten 2026-08-09, on the owner's report: "make the
// gallery view, and the open/create photo you already have, into one screen ...
// the gallery should have a permanent place, by default always opening the
// latest image."
//
// What it was: a scrolling form. A heading, a big paste target, a hidden
// fallback textarea, a library row, and the recents strip pinned to the bottom.
// The strip was the only place saved messages were visible, and looking at one
// meant leaving the screen. So the eight things the app had kept for you were an
// afterthought at the bottom of a form whose subject was the ninth.
//
// What it is: an .app-frame like the other two picture screens. The picture on
// top, in the same box, then the strip, then three actions. Tapping a thumbnail
// swaps the stage. On mount it opens the most recent entry, which is what the
// owner means by "by default always opening the latest image".
//
// THE BOX IS THE POINT, and it is why this file now builds .app-frame rather
// than a column of its own. tokens.css's --pt-chrome-top / --pt-chrome-bot exist
// because three screens each computing "the art's box is whatever is left after
// MY chrome" produced three different answers, and committing to a photo moved
// the picture 45px and shrank it 12%. A gallery whose pictures land somewhere
// else than the viewer's is the same bug with a third instance. This screen
// therefore fills the shell's three slots and changes neither band's height.
//
// WHAT DID NOT CHANGE, deliberately:
//
//   compose is still the viewer. A message you have just PASTED goes there, as
//   it always did, because that is where SAVE and SHARE are and a message
//   someone sent you is a thing you act on. A thumbnail you TAP is a thing you
//   are looking at again, and that stays here. Two gestures, two meanings.
//
//   The library picker still routes through capture with ?import=1. See the
//   import sub-mode note in capture.js: an imported photo has no moment at which
//   style can be chosen unless it gets a capture moment, and the alternative was
//   a style row in the viewer, which would make styleId a two-owner field.
//
//   The clipboard read is still gesture-triggered, with the textarea fallback.
//   On iOS Safari navigator.clipboard.readText() requires a user gesture and
//   shows a system paste confirmation, so a button is mandatory rather than a
//   convenience (spec 5.5). Where readText is unavailable or denied the fallback
//   is a focusable textarea, revealed only then: a software keyboard covering
//   half the screen is the wrong default for an action that is a paste.
//
// THE EMPTY STATE is the one place the big target survives, and that is the
// owner's instruction read literally: "only if there are no saved images should
// there be the large full screen paste button, along with a small explainer".
// With nothing saved there is no picture to put in the stage, so the stage holds
// the target instead. With one message saved the target is redundant -- the same
// action is a slot in the action bar, permanently -- and the two-equal-tiles
// version of this screen was already rejected in 2026-08-08's notes for having a
// paste tile beside a PASTE button doing the same thing.
//
// Why the library picker is here at all. Spec 9 puts "library picker" in the
// Out list for v1, spec 5.1 lists it in the bottom bar, and spec 8's
// camera-denied copy says "You can also pick a photo from your library". Three
// places, two answers. It is In, on two grounds:
//
//   1. Without it, declining the camera permission is a dead end. Spec 8
//      already promises the escape hatch; it did not exist.
//   2. It is probably the main source rather than the fallback. The scenario is
//      that you are on an aircraft, and the picture you want to send is usually
//      one from the trip you already took, not the wing outside the window.

import { defineScreen } from '../screen.js';
import { register } from '../router.js';
import { currentStyle } from '../state.js';
import { actionBar } from '../actionbar.js';
import { paintArt, autoFit, publishArtWidth, stageArtWidth } from '../art.js';
import { messageName, currentWord } from '../words.js';
import * as recents from '../recents.js';
import { thumbStrip } from '../thumbstrip.js';
import { artefact } from '../artefact.js';
import { decodeMessage, looksLikeMessage, setSubject, takeSharedText } from '../pipeline.js';

// Longest edge a picked photo is decoded at.
//
// The grid is at most 130 cells wide and each cell samples a block of pixels,
// so anything past ~1600 px is thrown away by downscale() a moment later. It is
// not free to keep: toLuma() allocates one Float64Array element per pixel, so a
// 12 MP photo costs 96 MB to produce a 130-column picture.
const MAX_SOURCE_PX = 1600;

// The explainer under the big target, and the only new copy on the screen.
//
// It says what the app IS rather than what is missing, because the target above
// it already says what to do ("A MESSAGE SOMEONE SENT / PASTE OR SHARE IT HERE")
// and the strip below already says what the strip is for. A third sentence
// repeating either of those would be the empty state talking to itself. Two
// short sentences, plain, in spec 8's voice: state the situation, then the way
// through it.
const EXPLAINER = 'A Plane Text message arrives as a wall of characters. Paste it here and it is a picture again.';

export default register(defineScreen({
  id: 'paste',
  title: 'Open',

  mount(el, ctx) {
    const state = ctx.state;

    // Build into a child, never onto `el` itself. See capture.js: assigning
    // el.className wipes the shell's own .app-screen class off #app-screen,
    // which on this route now costs `min-height: 0` and `overflow: hidden`.
    const root = document.createElement('div');
    root.className = 'sc-open app-frame';
    el.append(root);

    // --- top band --------------------------------------------------------
    //
    // THE NAME ALONE. Changed 2026-08-09, when the picture got a row of verbs.
    //
    // It was the shell's .app-chrome-row: a fixed 88px column for the DELETE
    // control, the name, and a second empty 88px column whose only job was to
    // keep the name centred against the first. That row exists because a control
    // whose label changes length -- DELETE becomes TAP AGAIN -- would otherwise
    // shove the name sideways in the one band whose entire purpose is that
    // nothing moves.
    //
    // DELETE is in the action row at the bottom now, beside SHARE and SAVE,
    // because it is one of the three things you can do to the picture on the
    // stage and it was the only one of the three this screen had. With it gone
    // there is nothing to balance, both gutters are dead weight, and the name
    // simply centres on the art the way .app-name already asks to.
    //
    // The viewer keeps .app-chrome-row. Its delete is still up there, because
    // its bottom band is full -- 173 of 176 -- and there is nowhere for a fourth
    // row to go. The two screens differing here is the bands differing, which is
    // the same reason their strips resolve to different sizes.
    const top = document.createElement('div');
    top.className = 'app-chrome-top';

    const label = document.createElement('p');
    label.className = 'app-name';
    top.append(label);

    // --- stage -----------------------------------------------------------
    //
    // Three things can occupy it and exactly one does at a time: the picture,
    // the empty state, or the paste fallback field. They are siblings with
    // `hidden` rather than one element whose contents are rebuilt, because the
    // <pre> is what autoFit() measures against and re-creating it would mean
    // re-attaching the observer every time the mode changed.
    const stage = document.createElement('div');
    stage.className = 'app-stage';

    const pre = document.createElement('pre');
    pre.className = 'app-art';
    pre.setAttribute('role', 'img');
    pre.hidden = true;

    // The empty state. Full-bleed, because with nothing saved there is nothing
    // else for the stage to hold and a small target in the middle of a black
    // rectangle is a worse version of the same thing.
    const empty = document.createElement('div');
    empty.className = 'sc-open-empty';

    const target = document.createElement('button');
    target.type = 'button';
    target.className = 'sc-target';
    const glyph = document.createElement('span');
    glyph.className = 'sc-target-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '[ ]';
    const lead = document.createElement('span');
    lead.className = 'sc-target-lead';
    lead.textContent = 'A MESSAGE SOMEONE SENT';
    const sub = document.createElement('span');
    sub.className = 'sc-target-sub';
    sub.textContent = 'PASTE OR SHARE IT HERE';
    target.append(glyph, lead, sub);

    const note = document.createElement('p');
    note.className = 'sc-target-note';
    note.textContent = EXPLAINER;

    empty.append(target, note);

    // The fallback field, hidden until the clipboard route fails. Revealing it
    // by default summons a keyboard nobody asked for.
    //
    // In the stage rather than in a band, and that is a change of place rather
    // than of behaviour. It is 88px of textarea plus a keyboard, which the
    // 176px bottom band cannot hold beside the strip; and what you are working
    // on when you are pasting by hand IS the text, so it belongs where the
    // thing you are working on goes.
    const field = document.createElement('textarea');
    field.className = 'sc-field';
    field.hidden = true;
    field.setAttribute('aria-label', 'Paste a Plane Text message');
    field.placeholder = 'Paste the message here';

    stage.append(pre, empty, field);

    // --- bottom band -----------------------------------------------------
    const bottom = document.createElement('div');
    bottom.className = 'app-chrome-bot';

    // ONE RESERVED ROW, TWO OCCUPANTS. Added 2026-08-09 with the action row.
    //
    // The row is --pt-tap tall and always in the layout, and exactly one of two
    // things is in it: what you can DO with the picture on the stage, or what
    // went wrong with the last paste. They are mutually exclusive in meaning as
    // well as in space -- an error about a message that did not decode is not a
    // moment at which you are deciding whether to share the picture behind it --
    // so the alternative, two rows each reserved separately, would cost 48px of
    // a band that is now spending its slack on the strip.
    //
    // WHY IT IS RESERVED RATHER THAN JUST PRESENT. The strip below fills what
    // the band has left (thumbstrip.css), so a row that appears and disappears
    // resizes every thumbnail in it. A fixed row means the strip is 102px
    // whatever is in it. A three-line error is the one case that exceeds the
    // reservation, and then the strip gives up ten pixels rather than the error
    // being clipped -- measured at 390px both of spec 8's strings wrap to two
    // lines, so it is the failure mode rather than the common case.
    const act = document.createElement('div');
    act.className = 'sc-act';

    // The verbs. SHARE and SAVE are app/artefact.js, mounted below; DELETE is
    // the thumbstrip's own control, built into the third slot, because the
    // entry it removes is the entry the strip has selected and the arming
    // belongs with the list it acts on.
    const actions = document.createElement('div');
    actions.className = 'sc-actions';

    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'sc-act-btn';
    shareBtn.textContent = 'SHARE';
    shareBtn.setAttribute('aria-label', 'Share this picture');

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'sc-act-btn';
    saveBtn.textContent = 'SAVE';

    const delSlot = document.createElement('div');
    delSlot.className = 'sc-act-slot';

    actions.append(shareBtn, saveBtn, delSlot);

    // Errors about a paste, their own element rather than folded into the
    // status line. .app-status is one ellipsised line and these run to two or
    // three, and an error you can only read half of is spec 8's whole complaint
    // about error copy.
    const problem = document.createElement('p');
    problem.className = 'sc-problem';
    problem.hidden = true;
    problem.setAttribute('role', 'status');

    act.append(actions, problem);
    bottom.append(act);

    // The strip, permanent, and the same component the viewer uses. It is built
    // here, in the middle of assembling the band, because the band is a flex
    // column and the order of these appends is the order of the rows: the strip
    // goes between the problem line and the status line, which is exactly where
    // it sits on the viewer.
    //
    // `selected` is the newest entry's name when there is one. That is what
    // makes this a tablist rather than a group and what lights the gold
    // underline, and it is also what the delete control targets.
    const first = recents.list();
    const strip = thumbStrip(bottom, {
      state: () => state.get(),
      selected: first.length ? first[0].name : null,
      // 'Show' rather than 'Open': a tap swaps the stage here now, exactly as
      // it does on the viewer. It said 'Open' when a tap navigated.
      pickVerb: 'Show',
      say,
      deleteHost: delSlot,
      // One of three equal controls in a row, not a fixed column beside a
      // centred name. See `.pt-del.is-fill` in thumbstrip.css.
      deleteFill: true,
      onPick: (_entry, i) => show(i),
      onDelete: (entry, { index }) => {
        say(`Deleted ${entry.name.split(' ')[0]}`);
        const left = strip.entries();
        // Land on the neighbour, not the top: the user's attention is where the
        // picture was. Same rule as the viewer, and the same `index`, which is
        // the slot the deleted entry occupied.
        //
        // When the last one goes there is no neighbour and no picture, so the
        // screen bounces to its empty state. The viewer navigates HERE in that
        // situation; here there is nowhere further to go, which is the other
        // half of "the gallery has a permanent place".
        if (!left.length) { showEmpty(); return; }
        show(Math.min(index, left.length - 1));
      },
      signal: ctx.signal,
    });

    const status = document.createElement('p');
    status.className = 'app-status';
    status.setAttribute('role', 'status');
    bottom.append(status);

    // The real picker. Hidden, and clicked by the action bar's middle slot, so
    // there is no styled control for it to fight with.
    //
    // A fourth child of .app-frame, which is a three-row grid. `hidden` is
    // `display: none`, and a display:none child is not a grid item at all, so
    // this cannot open an implicit fourth row.
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;

    root.append(top, stage, bottom, fileInput);

    // --- status ----------------------------------------------------------
    // Transient only. The viewer has a sticky variant for decode warnings; see
    // the stage section below for why this screen does not.
    let statusTimer = 0;
    function say(text, kind = '') {
      status.textContent = text;
      status.classList.toggle('is-warn', kind === 'warn');
      status.classList.toggle('is-error', kind === 'error');
      clearTimeout(statusTimer);
      if (text) statusTimer = setTimeout(() => { status.textContent = ''; }, 2600);
    }
    ctx.signal.addEventListener('abort', () => clearTimeout(statusTimer), { once: true });

    // --- the stage -------------------------------------------------------
    //
    // What is on it, in the three variables `draw` reads. A gallery entry is a
    // message and nothing else (recents.js: "the payload is the thumbnail"), so
    // there are no source pixels here and therefore no size slider -- the same
    // limit the viewer hits the moment you swipe off the live subject.
    //
    // Decode warnings are NOT announced here, and that is a decision rather than
    // an omission. The viewer holds them stickily because they describe a
    // picture you are about to save or send and must not time out. Browsing is
    // not deciding: a warning that reappears every time you tap along a strip of
    // eight is noise, and the screen you act on already carries it.
    //
    // There is no `at` here and no swipe. The viewer counts a swipe from the
    // slot it is on; this screen changes picture by tap only, and a variable
    // kept up to date for a gesture that does not exist is the shape of the
    // stale-index bug the viewer's onDelete had to fix.
    let lines = [];
    let geom = null;
    // What SHARE and SAVE act on. Kept beside `lines` and `geom` because they
    // are the same fact -- what is on the stage -- and artefact.js reads all
    // four through one accessor.
    let message = '';
    let viewName = '';

    function draw(w, h) {
      // From the RESERVED box, not from what was just painted. See art.js: it
      // was publishing the measured width that made the action bar resize on
      // every navigation.
      publishArtWidth(stageArtWidth(w, h));
      if (!lines.length || !geom) return;
      paintArt(pre, lines, geom, w, h);
    }

    const refit = autoFit(stage, draw, { signal: ctx.signal });

    // Save and share, which are app/artefact.js and shared with the viewer.
    // This screen contributes the accessor and two buttons; the sheet, the three
    // formats, the PNG raster and the clipboard fallback are all in there.
    //
    // The accessor is why the gallery can have these at all without a second
    // copy: what is on the stage changes on every thumbnail tap, so a value
    // captured here would export whatever was showing when the screen mounted.
    const acts = artefact({
      root,
      bottomBar: ctx.bottomBar,
      stage,
      say,
      current: () => ({ name: viewName, message, lines, geom }),
      signal: ctx.signal,
    });
    shareBtn.addEventListener('click', acts.share, { signal: ctx.signal });
    saveBtn.addEventListener('click', acts.save, { signal: ctx.signal });

    // The reserved row's two occupants, switched in one place so they cannot
    // both be on screen and cannot both be off it.
    function setProblem(text) {
      problem.textContent = text || '';
      problem.hidden = !text;
      actions.hidden = Boolean(text);
    }

    // Whether there is a picture to act on. Vacant rather than absent, for the
    // reason the row is reserved: `hidden` here would hand 44px to the strip and
    // resize every thumbnail the moment the last entry was deleted.
    function setActs(on) {
      actions.classList.toggle('is-vacant', !on);
    }

    // Exactly one of the three is visible. Passing the mode rather than
    // toggling one element at each call site is what stops a state where the
    // picture and the paste target are both on screen.
    function setMode(mode) {
      pre.hidden = mode !== 'picture';
      empty.hidden = mode !== 'empty';
      field.hidden = mode !== 'field';
    }

    // Put entry `i` on the stage.
    //
    // The list is read out of the strip rather than out of recents, so the index
    // this is handed is always an index into the thumbnails on screen. The
    // viewer can rewrite the cache between a render and a tap.
    function show(i) {
      const list = strip.entries();
      if (i < 0 || i >= list.length) return;
      const entry = list[i];
      const decoded = decodeMessage(entry.message);
      if (!decoded) { say('That picture could not be read.', 'error'); return; }

      lines = decoded.rows;
      geom = {
        // parseMessage returns codec: null when the rows mix two cell charsets
        // and the header could not settle it. The picture is still decodable,
        // so fall back rather than throwing in advanceCssFor(). A message drawn
        // badly beats a screen that cannot be drawn.
        codec: decoded.codec ?? currentStyle(state.get()).codec,
        cols: decoded.grid.cols,
        rows: decoded.grid.rows,
      };

      message = entry.message;
      viewName = entry.name;

      setMode('picture');
      setActs(true);
      pre.setAttribute('aria-label', `Photo as text: ${entry.name}`);
      label.textContent = `${entry.name} · ${entry.source || 'received'}`;
      ctx.setTitle(entry.name);
      // The one place the strip is asked to scroll: the picture just changed, so
      // the thumbnail that says which one it is has to be in sight.
      strip.select(entry.name, { scroll: true });
      refit();
    }

    function showEmpty() {
      lines = [];
      geom = null;
      message = '';
      viewName = '';
      setMode('empty');
      // Nothing on the stage, so nothing to share, save or delete. The strip's
      // own empty state says why, and thumbstrip hides its DELETE for the same
      // reason.
      setActs(false);
      // The screen's own name, since these routes have no header (shell.css).
      // Not a message name, because there is no message.
      label.textContent = 'OPEN';
      ctx.setTitle('Open');
      strip.select(null);
    }

    // --- opening a message -----------------------------------------------

    function fail(text) {
      // `text` rather than `message`: `message` is the wire string of the
      // picture on the stage now, and one of the two would have had to be the
      // shadowed one.
      setProblem(text);
    }

    // A message that has just arrived, by clipboard, by paste event or by share
    // target. It goes to the viewer, not onto this stage: it is new, and the
    // things you do with a message someone just sent you -- save it, share it
    // on, read the decode warnings -- are all there.
    function openMessage(text, name) {
      setProblem('');
      if (!looksLikeMessage(text)) {
        // Spec 8, first row. Phrased as something the user can act on, since
        // the commonest cause is a partial copy.
        fail("That doesn't look like a Plane Text image. Make sure you copied the whole message.");
        return;
      }
      const decoded = decodeMessage(text);
      if (!decoded) {
        fail('This image looks incomplete. It may have been cut off; ask the sender to try a smaller size.');
        return;
      }
      // `entryName` rather than the `label` this used to be called: `label` is
      // the name element in the top band now, and one of the two would have had
      // to be the shadowed one.
      const entryName = name || messageName(currentWord());
      recents.add({ name: entryName, message: text, source: 'received' });
      setSubject({ kind: 'theirs', message: text, name: entryName, decoded });
      ctx.navigate('compose');
    }

    async function fromClipboard() {
      // Three failure modes, one answer: reveal the textarea and let the user
      // paste by hand. No permission prompt of our own and no explanation they
      // did not ask for. The field appearing is the explanation.
      //
      // It takes the stage, which means it covers whatever picture was there.
      // That is the right trade -- the keyboard is about to cover half the
      // screen anyway -- and a tap on any thumbnail puts the picture back.
      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('unsupported');
        const text = await navigator.clipboard.readText();
        if (!text) throw new Error('empty');
        openMessage(text);
      } catch {
        setMode('field');
        // The field is over the picture, so the verbs are not about anything
        // the user can see. A tap on any thumbnail puts both back.
        setActs(false);
        field.focus();
      }
    }

    target.addEventListener('click', fromClipboard, { signal: ctx.signal });

    field.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (text) {
        e.preventDefault();
        field.value = text;
        openMessage(text);
      }
    }, { signal: ctx.signal });

    // Desktop: a paste anywhere on the screen should work without hunting for
    // the field first. Harmless on mobile, where there is no such gesture.
    el.addEventListener('paste', (e) => {
      if (e.target === field) return;
      const text = e.clipboardData?.getData('text');
      if (text) { e.preventDefault(); openMessage(text); }
    }, { signal: ctx.signal });

    // --- a photo you already have ----------------------------------------

    // Decode a picked file to the { rgba, width, height } shape the encoder
    // wants. This is the same shape the camera will hand over, so nothing
    // downstream distinguishes the two sources.
    //
    // Two options on createImageBitmap earn their place. `imageOrientation:
    // 'from-image'` applies the EXIF rotation, without which every photo taken
    // in portrait on a phone arrives sideways and gets cropped to 3:4 along the
    // wrong axis. `resizeWidth/Height` does the downscale in the decoder rather
    // than on a canvas, so a 12 MP photo never exists at full size in memory:
    // toLuma() would otherwise allocate a 12-million-element Float64Array, 96 MB,
    // to produce a grid that is at most 130 cells wide.
    async function photoFromFile(file) {
      const probe = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, MAX_SOURCE_PX / Math.max(probe.width, probe.height));
      const w = Math.max(1, Math.round(probe.width * scale));
      const h = Math.max(1, Math.round(probe.height * scale));
      probe.close?.();

      const bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image',
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'high',
      });
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      g.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      return { rgba: g.getImageData(0, 0, w, h).data, width: w, height: h };
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      // Resetting the value is what makes picking the SAME file twice fire
      // change a second time. Without it the second attempt looks like a dead
      // control.
      fileInput.value = '';
      if (!file) return;
      setProblem('');
      try {
        const photo = await photoFromFile(file);
        setSubject({
          kind: 'mine',
          photo,
          word: currentWord(),
          takenAt: Date.now(),
          source: 'library',
        });
        // Through capture, not straight to the viewer. Changed 2026-08-09 and
        // unchanged by the gallery rewrite.
        //
        // Spec 5.1 and state.js justify the composer having no style picker
        // with "style was chosen at capture". That was false for an imported
        // photo: this picker dropped the user into `compose`, so a library
        // import had no moment at which style could be chosen.
        //
        // `?import=1` puts capture into its frozen sub-mode. The alternative
        // was a style row in the viewer, which would make styleId a two-owner
        // field and the ownership table wrong.
        ctx.navigate('capture', { import: '1' });
      } catch (err) {
        // HEIC is the case worth naming: iOS shoots it by default, and Chrome
        // and Firefox cannot decode it, so createImageBitmap rejects on a file
        // the system picker was happy to offer. Safari can, which makes this a
        // browser problem rather than a phone problem.
        console.error('paste: could not read the picked image', err);
        fail('That image could not be read. HEIC photos only work in Safari — try a JPEG or PNG.');
      }
    }, { signal: ctx.signal });

    // --- action bar ------------------------------------------------------
    //
    // Three slots, and they are the owner's three: "the paste sent message, and
    // create image, and shoot buttons should be the main buttons along the
    // bottom."
    //
    // Leftmost leaves the screen, per actionbar.js, and here that is SHOOT:
    // capture is where you came from and the way out. That was this screen's
    // leftmost slot before the rewrite too.
    //
    // PASTE IS THE HERO, and PHOTO is not, for three reasons that all point the
    // same way. The route is called paste. Receiving is the expensive path the
    // app exists to shorten -- on iOS it is five taps, because Safari has no Web
    // Share Target -- while shooting and importing are both one tap from a
    // screen that is already the app's default route. And the empty state's
    // full-bleed target IS this action: when the target disappears because there
    // is now something saved, the action it carried has to survive at the same
    // weight or the screen quietly gets harder to use the more you use it.
    //
    // 30 / 30 / 40, NOT THE VIEWER'S 22 / 28 / 50. Changed 2026-08-09.
    //
    // The split was borrowed from the viewer on the grounds that two three-slot
    // bars should have one geometry. That was the wrong thing to hold constant.
    // The viewer's three are BACK, SAVE, SHARE -- a way out, a secondary, and
    // the end of a flow -- so the ramp says which one finishes the job. All
    // three of these are ENTRANCES, and 76 / 97 / 173 across the width asserts
    // that one door is more than twice as likely as another, which is a claim
    // about behaviour that nothing has measured.
    //
    // PASTE keeps the hero and the extra ten points, on three grounds that all
    // point the same way. The route is called paste. Receiving is the expensive
    // path the app exists to shorten -- five taps on iOS, because Safari has no
    // Web Share Target -- while shooting and importing are both one tap from the
    // app's default route. And the empty state's full-bleed target IS this
    // action: when it disappears because something is saved, the action it
    // carried has to survive at the same weight, or the screen gets harder to
    // use the more you use it.
    //
    // ALBUM, NOT PHOTO. Five letters each, adjacent slots, both about
    // photographs, and the only difference -- make a new one against use one you
    // already have -- was carried by nothing the eye can catch at 12px. SHOOT is
    // a verb and ALBUM is a place, which is the distinction the two slots are
    // actually making.
    //
    // At 390px that is 100 / 100 / 134 across a 342px usable width, all clear of
    // the 44px floor actionbar.js throws under.
    actionBar(ctx.bottomBar, [
      { label: 'SHOOT', flex: 30, onTap: () => ctx.navigate('capture') },
      {
        label: 'ALBUM',
        aria: 'Use a photo you already have',
        flex: 30,
        onTap: () => fileInput.click(),
      },
      {
        label: 'PASTE',
        aria: 'Paste from clipboard',
        flex: 40,
        hero: true,
        onTap: fromClipboard,
      },
    ], { signal: ctx.signal });

    // --- open on the latest ----------------------------------------------
    //
    // The owner's "by default always opening the latest image". Slot 0, because
    // recents.add() puts the newest first.
    if (strip.entries().length) show(0);
    else showEmpty();

    // A share-target launch. Consumed here rather than in main.js because the
    // decode can fail and this screen knows how to say so.
    //
    // Deferred a tick so the screen renders first: openMessage() navigates on
    // success, and the error path needs somewhere to draw if it does not.
    const incoming = takeSharedText();
    if (incoming) queueMicrotask(() => { if (!ctx.signal.aborted) openMessage(incoming); });
  },
}));
