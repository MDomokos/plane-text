// Plane Text: capture.
//
// This screen owns state.facing and state.capture. It no longer owns styleId:
// app/stylerow.js does, and this screen mounts it. No screen writes that field,
// this one included. See stylerow.js for why it moved.
//
// ---------------------------------------------------------------------------
// THE VIEWFINDER IS LIVE AS OF 2026-08-09. What changed, and what did not.
//
// The pixels now come from app/camera.js instead of app/mock.js, and the art is
// drawn on a canvas through a glyph atlas instead of into a <pre>. Everything
// else on this screen is what it was: the style selector, the action bar, the
// shutter and its clamp, the word rotation, the readout, and the encode. The
// character and column counts still come from src/encode.js run on a real
// image, because the frame the viewfinder encodes IS a real image.
//
// Three decisions in that sentence are worth stating rather than leaving to be
// inferred from the code:
//
// 1. THE PREVIEW RUNS AT THE OUTPUT COLUMN COUNT. Spec 5.8 fixes it at 60x45;
//    SHELL.md item 10 says a 65-column grid cannot be framed with. The spec's
//    cap was a fillText limit described as a legibility one, and the atlas is
//    what removes it. WYSIWYG here covers size as well as style. The grid
//    coarsens only when frames are measured late, never by assumption.
//
// 2. THE CANVAS REPLACES THE <pre> ON THIS SCREEN ONLY. compose and paste keep
//    art.js and a real <pre>, because that is the render that proves what the
//    recipient's font will do: the advance, the line-height, the shim. That
//    proof belongs where you decide whether to send. Here it is dead weight,
//    and spec 5.1 asks for a canvas in as many words. The two renderers can
//    disagree, but only across a navigation, and both take their geometry from
//    src/sizing.js, so the disagreement is bounded to glyph rasterisation.
//
// 3. THE STILL IS NOT THE PREVIEW FRAME. The shutter takes a fresh full-
//    resolution grab and lets it measure its own tone endpoints. The preview
//    approximates; the capture is correct (spec 5.8).
//
// ---------------------------------------------------------------------------
// CHANGED 2026-08-09 by the UX review. Each of these reverses something this
// file previously argued for.
//
// A. The screen does not own its layout. It builds the shell's .app-frame and
//    fills three slots. Every picture screen used to compose its own flex
//    column, so the art's box was whatever was left after that screen's chrome,
//    and the picture jumped 45px and shrank 12% between here and the viewer.
//    See tokens.css --pt-chrome-top / --pt-chrome-bot.
//
//    The cost: the viewfinder lost about 80px, because both bands are sized to
//    the viewer. That is where the height buys least, since you are looking at
//    a live feed.
//
// B. `el.className = 'sc-capture'` is gone. It wiped .app-screen off the
//    container, making `min-height: 0` and the route's `padding: 0; overflow:
//    hidden` dead rules. paste.js and compose.js each warn against this and
//    each cited this file as the example.
//
// C. A vertical swipe on the picture cycles style. The row was a 19px target at
//    4% down the screen, in an app whose actionbar.js throws rather than ship a
//    43px slot. See app/stylegesture.js.
//
// ---------------------------------------------------------------------------
// THE IMPORT SUB-MODE IS GONE. Removed 2026-08-13, and written down here
// because this file argued for it at length.
//
// `#/capture?import=1` showed a picked photo instead of a live feed: same stage,
// same style row, same swipe, shutter reading [ USE ], driven by openStill()
// wearing the camera's interface. It existed because spec 5.1 justified the
// composer having no style picker with "style was chosen at capture", which was
// false for a library import -- the picker was on `paste` and dropped straight
// into `compose`, so an imported photo had no moment at which style could be
// chosen. The alternative was a style row on compose, which made styleId a
// two-owner field and state.js's table wrong. This file took the other one.
//
// styleId has a component owner now (app/stylerow.js), both picture screens
// mount the same row, and a picked photo goes straight to `compose` the way a
// captured one does. The sub-mode has nothing left to do.
//
// It costs spec 5.1's "style is a lens, not an export option" -- the argument
// that choosing style at capture keeps it framing rather than filtering. That
// was always in tension with the library path, where there is no framing moment
// at all. Style is changeable after the fact for shot photographs now too.
//
// ---------------------------------------------------------------------------
// NOTHING ON THIS SCREEN IS STUBBED ANY MORE. clipboardMayHavePayload() was the
// last one and it is app/pipeline.js as of 2026-08-09; see the dot refresh at
// the foot of the action bar below.

import { defineScreen } from '../screen.js';
import { register } from '../router.js';
import { currentStyle, currentCols } from '../state.js';
import { styleRow } from '../stylerow.js';
import { actionBar } from '../actionbar.js';
import { autoFit, publishArtWidth, stageArtWidth } from '../art.js';
import { currentWord, advanceWord } from '../words.js';
import { openCamera, CameraError, cameraOpenedBefore, cameraPermissionGranted } from '../camera.js';
import { photoPicker } from '../photopicker.js';
import { DEFAULT_RAMP } from '../../src/constants.js';
import { startViewfinder } from '../viewfinder.js';
import { clearAtlasCache } from '../atlas.js';
import { setSubject, clipboardMayHavePayload } from '../pipeline.js';
import { attachStyleGesture } from '../stylegesture.js';
import { settingsGear } from '../gear.js';
import { sizeSlider } from '../sizeslider.js';
import { reduced, flash } from '../motion.js';

// Per-visit resources that unmount() has to reach.
//
// The screen contract says per-visit state goes in closures inside mount(), and
// everything that can does. These two cannot: unmount() takes no arguments, and
// a MediaStream and a rAF loop are what it exists for. A track has no `signal`
// option, and a camera left streaming behind a hidden screen holds the sensor
// and the recording indicator with nothing on screen reporting it.
let live = null;

export default register(defineScreen({
  id: 'capture',
  title: 'Capture',

  async mount(el, ctx) {
    const state = ctx.state;

    // Build into a child, never onto `el`. See note B in the header.
    const root = document.createElement('div');
    root.className = 'sc-capture app-frame';
    el.append(root);

    // --- top band --------------------------------------------------------
    const top = document.createElement('div');
    top.className = 'app-chrome-top sc-top';

    const topRow = document.createElement('div');
    topRow.className = 'sc-top-row';

    // Words with a gold underline on the active one, no box. It stays at the
    // top as a readout that happens to be tappable: the swipe on the picture is
    // the primary control and this says which style you are on. Hit area is
    // 44px via ::before insets, now in app/stylerow.css.
    //
    // app/stylerow.js as of 2026-08-13, and this screen no longer writes
    // styleId. It was built inline here, with its own state.set() and its own
    // is-on bookkeeping in render(); the viewer now mounts the identical row,
    // and two screens rendering one control independently is the drift
    // README.md opens with five instances of.
    //
    // `live: true` says the tap repaints a preview rather than re-encoding a
    // still. It changes the tablist's accessible description and nothing else;
    // the repaint below is still this screen's, through the subscribe() at the
    // foot of mount(). See the flag's note in stylerow.js.
    const styleCtl = styleRow(null, ctx, {
      live: true,
      // Named out loud, because the row is at the top of the screen and a
      // change made by the gesture happens where the eye is not.
      onChange: (style) => say(style.name.toUpperCase()),
    });
    const styles = styleCtl.el;

    // The camera flip, top left, mirroring the gear top right.
    //
    // Hidden until there is something to flip to. The count comes from
    // enumerateDevices(), and it is asked AFTER the stream opens rather than
    // here: before a permission is granted the browser reports a placeholder
    // list with blank labels and, in Safari, a single generic entry whatever
    // the hardware is. Asking early would hide the button on a phone and show
    // it on a laptop with one webcam, which is both errors at once.
    //
    // Brackets rather than a glyph, like the gear and the hero, because a
    // rotate-arrows pictograph is not in the monospace stacks this app is
    // pinned to and would render as a different shape or a tofu box per
    // device. The angle brackets read as "the other way round" and are one
    // cell each.
    const flip = document.createElement('button');
    flip.type = 'button';
    flip.className = 'sc-flip';
    flip.hidden = true;
    flip.textContent = '[><]';

    // THE SETTINGS DOOR is app/gear.js as of 2026-08-13, and it carries the
    // offline dot. It was built here, and the viewer and the gallery had no way
    // into settings at all -- reaching it meant navigating back to this screen,
    // which on a cold start opens a camera.
    //
    // Appended last so the DOM order is flip, styles, gear. It is absolutely
    // positioned, so the order affects tab order only.
    topRow.append(flip, styles, settingsGear(null, ctx).el);
    top.append(topRow);

    // --- the stage -------------------------------------------------------
    // Owned by the shell (shell.css .app-stage). The box is identical here and
    // on compose.
    const stage = document.createElement('div');
    stage.className = 'app-stage sc-stage';

    // ONE CANVAS ELEMENT PER VIEWFINDER. Built through a factory for that
    // reason, and only that reason. See startSource() and the contract note at
    // the top of viewfinder.js: a canvas can never change context type, and
    // viewfinder.stop() ends by asking the driver to drop the WebGL context, so
    // an element that has carried one viewfinder cannot carry another. Handing
    // the same element to a second startViewfinder() is what made the flip
    // hang. `canvas` is therefore a `let`, and everything that touches it --
    // showNotice, hideNotice -- reads it at call time.
    function makeArtCanvas() {
      const c = document.createElement('canvas');
      c.className = 'sc-art';
      // The art is a picture, not text to be read out cell by cell. Same
      // treatment the wrapper gives it, and the same reason a canvas gets a
      // role at all: without one it is an unlabelled graphic.
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', 'Live preview');
      return c;
    }
    let canvas = makeArtCanvas();
    stage.append(canvas);

    // THE VIEWFINDER BRACKETS. Added 2026-08-13.
    //
    // Four 1px L-marks at the corners of the art box, --pt-ink-faint, 20px arms.
    // A still says the opposite by stepping back 16px inside a hairline box; see
    // .app-art.is-framed in shell.css.
    //
    // WHY THE MODE NEEDS A SIGN. The picture is pinned -- same size, same place,
    // on the viewfinder and on the viewer -- which is what --pt-chrome-top and
    // --pt-chrome-bot are for. Everything that used to distinguish the two
    // screens was the chrome, and pinning the box made the chrome more alike
    // rather than less, so the picture has to carry the state itself.
    //
    // WHY BRACKETS. It is the usual viewfinder sign and it is already this app's:
    // the hero button is [ ] and its press animation is two brackets clamping
    // (actionbar.css).
    //
    // Rejected: a pulsing REC dot, which is a second gold thing against
    // tokens.css's one-accent rule and puts motion on a viewfinder; and the hero
    // label, since nobody reads a button they are about to press.
    //
    // A SIBLING OF THE CANVAS, NOT A WRAPPER. startSource() replaces the canvas
    // element on every open and every flip -- a canvas that has held a WebGL
    // context can never hold another, which is the flip hang written out there --
    // so a wrapper would be rebuilt with it. As a sibling it is built once. Its
    // box comes from --pt-art-w and CAPTURE_ASPECT rather than from measuring the
    // canvas, which is the source stageArtWidth() publishes from, so the two
    // cannot drift.
    const frame = document.createElement('div');
    frame.className = 'sc-frame';
    // Decoration over a mode that the accessible name of the canvas already
    // states ("Live preview").
    frame.setAttribute('aria-hidden', 'true');
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      const mark = document.createElement('span');
      mark.className = `sc-frame-mark is-${corner}`;
      frame.append(mark);
    }
    stage.append(frame);

    // Shown instead of the canvas when there is no camera to show.
    const notice = document.createElement('div');
    notice.className = 'sc-notice';
    notice.hidden = true;
    stage.append(notice);

    // THE WARM-UP. Added 2026-08-09, on the owner's report that switching back
    // from the gallery leaves the screen blank until the camera has an input.
    //
    // getUserMedia takes a few hundred milliseconds on a warm permission and
    // longer after a flip, and startSource() replaces the canvas before it
    // awaits, so for that whole window the stage holds a blank element. It reads
    // as a viewfinder that is missing rather than one that is starting.
    //
    // A <pre>, NOT THE CANVAS, and this is the constraint that shapes the whole
    // feature. The canvas is about to be handed to startViewfinder(), which
    // takes a WebGL context on it -- and an element that has held a 2D context
    // can never hold a WebGL one. Painting a placeholder into it is the flip
    // hang written out at the top of startSource(), reintroduced deliberately.
    // So the placeholder is a sibling, and it is a <pre> of glyphs, which is
    // what this app renders anyway.
    //
    // Overlaid rather than swapped in. The notice hides the canvas because there
    // is not going to be a picture; here there is, in a moment, and
    // startViewfinder() has to measure a canvas that has a box. See .sc-warmup
    // in capture.css for the one position:absolute on this screen and why it is
    // contained to the stage.
    const warmup = document.createElement('pre');
    warmup.className = 'sc-warmup';
    warmup.hidden = true;
    // Decoration. It is noise standing in for a picture that has not arrived,
    // and a screen reader reading out four thousand ramp glyphs is the worst
    // possible outcome of trying to be helpful here.
    warmup.setAttribute('aria-hidden', 'true');
    stage.append(warmup);


    // --- bottom band -----------------------------------------------------
    const bottom = document.createElement('div');
    bottom.className = 'app-chrome-bot sc-bottom';

    // Secondary by construction (spec 5.2): the character count is information
    // and the slider below it is the control. It stays because it is the one
    // number that tells you whether the message is going to be enormous before
    // you take it, and because it is what tells you what the slider just did.
    //
    // It used to say "and there is no slider on this screen to act on it with",
    // which was true until the size control landed here on 2026-08-09. The
    // owner asked for both: the readout AND the slider, in this band.
    const readout = document.createElement('p');
    readout.className = 'sc-readout';

    // Reserves its row whether or not it has text, since the point of the band
    // above is that nothing moves.
    const status = document.createElement('p');
    status.className = 'app-status';
    status.setAttribute('role', 'status');

    // THE SIZE SLIDER, IN THE LIVE VIEWFINDER. Added 2026-08-09.
    //
    // The owner: "be able to edit the line count in the live viewfinder, not
    // just after the image was taken." This file's own header has argued since
    // the viewfinder went live that "WYSIWYG here covers size as well as
    // style", and the size was the one thing you could not choose while
    // looking through it -- you framed at whatever grid compose had last been
    // left on, took the shot, and only then found out it was 65 columns.
    //
    // It is app/sizeslider.js rather than a second copy of compose's control.
    // See that file's header for the two range-input rules that are invisible
    // when broken, and for the sizeChars ownership question -- the short of it
    // is that this screen does NOT write sizeChars; the component does, and it
    // is the only writer.
    //
    // The band has room and --pt-chrome-bot is NOT changing for this: it is the
    // most defended number in the codebase, every picture screen is laid out
    // against it, and capture's band was 52 of its 176 pixels. The slider takes
    // it to 100. The arithmetic is written out in app/screens/capture.css.
    //
    // Repaint policy is at onSizeInput() below, and it is the part that needed
    // measuring rather than deciding.
    //
    // Built HERE, in the middle of assembling the band, and mounted through the
    // host argument rather than appended afterwards: this is a flex column and
    // the order of these appends is the order of the rows. The readout
    // describes the picture, so the control that changes it goes under the
    // readout rather than between it and the picture. compose.js builds its
    // strip the same way and for the same reason.
    bottom.append(readout);
    sizeSlider(bottom, {
      store: state,
      onInput: onSizeInput,
      signal: ctx.signal,
    });
    bottom.append(status);

    root.append(top, stage, bottom);

    // The library picker, for the button in the camera-denied notice. It is
    // app/photopicker.js, the same module the gallery's ALBUM slot uses, so the
    // EXIF rotation and the 1600px downscale have one implementation.
    //
    // Mounted into the frame, which is a three-row grid: the input is `hidden`,
    // that is `display: none`, and a display:none child is not a grid item at
    // all, so it cannot open a fourth row.
    //
    // A picked photo goes where a captured one goes: straight to `compose`,
    // through the same pipeline subject. It used to come back through this
    // screen with `?import=1` so that style could be chosen before the viewer;
    // the viewer has the style row now. See the header.
    const picker = photoPicker(root, {
      signal: ctx.signal,
      onError: (message) => say(message, 'error'),
      onPhoto: (photo) => {
        setSubject({
          kind: 'mine',
          photo,
          word: currentWord(),
          takenAt: Date.now(),
          source: 'library',
        });
        ctx.navigate('compose');
      },
    });

    // --- state ----------------------------------------------------------
    let word = currentWord();
    let camera = null;
    let vf = null;
    let cameraError = null;

    // Frame timings are a developer's number, not a user's, so they are behind
    // a route parameter: #/capture?perf=1. Spec 5.8's whole instruction about
    // WebGL is "measure before reaching for it", and this is what measuring
    // looks like on a real handset rather than in an argument.
    const showPerf = ctx.route.params.perf === '1';

    let statusTimer = 0;
    // flash() is a 110ms fade over the line whose text has just changed. See
    // motion.js for why the existing `color` transition on .app-status was
    // animating the wrong event without it. It is called on the clear too,
    // because "FRONT CAMERA" vanishing is as much a change as it arriving.
    function say(text, kind = '') {
      status.textContent = text;
      status.classList.toggle('is-warn', kind === 'warn');
      status.classList.toggle('is-error', kind === 'error');
      flash(status);
      clearTimeout(statusTimer);
      if (text) statusTimer = setTimeout(() => { status.textContent = ''; flash(status); }, 2600);
    }
    ctx.signal.addEventListener('abort', () => clearTimeout(statusTimer), { once: true });

    // --- the warm-up ------------------------------------------------------
    //
    // A field of ramp glyphs, weighted dark, reshuffling about eight times a
    // second. Three decisions in that sentence:
    //
    //   THE CURRENT STYLE'S RAMP, so what you see while it opens is made of the
    //   same glyphs as what arrives. Halftone carries `ramp: null` -- it is a
    //   cell codec, not a ramp one -- so it falls back to the default rather
    //   than drawing blanks.
    //
    //   WEIGHTED DARK, via the square. A uniform pick over the ramp averages to
    //   mid-grey and reads as a picture of something. Squaring pushes it toward
    //   the sparse end, which reads as an absence of signal, which is what it
    //   is.
    //
    //   MOVING. A still field of static for 800ms looks like a stalled feed,
    //   which is the thing this exists to prevent. Under prefers-reduced-motion
    //   it is painted once and left, because a placeholder is not worth a
    //   vestibular cost.
    const WARM_MS = 120;
    let warmTimer = 0;

    function paintWarmup() {
      const r = stage.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      const ramp = currentStyle(state.get()).ramp || DEFAULT_RAMP;
      const glyphs = [...ramp];
      // ~64 columns across the stage at the ramp advance, which puts the cell
      // size in the same range the viewfinder will use. Nothing downstream reads
      // these numbers, so they are a look rather than a measurement.
      const cols = 64;
      const size = Math.max(4, r.width / (cols * 0.6));
      const rows = Math.max(1, Math.floor(r.height / size));
      warmup.style.fontSize = `${size}px`;
      let out = '';
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const t = Math.random() * Math.random();
          out += glyphs[Math.min(glyphs.length - 1, Math.floor(t * glyphs.length))];
        }
        if (y < rows - 1) out += '\n';
      }
      warmup.textContent = out;
    }

    function showWarmup() {
      if (!warmup.hidden) return;
      warmup.hidden = false;
      paintWarmup();
      if (reduced()) return;
      clearInterval(warmTimer);
      warmTimer = setInterval(paintWarmup, WARM_MS);
    }

    function hideWarmup() {
      clearInterval(warmTimer);
      warmTimer = 0;
      if (warmup.hidden) return;
      warmup.hidden = true;
      // Dropped rather than left in the DOM. It is a few thousand characters and
      // it is never read again; the next show repaints from scratch anyway.
      warmup.textContent = '';
    }
    ctx.signal.addEventListener('abort', hideWarmup, { once: true });

    // `onRetry` is the difference between a notice and a dead end. Passing it
    // adds a button whose click handler runs inside a real user gesture, which
    // is the context a browser trusts for getUserMedia and the one mount() by
    // definition cannot provide. Omitted for the failures where retrying is a
    // lie: see the call site.
    function showNotice(title, body, onRetry = null) {
      hideWarmup();
      canvas.hidden = true;
      // Nothing is being framed, so there is nothing to bracket.
      frame.hidden = true;
      notice.hidden = false;
      notice.textContent = '';
      const h = document.createElement('p');
      h.className = 'sc-notice-title';
      h.textContent = title;
      const p = document.createElement('p');
      p.className = 'sc-notice-body';
      p.textContent = body;
      notice.append(h, p);

      // THE LIBRARY, AS A BUTTON. Added 2026-08-09, on the owner's report: "if
      // camera permission is denied, show the album image picker button."
      //
      // Spec 8 has promised this escape hatch since before the gallery existed,
      // and what was here instead was a sentence -- "Open a photo from your
      // library instead, the button below on the left" -- pointing at the OPEN
      // slot. OPEN does not open a photo. It goes to the gallery, where ALBUM is
      // the picker. So the one instruction on the screen you reach by declining
      // the camera described a control that does something else, and the way
      // through cost two taps and a guess.
      //
      // FIRST, ABOVE ENABLE CAMERA, and that is the ranking rather than the
      // reading order. This is the action that always works. Re-requesting the
      // camera often cannot: Chrome will not re-prompt after a denial until the
      // user changes it in site settings, so ENABLE CAMERA is the button that
      // may quietly do nothing, and it is second.
      const lib = document.createElement('button');
      lib.type = 'button';
      lib.className = 'sc-notice-retry is-primary';
      lib.textContent = 'USE A PHOTO';
      lib.setAttribute('aria-label', 'Use a photo you already have');
      lib.addEventListener('click', () => picker.open(), { signal: ctx.signal });
      notice.append(lib);

      if (!onRetry) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sc-notice-retry';
      b.textContent = 'ENABLE CAMERA';
      b.addEventListener('click', async () => {
        // Disabled for the duration rather than left live. getUserMedia can sit
        // for as long as the permission sheet is on screen, and a second tap
        // behind that sheet queues a second stream request against a decision
        // the user has not made yet.
        b.disabled = true;
        b.textContent = 'ASKING…';
        try {
          await onRetry();
        } finally {
          // The notice is usually gone by now, torn down by a successful
          // start. If it is not, the button has to come back or the retry was
          // a one-shot, which is the bug this whole control exists to fix.
          if (b.isConnected) { b.disabled = false; b.textContent = 'ENABLE CAMERA'; }
        }
      }, { signal: ctx.signal });
      notice.append(b);
    }

    function hideNotice() {
      notice.hidden = true;
      notice.textContent = '';
      canvas.hidden = false;
      frame.hidden = false;
    }

    // The hero's label element, looked up once. querySelector inside a function
    // that runs twenty times a second is a DOM walk twenty times a second for
    // an element that never changes.
    let heroLabel = null;
    let lastReadout = '';
    let lastWord = '';

    function render(stats) {
      const s = state.get();

      const result = stats && stats.result;
      const chars = result ? result.stats.messageChars : s.sizeChars;
      const cols = stats && stats.cols ? stats.cols : currentCols(s);

      let text = `${chars.toLocaleString()} chars · ${cols} cols`;
      // Only once degradation has happened. An always-on frame-rate readout
      // trains the user to ignore it. Never on a still.
      if (stats && stats.degraded) text += ` · ${stats.rungLabel}`;
      if (showPerf && stats) text += ` · ${stats.meanMs.toFixed(1)}ms @${stats.fps} · ${stats.backend}`;
      // Writing identical text still dirties the node and costs the next frame
      // a layout flush when the viewfinder reads its box.
      if (text !== lastReadout) {
        readout.textContent = text;
        lastReadout = text;
      }

      // The legibility cap warns and does not clamp (2026-08-09). Note this
      // fires at the top of the slider for both codecs by construction
      // (SHELL.md disagreement 3), so it must read as advice rather than an
      // error, or the app cries wolf at its own maximum.
      readout.classList.toggle('is-warn', Boolean(result && result.warnings.length));

      if (!heroLabel) heroLabel = bar.hero.querySelector('.pt-hero-label');
      if (heroLabel && word !== lastWord) {
        heroLabel.textContent = word;
        lastWord = word;
      }
    }

    // The column count the picture on screen was last painted FOR.
    //
    // currentCols(), never the viewfinder's `shot.cols`. Those two are the same
    // number on every rung but the bottom two, where the degradation ladder
    // scales the preview grid (colScale 0.66), and comparing across them would
    // be comparing two different questions -- "what will be sent" against "what
    // is being drawn". The slider decides the first.
    let paintedCols = 0;

    // Force a frame now, outside the rAF gate, and take the readout from it.
    function repaint() {
      paintedCols = currentCols(state.get());
      const shot = vf ? vf.refresh() : null;
      render(shot ? { result: shot.result, cols: shot.cols } : null);
      return shot;
    }

    // --- the slider's repaint policy -------------------------------------
    //
    // MEASURED, because the obvious implementations are both wrong and the
    // wrong one is wrong in a way that punishes the user for dragging.
    //
    // What a range input does during a drag: one `input` event per pixel of
    // travel, which on a 390px phone at 120Hz touch sampling is a few hundred
    // events per second. Each one was, until this function existed, a
    // state.set() that woke the subscribe() handler below and called
    // vf.refresh(), which is a full encode.
    //
    // What a full encode costs, measured on this machine with src/encode.js on
    // the buffer sizes app/camera.js actually hands it (Node, desktop; a phone
    // is several times worse):
    //
    //   ramp     65 cols  130x174 buffer   3.0 ms
    //   ramp     98 cols  196x262 buffer   5.8 ms
    //   ramp    130 cols  260x346 buffer   9.9 ms
    //   braille 130 cols  260x348 buffer   7.5 ms
    //
    // And every distinct column count is a distinct fitFontSize(), so it is
    // also a distinct atlas: app/atlas.js's cache holds FOUR entries, so a drag
    // evicts and rebuilds continuously on top of the encode.
    //
    // The cheap fix that does not work: coalesce to one repaint per rAF. That
    // is 60 encodes a second on top of the viewfinder's own 20, on a screen
    // whose frame budget is 45ms and whose degradation ladder steps DOWN after
    // sustained overrun -- so a long drag would coarsen the picture, and the
    // user would have made it worse by adjusting it.
    //
    // The fix that does work is to notice how few of those events mean
    // anything. The track is 5,742 to 22,663 characters, so 16,921 one-step
    // positions, and colsForChars() maps them onto 66 distinct ramp column
    // counts. Everything the encoder produces -- cols, rows, and messageChars,
    // which is cells + rows + WRAPPER_BUDGET -- is a function of that column
    // count alone. So for ~99.6% of the values the thumb can take, re-encoding
    // is provably re-encoding for a bit-identical answer, and skipping them is
    // not an approximation.
    //
    // Net: a fast full-track drag falls from ~390 encodes to 66, a slow one
    // within a single grid to zero, and the 66 that remain repaint immediately,
    // synchronously, on the input event -- not on the next rAF and not on the
    // loop's next tick. Which is the behaviour the old subscribe() path had and
    // the reason it is worth keeping.
    //
    // The readout follows the same rule, and that is correct rather than a
    // compromise: it names the message the shutter would send, and inside one
    // grid that message does not change.
    function onSizeInput({ cols }) {
      if (cols === paintedCols) return;
      repaint();
    }

    // The frame's half of the capture animation. See the call site in commit().
    //
    // WAAPI rather than a class and a transition, for the reason motion.js gives
    // about el.animate(): this has to resolve, since commit() navigates after it,
    // and a `transitionend` on four elements is four listeners and a race over
    // which fires last. One animation on the container settles all four.
    //
    // Under reduced motion it resolves immediately and the marks go. Nothing is
    // lost: the mode difference is static -- brackets here, a hairline on the
    // viewer.
    const CLAMP_MS = 200;

    function clampFrame() {
      if (reduced() || typeof frame.animate !== 'function') {
        frame.hidden = true;
        return Promise.resolve();
      }
      // Scaled about the centre and faded. Scale rather than four separate
      // translations: the marks are at the corners of the box, so one transform
      // on the container moves all four inward along their own diagonals, which
      // is "clamping", and is one composited property.
      const anim = frame.animate(
        [
          { transform: 'translateX(-50%) scale(1)', opacity: 1 },
          { transform: 'translateX(-50%) scale(0.94)', opacity: 0 },
        ],
        { duration: CLAMP_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
      );
      return anim.finished.catch(() => {});
    }

    async function commit() {
      if (!camera || !camera.live) return;

      // encode() on the compose side fits the aspect with a focus point and
      // measures this image's own tone endpoints, not the preview's smoothed
      // ones. Spec 5.8.
      //
      // THE FRONT CAMERA'S PICTURE FLIPS HERE, AND IT IS SUPPOSED TO. Changed
      // 2026-08-09, second pass, on the repo owner's instruction to match other
      // camera apps.
      //
      // The viewfinder above is MIRRORED on the front camera, the way a phone's
      // is, so the user frames themselves in a mirror. grabStill() is NOT
      // mirrored, because a photograph is true to the lens. So the still that
      // goes into the pipeline on the next line is the left-right reverse of
      // the art that was on screen a moment ago, compose renders it that way,
      // and for a selfie with lettering in it that is a visible flip across one
      // navigation.
      //
      // It is not hidden and must not be. There is exactly one place in this
      // app that decides mirroring -- drawDown() in app/camera.js, where the
      // whole argument is written out -- and a second transform here, or on
      // compose, to make the two agree again is the mistake this note exists to
      // stop. If the flip is ever considered a bug, it is fixed there.
      const photo = camera.grabStill();
      if (!photo) return;

      // THE CLAMP IS THE CAPTURE FEEDBACK: no flash, no sound. Awaited so the
      // screen change lands after the acknowledgement.
      //
      // TWO CLAMPS AS OF 2026-08-13, and the second is the mode change.
      //
      // The hero's brackets have clamped since the bar was written, and until
      // the art box was pinned the route change did most of the confirming: the
      // picture moved 45px and shrank 12% on the way to the viewer, so something
      // visibly happened. Pinning the box removed that, and with it the last
      // thing that said the shutter had fired -- a cut to an identical picture in
      // an identical place is not feedback.
      //
      // So the frame takes the job. The four corner marks clamp inward and go,
      // and the still they hand over to is inset 16px inside a hairline
      // (.app-art.is-framed).
      //
      // In parallel with the hero's rather than after it. They are one gesture in
      // two places, and 230 + 200 sequential is long enough to feel like a wait.
      await Promise.all([bar.fire(), clampFrame()]);

      setSubject({
        kind: 'mine',
        photo,
        word,
        takenAt: Date.now(),
        source: 'shot',
      });
      // The contract's field. The pixels stay out of it; see pipeline.js.
      state.set({
        capture: {
          source: 'shot',
          width: photo.width,
          height: photo.height,
          takenAt: Date.now(),
        },
      });
      word = advanceWord();
      ctx.navigate('compose');
    }

    // --- action bar -----------------------------------------------------
    // Leftmost leaves the screen. On capture that is OPEN, a lateral move (see
    // actionbar.js). The import sub-mode has somewhere back to, so there it is
    // a real BACK.
    //
    // 24/76 is a floor: at 390px it puts the small slot on 48px, and above
    // about 80/20 it drops under the tap minimum. actionbar.js throws.
    const bar = actionBar(ctx.bottomBar, [
      {
        label: 'OPEN',
        flex: 24,
        // No `dot` here. The answer is behind a permission query and arrives
        // a task later; see refreshDot() below.
        onTap: () => ctx.navigate('paste'),
      },
      {
        label: word,
        // The label is a sound, so it is not the accessible name.
        aria: 'Capture',
        flex: 76,
        hero: true,
        onTap: commit,
      },
    ], { signal: ctx.signal });

    // --- the clipboard dot ------------------------------------------------
    //
    // The gold dot on OPEN, which says a message is already on the clipboard and
    // this slot is the way to it. Implemented 2026-08-09, having been
    // `return false` since the bar was written.
    //
    // The policy is in pipeline.js and it is most of the feature: never prompt,
    // false forever on WebKit, and no polling. What is left here is WHEN to ask,
    // and there are exactly two moments:
    //
    //   at mount, because you may have arrived with something already copied;
    //
    //   on `visibilitychange` to visible, which is the scenario itself. You
    //   switched to WhatsApp, copied a message, and came back. Without this the
    //   dot would be right only if the copy happened before the app was opened,
    //   which is the less likely half of the case it exists for.
    //
    // Not in the import sub-mode: that slot is BACK, it does not lead to the
    // gallery, and a dot on it would be pointing at nothing.
    //
    // Every path resolves rather than rejects, so there is no catch. The dot
    // either appears or it does not, and a screen must not fail over a
    // decoration -- which is also why setDot() ignores an out-of-range slot: the
    // listener below can outlive the bar if a navigation lands between the
    // event and the promise settling.
    async function refreshDot() {
      const on = await clipboardMayHavePayload();
      if (ctx.signal.aborted) return;
      bar.setDot(0, on);
    }
    refreshDot();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshDot();
    }, { signal: ctx.signal });

    // --- the source -----------------------------------------------------
    //
    // OPENED THROUGH A FUNCTION, NOT INLINE. Reworked 2026-08-09.
    //
    // This was a single `await openCamera()` at mount, and that was the whole
    // camera lifecycle: one attempt, and whatever it returned was the screen
    // for as long as you stayed on it. Two things now need a second attempt --
    // the flip control, which reopens with the other facingMode, and the retry
    // button in the failure notice -- so the open, the teardown of whatever was
    // open before it, and the two branches that follow are one function that
    // can run any number of times.
    //
    // The teardown at the top is the part that must not be forgotten. A
    // MediaStreamTrack is not tied to ctx.signal, which is exactly why
    // unmount() exists (see `live` at the top of this file), and a flip that
    // opened a second stream without stopping the first would hold both
    // cameras, keep the recording indicator lit, and on most phones fail
    // outright, since a second getUserMedia while the sensor is busy throws
    // NotReadableError -- which this screen would then report as "the camera is
    // in use by another app", naming itself.

    // From the reserved stage box, not the last painted rect, so the action
    // bar and style row stop resizing on navigation. See art.js.
    const publish = (w, h) => publishArtWidth(stageArtWidth(w, h));

    // One ResizeObserver for the life of the screen, whatever the source is.
    // autoFit() attaches an observer and a visibilitychange listener, so
    // calling it per open would stack a set per flip, and every one of them
    // would keep firing at a `vf` that had been replaced. It reads the current
    // `vf` through the closure instead.
    autoFit(stage, (w, h) => {
      publish(w, h);
      if (!vf) return;
      vf.refresh();
    }, { signal: ctx.signal });

    // Reveal the flip control once we know there is a second camera to flip to.
    //
    // enumerateDevices() only returns a truthful list once a permission has
    // been granted -- before that the labels are blank and the count is a
    // placeholder -- so this runs after a successful open and never before.
    // It is also allowed to fail silently: on a browser without the API, or one
    // that refuses the enumeration, the correct outcome is the button staying
    // hidden, which is where it started.
    async function offerFlip() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter((d) => d.kind === 'videoinput');
        if (cams.length > 1) flip.hidden = false;
      } catch { /* leave it hidden */ }
    }

    async function startSource() {
      // Whatever is running now stops first. Order matters: the viewfinder
      // reads frames off the camera, so stopping it second would leave a rAF
      // loop grabbing from a stopped track for one frame.
      //
      // The surface is read back off the viewfinder before it is dropped,
      // because it is not necessarily the element this closure last created: a
      // lost GL context is recovered inside viewfinder.js by putting a fresh
      // canvas in the old one's place, and the old one is then detached, where
      // replaceWith() below would be a silent no-op and the stage would end up
      // with two canvases or none.
      if (vf) { canvas = vf.canvas; vf.stop(); vf = null; }
      if (camera) { camera.stop(); camera = null; }
      cameraError = null;

      // A FRESH CANVAS FOR EVERY SOURCE. This is the fix for the flip hang.
      //
      // viewfinder.stop() disposes its WebGL renderer, and disposal ends with
      // WEBGL_lose_context.loseContext() so the GPU gets its context back now
      // rather than at GC time. getContext() hands back the SAME context object
      // for an element that already has one, and a context lost that way never
      // comes back -- so the second startViewfinder() on this element got a
      // dead context, failed to compile a shader, fell through to the 2D path,
      // and got null from getContext('2d'), because an element that holds a
      // WebGL context cannot also hold a 2D one. The next line threw out of the
      // constructor and out of this function's await, and the screen was left
      // with vf === null: no loop, no repaint, the last frame the dead context
      // painted still on screen. Navigating away and back "fixed" it because a
      // fresh mount builds a fresh element.
      //
      // Rebuilt unconditionally, including on the first call, where it throws
      // away the element the stage was built with. That element has never held
      // a context, so it costs one createElement; one code path is worth more
      // than saving it, and the alternative is a "has this been used yet" flag
      // whose only job is to be wrong once.
      const fresh = makeArtCanvas();
      canvas.replaceWith(fresh);
      canvas = fresh;

      // THE PLACEHOLDER, BEFORE THE AWAIT THAT COSTS THE TIME. See camera.js
      // for how the two signals are decided; what is here is when to ask.
      //
      // The synchronous one first, so the placeholder is up in the same task the
      // canvas was replaced in and there is never a blank frame. The async one
      // is a second chance for a granted permission this app has no memory of --
      // cleared storage, a private window -- and it is guarded on the state at
      // the time it resolves, because by then the camera may have arrived, the
      // notice may be up, or the screen may be gone.
      //
      if (cameraOpenedBefore()) showWarmup();
      else {
        cameraPermissionGranted().then((granted) => {
          if (!granted || ctx.signal.aborted) return;
          if (vf || cameraError || !notice.hidden) return;
          showWarmup();
        });
      }

      try {
        camera = await openCamera({ host: el, facingMode: state.get().facing });
      } catch (err) {
        cameraError = err instanceof CameraError ? err : new CameraError('failed', String(err));
      }

      // The router discards a late mount, but it cannot know about a camera
      // opened during the await, which would stream on behind a dead screen.
      // Still true here, and now also true of a flip whose await outlived the
      // navigation that interrupted it.
      if (ctx.signal.aborted) {
        if (camera) { camera.stop(); camera = null; }
        return;
      }

      live = { camera, vf };

      if (cameraError) {
        // Spec 8: declining the camera is not a dead end. The library is the
        // way through and it is one tap away on the same screen, so this is a
        // notice rather than an error state with its own layout.
        //
        // 'none' and 'unsupported' get no retry button. There is no camera and
        // no browser API respectively, and neither is a decision anyone can
        // change by tapping again -- a button that cannot work is worse than no
        // button, because it costs a tap to learn the same thing the sentence
        // above it already said.
        const retryable = cameraError.code !== 'none' && cameraError.code !== 'unsupported';
        // NEITHER SENTENCE NAMES A BUTTON ANY MORE. Both used to end "the
        // button below on the left", which is the OPEN slot, which goes to the
        // gallery rather than to a picker. The notice carries a real one now.
        const body = cameraError.code === 'denied'
          ? 'You can use a photo you already have instead.'
          : 'You can still use a photo you already have.';
        showNotice(cameraError.message, body, retryable ? startSource : null);
        render(null);
        return;
      }

      hideNotice();

      vf = startViewfinder({
        camera,
        canvas,
        stage,
        store: state,
        signal: ctx.signal,
        onStats: (stats) => {
          // The first frame is what the placeholder was covering, so this is
          // where it comes down -- not at startViewfinder(), which returns
          // before the loop has painted anything. `camera.live` is false while
          // the track still reports 0x0, which openCamera() explicitly allows
          // itself to hand back after a flip.
          if (camera && camera.live) hideWarmup();
          render(stats);
        },
      });

      // startViewfinder is allowed to swap its own surface during construction
      // -- the net in useCanvas2d() does exactly that -- so take the answer
      // from it rather than assuming `fresh` survived. showNotice() and
      // hideNotice() toggle `canvas.hidden`, and toggling it on a detached
      // element is a control that silently does nothing.
      canvas = vf.canvas;

      live = { camera, vf };

      // The stage has not resized, so the observer above will not fire on its
      // own, and a flip has to repaint from the new stream's first frame.
      const r = stage.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) publish(r.width, r.height);
      // Through repaint() rather than a bare vf.refresh(), so `paintedCols` is
      // seeded from the source that is actually on screen. Left at 0 the first
      // slider input would always be treated as a change, which is harmless,
      // but a flip or a retry mid-drag would leave it describing the previous
      // stream's grid, which is not.
      //
      // It renders on the live path too now, where the old bare refresh only
      // rendered for an import. That is one readout write on the first frame of
      // a new source instead of waiting up to 50ms for the loop's onStats, and
      // it is the difference between a flip landing with the numbers already
      // right and landing with the previous camera's.
      repaint();

      offerFlip();
    }

    await startSource();
    if (ctx.signal.aborted) return;

    // --- style, by swipe -------------------------------------------------
    // On the picture, vertical, capture only. See app/stylegesture.js.
    attachStyleGesture(stage, {
      signal: ctx.signal,
      // Through the component, not around it. The gesture decides a DIRECTION;
      // the owner of the field performs the write and names the result. This is
      // the one line that keeps "no screen writes styleId" true on the screen
      // most tempted to break it.
      onCycle: (n) => styleCtl.cycle(n),
    });

    // The loop would pick these up next frame; refresh() makes a style tap
    // repaint on the tap, and is the only thing that updates the static and
    // frozen rungs.
    //
    // sizeChars is NOT in this list any more, and that is the whole of the
    // drag-smoothness fix. It was, back when this screen only READ the field so
    // that its readout agreed with what compose would produce. Now the slider
    // in the band below writes it, so every input event during a drag would
    // arrive here and force a full encode -- see onSizeInput(), which is that
    // path, deduplicated. Leaving it here as well would be two routes to one
    // repaint, and the undeduplicated one would win.
    //
    // Nothing else writes sizeChars while this screen is mounted -- compose is
    // not mounted, and settings does not touch it -- so nothing is lost.
    state.subscribe((_s, changed) => {
      if (changed.has('styleId') || changed.has('customCharsets') || changed.has('invert')) {
        repaint();
      }
    }, { signal: ctx.signal });

    // --- flip ------------------------------------------------------------
    //
    // Writes state.facing and reopens. It does NOT go through the store's
    // subscribe() below: that handler exists to repaint the current stream when
    // a style or size changes, and a facing change is not a repaint, it is a
    // different camera. Routing it there would have a subscription tearing down
    // the source underneath whatever else the notification was for.
    //
    // Disabled across the await for the same reason the retry button is: two
    // flips in flight race each other's teardown, and the loser leaves a stream
    // open that nothing holds a reference to any more.
    function flipLabel() {
      const front = state.get().facing === 'user';
      flip.classList.toggle('is-front', front);
      // The label says what you would GET, which is the convention every phone
      // camera uses and the opposite of naming the current state.
      flip.setAttribute('aria-label', front ? 'Switch to the rear camera' : 'Switch to the front camera');
    }
    flipLabel();

    flip.addEventListener('click', async () => {
      if (flip.disabled) return;
      flip.disabled = true;
      const next = state.get().facing === 'user' ? 'environment' : 'user';
      state.set({ facing: next });
      flipLabel();

      // Said BEFORE the await, not only after it, because the await is the
      // part that takes time and the stage is blank for the whole of it. The
      // old stream's track is stopped before the new getUserMedia is even
      // issued -- it has to be, or the second request hits a busy sensor and
      // throws NotReadableError -- so there is nothing to show in between, and
      // on a phone the reacquire is comfortably long enough to read as a crash.
      //
      // Sentence case, not the uppercase the two camera names use. Uppercase in
      // this slot echoes a NAME -- the style, the camera you landed on, the same
      // convention the style gesture follows -- and this is a report on
      // progress, which is compose.js's 'Rendering PNG…' shape.
      say('Switching camera…');
      try {
        await startSource();
      } catch (err) {
        // startSource() classifies every camera failure into a notice and
        // returns, so reaching here means something else broke. Report it on
        // screen rather than as an unhandled rejection from a click handler:
        // the failure mode this whole change exists to remove is a flip that
        // leaves the screen dead and says nothing.
        console.error('capture: flip failed', err);
        say('The camera did not restart.', 'error');
        return;
      } finally {
        flip.disabled = false;
      }
      if (ctx.signal.aborted) return;
      // Named out loud, like the style gesture does. The picture changing is
      // the real feedback, but a front camera pointed at a ceiling looks a lot
      // like a rear camera that failed to start.
      //
      // `camera.live` is false when the sensor has been handed back but is not
      // producing frames yet -- see waitForFrame() in camera.js, which gives up
      // after a second and returns the camera anyway. That is not an error and
      // needs no retry: the viewfinder's loop is already running and paints the
      // first frame that arrives (see the null-frame note in its tick()). It
      // does need saying, because until then the stage is blank.
      if (camera && !camera.live) say('Waiting for the camera…');
      else say(next === 'user' ? 'FRONT CAMERA' : 'REAR CAMERA');
    }, { signal: ctx.signal });

    render(null);
  },

  // The one thing ctx.signal cannot do.
  unmount() {
    if (!live) return;
    if (live.vf) live.vf.stop();
    if (live.camera) live.camera.stop();
    // Atlases are per font size and the next visit will likely differ.
    // Holding megabytes of canvas for a hidden screen is the same leak as the
    // stream.
    clearAtlasCache();
    live = null;
  },
}));
